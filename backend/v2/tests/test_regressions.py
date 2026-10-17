# -*- coding: utf-8 -*-
"""回归测试：求值缓存 key、条件 / 清单出错的提示、SQL 去注释、AI 通道等。"""
from __future__ import annotations

import copy
import json
import os
import unittest
from unittest import mock

from fastapi.responses import JSONResponse

from . import base
from backend.v2 import ai, engine, sqlsafe
from backend.v2 import router as R
from backend.v2.spec import parse_spec
from backend.v2.store import open_ro

MAIN6 = {"roles": ["主角"], "per_work": 6, "order": "heat"}


def body(resp):
    if isinstance(resp, JSONResponse):
        return resp.status_code, json.loads(resp.body.decode("utf-8"))
    return 200, resp


def two_ranges(method, label):
    return base.spec([base.one(base.rng(rank_to=1), MAIN6, id="big", share=3, label=label),
                      base.one(base.rng(year_from=2023, year_to=2023, rank_to=1), MAIN6, id="small", share=1)],
                     method=method)


class TestDrawMethodNotFromCache(unittest.TestCase):
    """求值缓存的 key 不含抽题设置，抽题方式必须用这次请求的。"""

    def expected(self, sp, seed):
        ev = engine.evaluate(parse_spec(sp), use_cache=False)
        return engine.draw(ev, seed, sp["draw"]["method"])[0]

    def test_draw_uses_request_method_even_if_cache_warm(self):
        for method in ("per_work", "range_share"):
            warm = two_ranges("per_character", "缓存" + method)
            body(R.v2_evaluate({"spec": warm}))                       # 先让 per_character 的结果进缓存
            sp = copy.deepcopy(warm)
            sp["draw"]["method"] = method
            for seed in range(1, 40):
                st, d = body(R.v2_draw({"spec": sp, "seed": seed}))
                self.assertEqual(d["char_id"], self.expected(sp, seed), (method, seed))
                self.assertEqual(d["method"], method)

    def test_range_share_distribution_through_http_path(self):
        warm = two_ranges("per_character", "分布")
        body(R.v2_evaluate({"spec": warm}))
        sp = copy.deepcopy(warm)
        sp["draw"]["method"] = "range_share"
        n_small = sum(1 for s in range(2000) if body(R.v2_draw({"spec": sp, "seed": s}))[1]["range_id"] == "small")
        self.assertTrue(abs(n_small / 2000 - 0.25) < 0.03, n_small)

    def test_draw_requires_valid_method(self):
        ev = engine.evaluate(parse_spec(two_ranges("per_work", "x")), use_cache=False)
        with self.assertRaises(ValueError):
            engine.draw(ev, 1, "weird")


class TestErrorsSurfaceAndBlockDraw(unittest.TestCase):
    """条件 / 清单出错时要让人看见，并且不许抽题。"""

    def test_condition_with_deleted_list(self):
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6, [{"type": "char_list", "list_id": "l_deleted"}])])
        st, d = body(R.v2_evaluate({"spec": sp}))
        self.assertEqual(len(d["errors"]), 1)
        self.assertTrue(any("范围 1" in w and "不存在" in w for w in d["warnings"]), d["warnings"])
        st, e = body(R.v2_draw({"spec": sp, "seed": 1}))
        self.assertEqual(st, 409)
        self.assertEqual(e["error"], "spec_has_errors")
        self.assertIn("先修好再抽题", e["message"])

    def test_exclude_with_error_blocks_draw(self):
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6)],
                       excludes=[base.one({"kind": "all_characters"}, None,
                                          [{"type": "char_list", "list_id": "l_deleted"}])])
        st, d = body(R.v2_evaluate({"spec": sp}))
        self.assertEqual(d["errors"][0]["where"], "exclude")
        self.assertEqual(body(R.v2_draw({"spec": sp, "seed": 1}))[0], 409)

    def test_bad_sql_condition(self):
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6, [{"type": "sql", "sql": "SELEC 1"}])])
        st, d = body(R.v2_evaluate({"spec": sp}))
        self.assertTrue(d["errors"])
        self.assertEqual(body(R.v2_draw({"spec": sp, "seed": 1}))[0], 409)

    def test_disabled_broken_range_does_not_block(self):
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6),
                        base.one({"kind": "char_list", "list_id": "l_deleted"}, enabled=False)])
        st, d = body(R.v2_evaluate({"spec": sp}))
        self.assertEqual(d["errors"], [])
        self.assertEqual(body(R.v2_draw({"spec": sp, "seed": 1}))[0], 200)


