# -*- coding: utf-8 -*-
"""接口层：直接调用 router 里的处理函数，不经过 HTTP。"""
from __future__ import annotations

import json
import os
import unittest
from unittest import mock

from fastapi.responses import JSONResponse

from . import base
from backend.v2 import router as R
from backend.v2.spec import default_spec


def body(resp):
    if isinstance(resp, JSONResponse):
        return resp.status_code, json.loads(resp.body.decode("utf-8"))
    return 200, resp


class TestEvaluateEtc(unittest.TestCase):
    def test_evaluate(self):
        st, d = body(R.v2_evaluate({"spec": base.spec([base.one(base.rng(rank_to=2))])}))
        self.assertEqual(st, 200)
        self.assertEqual(d["total"], 9)          # 默认每部不限：101 的 7 个主角 + 102 的 2 个
        for k in ("ranges", "excludes", "warnings", "elapsed_ms", "spec"):
            self.assertIn(k, d)
        r = d["ranges"][0]
        for k in ("id", "sentence", "works", "picked", "steps", "final", "unique", "error"):
            self.assertIn(k, r)
        # 缺字段补默认值：生成的 id 带回给前端
        self.assertTrue(d["spec"]["ranges"][0]["id"].startswith("r_"))

    def test_evaluate_bad_spec_chinese_422(self):
        st, d = body(R.v2_evaluate({"spec": {"game": {"tag_count": 11}}}))
        self.assertEqual(st, 422)
        self.assertEqual(d["error"], "bad_spec")
        self.assertIn("标签数", d["message"])

    def test_candidates(self):
        sp = base.spec([base.one(base.rng(rank_to=2))])
        st, d = body(R.v2_candidates({"spec": sp, "page": 1, "page_size": 3, "sort": "heat"}))
        self.assertEqual((d["total"], d["page"], d["page_size"]), (9, 1, 3))
        self.assertEqual([it["char_id"] for it in d["items"]], [5, 1, 2])
        st, d2 = body(R.v2_candidates({"spec": sp, "page": 3, "page_size": 3}))
        self.assertEqual(len(d2["items"]), 3)
        st, d4 = body(R.v2_candidates({"spec": sp, "page": 4, "page_size": 3}))
        self.assertEqual(d4["items"], [])
        st, d3 = body(R.v2_candidates({"spec": sp, "q": "角色一", "page": 1, "page_size": 10}))
        self.assertEqual([it["char_id"] for it in d3["items"]], [1])

    def test_draw(self):
        sp = base.spec([base.one(base.rng(rank_to=2))])
        st, a = body(R.v2_draw({"spec": sp, "seed": 42}))
        st, b = body(R.v2_draw({"spec": sp, "seed": 42}))
        self.assertEqual(a["char_id"], b["char_id"])
        self.assertEqual(a["seed"], 42)
        self.assertEqual(a["pool_total"], 9)
        self.assertEqual(a["mode"], "char-weight")
        for k in ("range_id", "bound_work", "grid", "character", "appearances"):
            self.assertIn(k, a)
        st, e = body(R.v2_draw({"spec": base.spec([base.one(base.rng(year_from=2025, year_to=2025))]), "seed": 1}))
        self.assertIsNone(e["char_id"])
        self.assertEqual(e["pool_total"], 0)
        # spec.draw.seed 也能用
        sp2 = dict(sp)
        sp2["draw"] = {"method": "per_character", "seed": 42}
        st, c = body(R.v2_draw({"spec": sp2}))
        self.assertEqual(c["char_id"], a["char_id"])

    def test_stats(self):
        st, d = body(R.v2_stats({"spec": base.spec([base.one(base.rng(rank_to=2))])}))
        self.assertEqual(d["total"], 9)
        self.assertIn("by_year", d)

    def test_character(self):
        st, d = body(R.v2_character(5, mode="anime", n=6))
        self.assertEqual(st, 200)
        self.assertEqual(d["grid"]["tags"], ["战斗", "日常", "百合"])
        self.assertEqual({a["subject_id"] for a in d["appearances"]}, {102, 103})
        self.assertEqual(d["vas"], ["声优A", "声优C"])
        self.assertEqual(d["char_tags"], ["黑长直", "双马尾"])
        st, _ = body(R.v2_character(999, mode="anime", n=6))
        self.assertEqual(st, 404)
        st, _ = body(R.v2_character(5, mode="nope", n=6))
        self.assertEqual(st, 422)

    def test_suggest(self):
        st, d = body(R.v2_suggest(kind="game_tag", q="百", mode="anime", limit=5, n=6))
        self.assertEqual(d[0]["value"], "百合")
        st, d = body(R.v2_suggest(kind="work", q="战斗", mode="anime", limit=5, n=6))
        self.assertEqual(d[0]["id"], 102)
        st, d = body(R.v2_suggest(kind="character", q="角色十", mode="anime", limit=10, n=6))
        self.assertEqual(d[0]["id"], 10)                                  # 热度 400 排在「角色十一」到「十七」前面
        st, d = body(R.v2_suggest(kind="meta_tag", q="gal", mode="anime", limit=5, n=6))
        self.assertEqual(d[0]["value"], "Galgame")
        st, d = body(R.v2_suggest(kind="va", q="声优", mode="anime", limit=5, n=6))
        self.assertEqual(d[0]["value"], "声优A")
        st, d = body(R.v2_suggest(kind="char_tag", q="", mode="anime", limit=5, n=6))
        self.assertEqual({x["value"] for x in d}, {"黑长直", "双马尾"})
        st, d = body(R.v2_suggest(kind="work_tag", q="日", mode="anime", limit=5, n=6))
        self.assertEqual(d[0]["value"], "日常")


class TestListsPlans(unittest.TestCase):
    def test_lists_crud(self):
        st, d = body(R.v2_list_create({"name": "临时角色", "kind": "character", "items": ["角色二", "不存在的人", 5]}))
        self.assertEqual(st, 200)
        lid = d["id"]
        self.assertEqual(d["resolve_report"]["unresolved"], ["不存在的人"])
        self.assertEqual([it.get("id") for it in d["items"]], [2, None, 5])
        st, g = body(R.v2_list_get(lid))
        self.assertEqual(g["name"], "临时角色")
        st, u = body(R.v2_list_put(lid, {"name": "改名了", "items": [{"id": 1}]}))
        self.assertEqual((u["name"], u["kind"], u["items"][0]["name"]), ("改名了", "character", "角色一"))
        st, _ = body(R.v2_list_create({"id": lid, "name": "重复", "kind": "tag"}))
        self.assertEqual(st, 409)
        self.assertTrue(any(x["id"] == lid for x in body(R.v2_lists())[1]))
        st, _ = body(R.v2_list_delete(lid))
        self.assertEqual(st, 200)
        st, _ = body(R.v2_list_get(lid))
        self.assertEqual(st, 404)
        st, e = body(R.v2_list_create({"name": "x", "kind": "weird"}))
        self.assertEqual(st, 400)
        st, e = body(R.v2_list_get("../../etc"))
        self.assertEqual(st, 404)

    def test_plans_crud(self):
        sp = default_spec()
        sp["meta"] = {"note": "测试"}
        st, d = body(R.v2_plan_save("我的方案", sp))
        self.assertEqual(st, 200)
        self.assertEqual(d["meta"]["name"], "我的方案")
        created = d["meta"]["created"]
        st, d2 = body(R.v2_plan_save("我的方案", {"spec": sp}))
        self.assertEqual(d2["meta"]["created"], created)
        st, g = body(R.v2_plan_get("我的方案"))
        self.assertEqual(g["version"], 2)
        self.assertTrue(any(p["name"] == "我的方案" for p in body(R.v2_plans())[1]))
        st, _ = body(R.v2_plan_delete("我的方案"))
        self.assertEqual(st, 200)
        st, _ = body(R.v2_plan_get("我的方案"))
        self.assertEqual(st, 404)
        for bad in ("../x", "a/b", "CON", ".hidden", ""):
            st, e = body(R.v2_plan_save(bad, sp))
            self.assertEqual(st, 400, bad)
        st, e = body(R.v2_plan_save("坏方案", {"game": {"mode": "xx"}}))
        self.assertEqual(st, 422)


class TestSqlEndpoints(unittest.TestCase):
    def test_sql(self):
        st, d = body(R.v2_sql({"sql": "SELECT COUNT(*) FROM character"}))
        self.assertEqual(d["rows"], [[17]])
        st, e = body(R.v2_sql({"sql": "DELETE FROM character"}))
        self.assertEqual(st, 400)
        self.assertEqual(e["error"], "sql")

    def test_schema(self):
        st, d = body(R.v2_sql_schema())
        names = {t["name"] for t in d["tables"]}
        for t in ("subject", "character", "profile_tag", "game_tag_n6", "user_list", "user_list_item"):
            self.assertIn(t, names)
        subj = next(t for t in d["tables"] if t["name"] == "subject")
        self.assertTrue(all(c["note"] for c in subj["columns"]))
        self.assertTrue(d["examples"])


class TestMetaAndNoDb(unittest.TestCase):
    def test_meta(self):
        st, d = body(R.v2_meta())
        self.assertEqual(d["db"]["dump_name"], "synthetic")
        self.assertEqual(d["tag_count_range"], [0, 10])
        self.assertEqual([m["id"] for m in d["modes"]], ["anime", "game", "book", "real", "all"])
        self.assertEqual(d["default_spec"]["ranges"][0]["source"]["rank_to"], 50)

    def test_no_db(self):
        with mock.patch.dict(os.environ, {"OUTSETTER_V2_DB": os.path.join(base.TMP, "missing.sqlite")}):
            st, d = body(R.v2_meta())
            self.assertIsNone(d["db"])
            self.assertIn("还没有出题器数据库", d["db_error"])
            st, e = body(R.v2_evaluate({"spec": {}}))
            self.assertEqual(st, 503)
            self.assertEqual(e["error"], "no_db")
        st, d = body(R.v2_evaluate({"spec": {}}))                    # 库回来了照常能用
        self.assertEqual(st, 200)

    def test_reload_on_mtime_change(self):
        import shutil
        import time
        from backend.v2.store import HUB
        from . import synth
        copy = os.path.join(base.TMP, "copy.sqlite")
        shutil.copyfile(base.DB, copy)
        with mock.patch.dict(os.environ, {"OUTSETTER_V2_DB": copy}):
            s1 = HUB.current()
            time.sleep(0.05)
            import sqlite3
            c = sqlite3.connect(copy)
            c.execute("UPDATE character SET heat = 12345 WHERE id = 7")
            c.commit()
            c.close()
            os.utime(copy, None)
            s2 = HUB.current()
            self.assertIsNot(s1, s2)
            self.assertEqual(s2.C[7][2], 12345)
        HUB.current()