class TestSqlLexer(unittest.TestCase):
    """去注释时要认得字符串，不能被「-- /*」换行「VACUUM … '…*/」骗过。"""

    def q(self, sql):
        conn = open_ro(base.DB)
        try:
            return sqlsafe.run_query(conn, sql)
        finally:
            conn.close()

    def test_comment_string_trick_rejected(self):
        out = os.path.join(base.TMP, "evil.db")
        payload = "-- /*\nVACUUM INTO 'file:" + out + "?a=*/\nSELECT 1'"
        with self.assertRaises(sqlsafe.SqlError):
            self.q(payload)
        payload2 = "/* x */ -- /*\nVaCuUm INTO '" + out + "'"
        with self.assertRaises(sqlsafe.SqlError):
            self.q(payload2)
        self.assertFalse(os.path.exists(out))

    def test_strings_with_comment_markers_still_work(self):
        r = self.q("SELECT '-- 不是注释' AS a, '/* 也不是 */' AS b")
        self.assertEqual(r["rows"][0], ["-- 不是注释", "/* 也不是 */"])
        r = self.q("/* 开头注释 */ -- 行注释\nSELECT 'it''s' AS s")
        self.assertEqual(r["rows"], [["it's"]])

    def test_lead_keyword_after_string_aware_strip(self):
        with self.assertRaises(sqlsafe.SqlError):
            self.q("-- SELECT\nDELETE FROM character")


class TestAiChannelRecheck(unittest.TestCase):
    """每次起子进程前都复查通道；子进程环境里没有 codex 的 API key。"""

    def test_run_engine_rechecks_channel(self):
        # claude 走预热池：开进程之前（WarmProc）照样先查通道
        with mock.patch.object(ai, "check_claude_channel", lambda *a, **k: (False, "切到了按量计费")), \
                mock.patch.object(ai.aipool, "WarmProc", side_effect=AssertionError("不该起子进程")):
            with self.assertRaises(ai.AIError) as cm:
                ai.run_engine("claude", "fill", "s", "u", 5, ai.AiJob("fill"))
            self.assertEqual(cm.exception.code, "channel")
        with mock.patch.object(ai, "check_codex_channel", lambda: (False, "API key 登录")), \
                mock.patch.object(ai, "_run_codex", side_effect=AssertionError("不该起子进程")):
            with self.assertRaises(ai.AIError):
                ai.run_engine("codex", "fill", "s", "u", 5, ai.AiJob("fill"))

    def test_codex_keys_scrubbed(self):
        with mock.patch.dict(os.environ, {"CODEX_API_KEY": "sk-x", "CODEX_ACCESS_TOKEN": "t"}):
            env = ai.child_env()
        self.assertNotIn("CODEX_API_KEY", env)
        self.assertNotIn("CODEX_ACCESS_TOKEN", env)


# ======================================================== 自动点击：方案出错时不启动、不出题 / 标签清单错误
class FakeAC:
    def __init__(self):
        self.started = None
        self.logs = []

    def start_auto(self, mode, provider, provider_name):
        self.started = (mode, provider, provider_name)
        return "auto_started"

    def log(self, level, msg):
        self.logs.append((level, msg))

    async def status_async(self):
        return {"state": "idle"}


def start_auto(sp, fake):
    import asyncio
    import sys
    import types
    import backend
    mod = types.ModuleType("backend.app")
    mod.AC = fake
    with mock.patch.dict(sys.modules, {"backend.app": mod}), mock.patch.object(backend, "app", mod, create=True):
        return asyncio.run(R.v2_autoclick_auto_start({"mode": "host", "spec": sp}))