if __name__ == "__main__":
    unittest.main()


class TestAutoclick(unittest.TestCase):
    def test_provider_draws_from_spec(self):
        import asyncio
        import sys
        import types
        captured = {}

        class FakeAC:
            def start_auto(self, mode, provider, provider_name):
                captured.update(mode=mode, provider=provider, name=provider_name)
                return "auto_started"

            async def status_async(self):
                return {"state": "idle"}

        fake = types.ModuleType("backend.app")
        fake.AC = FakeAC()
        sp = base.spec([base.one(base.rng(rank_to=2))])
        sp["draw"]["seed"] = 5
        with mock.patch.dict(sys.modules, {"backend.app": fake}):
            import backend
            with mock.patch.object(backend, "app", fake, create=True):
                res = asyncio.run(R.v2_autoclick_auto_start({"mode": "host", "spec": sp}))
        self.assertTrue(res["ok"], res)
        self.assertEqual((captured["mode"], captured["name"]), ("host", "spec"))
        pool = {1, 2, 13, 14, 15, 16, 17, 5, 4}
        seen = set()
        for _ in range(30):
            cid, name, hint = captured["provider"]()
            self.assertIn(cid, pool)
            self.assertTrue(name.startswith("角色"))
            seen.add(cid)
        self.assertGreater(len(seen), 3)                                  # 每轮换 seed，不会老抽同一个

    def test_bad_spec(self):
        import asyncio
        res = asyncio.run(R.v2_autoclick_auto_start({"spec": {"game": {"mode": "xx"}}}))
        self.assertEqual(res.status_code, 422)


class TestHasAnime(unittest.TestCase):
    """has_anime = 动画模式画像 fallback = 0 且 n_app > 0（和当前模式无关）；候选 / 抽题 / 角色详情都带。"""
    # 合成库：c1–c6、c8、c12–c17 有动画画像；c7 没有画像行；c9 n_app = 0；c10 / c11 fallback = 1
    EXPECT = {1: True, 5: True, 7: False, 9: False, 10: False, 11: False, 12: True, 999: False}

    def test_snapshot_both_paths(self):
        from backend.v2.store import HUB
        snap = HUB.current()
        HUB.mode(snap, "anime")                                   # 内存路径（动画模式已读）
        self.assertEqual(snap.has_anime(self.EXPECT.keys()), self.EXPECT)
        with mock.patch.dict(snap._modes, {}, clear=True):        # SQL 路径（动画模式还没读：不应该为此去读）
            self.assertEqual(snap.has_anime(self.EXPECT.keys()), self.EXPECT)
            self.assertNotIn("anime", snap._modes)
        self.assertEqual(snap.has_anime([]), {})

    def test_endpoints(self):
        sp = base.spec([base.one(base.rng(rank_to=2))])
        st, d = body(R.v2_candidates({"spec": sp, "page": 1, "page_size": 20}))
        self.assertTrue(d["items"])
        for it in d["items"]:
            self.assertIs(it["has_anime"], True)
            self.assertIs(it["character"]["has_anime"], True)
        # 游戏模式里抽到的人，has_anime 仍按动画模式算
        g = base.spec([base.one(base.rng(subject_types=[4], year_from=None, year_to=None, rank_to=None))], mode="game")
        st, d = body(R.v2_candidates({"spec": g, "page": 1, "page_size": 20}))
        got = {it["char_id"]: it["has_anime"] for it in d["items"]}
        for cid, v in got.items():
            self.assertEqual(v, self.EXPECT.get(cid, v), cid)
        st, a = body(R.v2_draw({"spec": sp, "seed": 7}))
        self.assertIs(a["has_anime"], True)
        self.assertIs(a["character"]["has_anime"], True)
        st, c5 = body(R.v2_character(5, mode="game", n=6))
        self.assertIs(c5["has_anime"], True)
        self.assertIs(c5["character"]["has_anime"], True)
        st, c10 = body(R.v2_character(10, mode="anime", n=6))
        self.assertIs(c10["has_anime"], False)
        st, c9 = body(R.v2_character(9, mode="anime", n=6))
        self.assertIs(c9["character"]["has_anime"], False)