class TestAutoclickDrawFailure(unittest.TestCase):
    """自动点击：方案出错 / 题库为空时不启动；运行中出错时 provider 返回 None，这一轮点击器不出题。"""

    def test_refuse_to_start_on_errors(self):
        fake = FakeAC()
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6, [{"type": "char_list", "list_id": "l_deleted"}])])
        res = start_auto(sp, fake)
        self.assertFalse(res["ok"])
        self.assertIn("先修好再开自动", res["error"])
        self.assertIsNone(fake.started)

    def test_refuse_to_start_on_empty_pool(self):
        fake = FakeAC()
        res = start_auto(base.spec([base.one(base.rng(year_from=2025, year_to=2025), MAIN6)]), fake)
        self.assertFalse(res["ok"])
        self.assertIn("题库是空的", res["error"])
        self.assertIsNone(fake.started)

    def test_provider_returns_none_when_list_deleted_mid_run(self):
        from backend.v2.storage import LISTS
        LISTS.save({"name": "临时", "kind": "character", "items": [{"id": 1}, {"id": 2}]}, list_id="l_tmp_auto")
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6, [{"type": "char_list", "list_id": "l_tmp_auto"}])])
        fake = FakeAC()
        res = start_auto(sp, fake)
        self.assertTrue(res["ok"], res)
        provider = fake.started[1]
        self.assertIn(provider()[0], {1, 2})
        LISTS.delete("l_tmp_auto")
        for _ in range(3):
            self.assertEqual(provider(), (None, "", None))            # 不抛异常
        warns = [m for lv, m in fake.logs if lv == "warn"]
        self.assertEqual(len(warns), 1)                                # 同一句只记一次
        self.assertIn("这一轮不出题", warns[0])


class TestTagListErrors(unittest.TestCase):
    """标签清单被删 / 种类不对：和角色清单、作品清单一样算错误，抽题被拒。"""

    def check(self, sp):
        st, d = body(R.v2_evaluate({"spec": sp}))
        self.assertEqual(st, 200)
        self.assertTrue(d["errors"], d)
        self.assertEqual(body(R.v2_draw({"spec": sp, "seed": 1}))[0], 409)
        return d

    def test_all_positions(self):
        gone = {"quant": "all", "tags": [], "tag_list_id": "l_gone_tags"}
        self.check(base.spec([base.one(base.rng(rank_to=2), MAIN6, [{"type": "game_tags", **gone}])]))
        self.check(base.spec([base.one(base.rng(rank_to=2), MAIN6, [{"type": "char_tags", **gone}])]))
        d = self.check(base.spec([base.one(base.rng(rank_to=2, work_filter=gone), MAIN6)]))
        self.assertIn("作品本身的标签", d["ranges"][0]["error"])
        self.check(base.spec([base.one(base.rng(rank_to=2), MAIN6,
                                       [{"type": "appearance", "work_tags": gone, "roles": ["主角"]}])]))
        self.check(base.spec([base.one(base.rng(rank_to=2), MAIN6)],
                             excludes=[base.one({"kind": "all_characters"}, None,
                                                [{"type": "char_tags", "quant": "none", "tags": [], "tag_list_id": "l_gone_tags"}])]))

    def test_wrong_kind_list_as_tag_list(self):
        self.check(base.spec([base.one(base.rng(rank_to=2), MAIN6,
                                       [{"type": "game_tags", "quant": "any", "tags": [], "tag_list_id": "l_c"}])]))


class TestSqlConditionFirstColumn(unittest.TestCase):
    def test_non_id_first_column_is_error(self):
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6,
                                 [{"type": "sql", "sql": "SELECT display_name FROM character WHERE gender = '女'"}])])
        st, d = body(R.v2_evaluate({"spec": sp}))
        self.assertTrue(d["errors"])
        self.assertIn("第一列不是角色 id", d["errors"][0]["message"])

    def test_partial_bad_rows_warn(self):
        sql = "SELECT id FROM character WHERE heat >= 400 UNION ALL SELECT 'abc'"
        sp = base.spec([base.one(base.rng(rank_to=2), MAIN6, [{"type": "sql", "sql": sql}])])
        st, d = body(R.v2_evaluate({"spec": sp}))
        self.assertEqual(d["errors"], [])
        self.assertTrue(any("第一列不是整数" in w for w in d["warnings"]), d["warnings"])
        self.assertEqual(d["total"], 2)                                  # c1(500)、c5(800) 在前 2 部的主角里

    def test_digit_strings_not_ids(self):
        conn = open_ro(base.DB)
        try:
            ids, n, bad = sqlsafe.run_ids_checked(conn, "SELECT '1' UNION ALL SELECT 5")
        finally:
            conn.close()
        self.assertEqual((ids, n, bad), ({5}, 2, 1))


if __name__ == "__main__":
    unittest.main()
