# -*- coding: utf-8 -*-
"""AI 的解析、JSON Patch、标签自动替换 / tag_fixes、每次请求只调一次 AI、问数据的输出格式和「让 AI 改」、SSE、通道检查
——全部用假的 AI 函数，不调真 AI（预热池的子进程逻辑见 test_aipool.py）。"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import unittest
from unittest import mock

from . import base  # noqa: F401  （设置合成库环境变量）
from backend.v2 import ai, jsonpatch
from backend.v2.spec import default_spec, parse_spec, spec_to_dict


def spec_2024(tags, quant="any", **range_kw):
    d = default_spec()
    d["ranges"][0]["source"].update(year_from=2024, year_to=2024)
    d["ranges"][0]["conditions"] = [{"id": "c_ai1", "type": "game_tags", "quant": quant, "tags": tags}]
    d["ranges"][0].update(range_kw)
    return d


def patch_2024(tags, quant="any"):
    """对默认方案的修改：年份改成 2024、加一个作品标签条件。"""
    return [{"op": "replace", "path": "/ranges/0/source/year_from", "value": 2024},
            {"op": "replace", "path": "/ranges/0/source/year_to", "value": 2024},
            {"op": "add", "path": "/ranges/0/conditions/-", "value": {"type": "game_tags", "quant": quant, "tags": tags}}]


class FakeRunner:
    """按顺序返回预设的输出，并记下每次收到的提示词。签名和 ai.RUNNER 一样：(engine, kind, system, user, timeout, job)。"""

    def __init__(self, outputs, stream=False):
        self.outputs = list(outputs)
        self.calls = []
        self.stream = stream

    def __call__(self, engine_id, kind, system, user, timeout, job):
        self.calls.append({"engine": engine_id, "kind": kind, "system": system, "user": user})
        if not self.outputs:
            raise AssertionError("假 AI 被多调用了一次（每次请求只许调一次 AI）")
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
        if self.stream:                                   # 模拟边写边推
            for i in range(0, len(text), 7):
                job.delta(text[i:i + 7])
        return text


class AITestBase(unittest.TestCase):
    def use(self, outputs, stream=False):
        fr = FakeRunner(outputs, stream=stream)
        p = mock.patch.object(ai, "RUNNER", fr)
        p.start()
        self.addCleanup(p.stop)
        return fr


class TestExtractJson(unittest.TestCase):
    def test_variants(self):
        self.assertEqual(ai.extract_json('{"a": 1}'), {"a": 1})
        self.assertEqual(ai.extract_json('好的：\n```json\n{"a": {"b": "}"}}\n```\n以上'), {"a": {"b": "}"}})
        self.assertEqual(ai.extract_json('前面有废话 {"x": [1, 2]} 后面也有'), {"x": [1, 2]})
        for bad in ("", "我不知道", "[1, 2]", "{不是 json}"):
            with self.assertRaises(ai.AIError):
                ai.extract_json(bad)


# ================================================================ JSON Patch
class TestJsonPatch(unittest.TestCase):
    DOC = {"game": {"mode": "anime", "tag_count": 6},
           "ranges": [{"id": "r1", "source": {"year_from": 2016, "work_filter": None}, "conditions": [{"id": "a"}, {"id": "b"}]}]}

    OPS = [
        {"op": "replace", "path": "/ranges/0/source/year_from", "value": 2024},
        {"op": "add", "path": "/ranges/0/conditions/-", "value": {"id": "c"}},
        {"op": "add", "path": "/ranges/0/conditions/0", "value": {"id": "z"}},
        {"op": "remove", "path": "/ranges/0/conditions/2"},
        {"op": "replace", "path": "/ranges/0/source/work_filter", "value": {"tags": ["战斗"]}},
        {"op": "add", "path": "/game/new_key", "value": 1},
    ]

    def test_ops(self):
        # 按 RFC（每条修改按顺序生效，下标跟着变）：[a,b] → +c → z 插到最前 → 删现在的第 3 个（b）
        d = jsonpatch.apply_patch(self.DOC, self.OPS, original_indices=False)
        self.assertEqual(d["ranges"][0]["source"], {"year_from": 2024, "work_filter": {"tags": ["战斗"]}})
        self.assertEqual([c["id"] for c in d["ranges"][0]["conditions"]], ["z", "a", "c"])
        self.assertEqual(d["game"]["new_key"], 1)
        self.assertEqual(self.DOC["ranges"][0]["source"]["year_from"], 2016)          # 原文档不动
        # 默认（下标按修改之前算）：原来只有 2 项，下标 2 = 加在末尾的 c
        d = jsonpatch.apply_patch(self.DOC, self.OPS)
        self.assertEqual([c["id"] for c in d["ranges"][0]["conditions"]], ["z", "a", "b"])

    def test_lenient(self):
        d = jsonpatch.apply_patch(self.DOC, {"op": "Replace", "path": "/game/mode", "value": "game"})   # 单条、大写
        self.assertEqual(d["game"]["mode"], "game")
        with self.assertRaises(jsonpatch.PatchError) as cm:                 # replace 不存在的键：报错（和 RFC 一样）
            jsonpatch.apply_patch(self.DOC, {"op": "replace", "path": "/game/brand_new", "value": 3})
        self.assertIn("字段名是不是写错了", cm.exception.message)
        self.assertEqual(jsonpatch.apply_patch(self.DOC, [{"op": "replace", "path": "", "value": {"x": 1}}]), {"x": 1})
        self.assertEqual(jsonpatch.apply_patch({"a/b": 1, "m~n": 2}, [{"op": "remove", "path": "/a~1b"},
                                                                      {"op": "remove", "path": "/m~0n"}]), {})

    def test_errors_are_chinese_and_numbered(self):
        cases = [
            ([{"op": "replace", "path": "/ranges/3/source", "value": 1}], "超出了范围"),
            ([{"op": "replace", "path": "/ranges/x/source", "value": 1}], "不是数组下标"),
            ([{"op": "remove", "path": "/game/nope"}], "本来就不存在"),
            ([{"op": "add", "path": "/nope/deeper", "value": 1}], "不存在"),
            ([{"op": "move", "from": "/a", "path": "/b"}], "不认识的操作"),
            ([{"op": "replace", "path": "/game/mode"}], "缺少 value"),
            ([{"op": "replace", "path": "game/mode", "value": 1}], "要以 / 开头"),
            ([{"op": "remove", "path": ""}], "不能删掉整份方案"),
            ("不是数组", "必须是数组"),
        ]
        for ops, msg in cases:
            with self.assertRaises(jsonpatch.PatchError) as cm:
                jsonpatch.apply_patch(self.DOC, ops)
            self.assertIn(msg, cm.exception.message, ops)
        with self.assertRaises(jsonpatch.PatchError) as cm:
            jsonpatch.apply_patch(self.DOC, [{"op": "replace", "path": "/game/mode", "value": "game"},
                                             {"op": "remove", "path": "/ranges/0/conditions/9"}])
        self.assertTrue(cm.exception.message.startswith("第 2 条修改"))


# ================================================================ 填工作台
class TestPatchSemantics(unittest.TestCase):
    """数组下标按修改之前的文档算（一次删多个条件时下标不能错位）。"""
    DOC = {"c": [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}]}

    def ids(self, d):
        return [x["id"] for x in d["c"]]

    def test_multiple_removes_use_original_indices(self):
        d = jsonpatch.apply_patch(self.DOC, [{"op": "remove", "path": "/c/0"}, {"op": "remove", "path": "/c/1"}])
        self.assertEqual(self.ids(d), ["c", "d"])                          # 删的是原来的第 1、2 个
        d = jsonpatch.apply_patch(self.DOC, [{"op": "remove", "path": "/c/3"}, {"op": "remove", "path": "/c/1"}])
        self.assertEqual(self.ids(d), ["a", "c"])                          # 从大到小写也一样
        rfc = jsonpatch.apply_patch(self.DOC, [{"op": "remove", "path": "/c/0"}, {"op": "remove", "path": "/c/1"}],
                                    original_indices=False)
        self.assertEqual(self.ids(rfc), ["b", "d"])                        # 按 RFC 的话会删错

    def test_replace_and_add_after_remove(self):
        d = jsonpatch.apply_patch(self.DOC, [{"op": "remove", "path": "/c/0"},
                                             {"op": "replace", "path": "/c/2/id", "value": "C"},
                                             {"op": "add", "path": "/c/1", "value": {"id": "x"}},
                                             {"op": "add", "path": "/c/-", "value": {"id": "z"}}])
        self.assertEqual(self.ids(d), ["x", "b", "C", "d", "z"])           # /c/2 = 原来的 c；插在原来的 b 前面
        d = jsonpatch.apply_patch(self.DOC, [{"op": "remove", "path": "/c/1"}, {"op": "add", "path": "/c/1", "value": {"id": "B"}}])
        self.assertEqual(self.ids(d), ["a", "B", "c", "d"])                # 删掉的位置上插新的
        d = jsonpatch.apply_patch(self.DOC, [{"op": "replace", "path": "/c/0", "value": {"id": "A"}},
                                             {"op": "replace", "path": "/c/0/id", "value": "A2"}])
        self.assertEqual(self.ids(d), ["A2", "b", "c", "d"])               # 整个换掉的项，后面按原下标还能找到它

    def test_removed_item_cannot_be_addressed(self):
        with self.assertRaises(jsonpatch.PatchError) as cm:
            jsonpatch.apply_patch(self.DOC, [{"op": "remove", "path": "/c/1"}, {"op": "replace", "path": "/c/1/id", "value": "x"}])
        self.assertIn("已经删掉了", cm.exception.message)
        with self.assertRaises(jsonpatch.PatchError):
            jsonpatch.apply_patch(self.DOC, [{"op": "remove", "path": "/c/4"}])

    def test_new_arrays_follow_rfc(self):
        d = jsonpatch.apply_patch({"c": []}, [{"op": "add", "path": "/c/-", "value": {"t": [1, 2, 3]}},
                                              {"op": "remove", "path": "/c/0/t/0"}, {"op": "remove", "path": "/c/0/t/0"}])
        self.assertEqual(d["c"][0]["t"], [3])

    def test_merge_hook(self):
        doc = {"s": {"a": 1, "b": 2}, "t": {"a": 1}}
        m = lambda toks, old, new: {**old, **new} if toks == ["s"] else None   # noqa: E731
        d = jsonpatch.apply_patch(doc, [{"op": "replace", "path": "/s", "value": {"a": 9}},
                                        {"op": "replace", "path": "/t", "value": {"z": 1}}], merge=m)
        self.assertEqual(d, {"s": {"a": 9, "b": 2}, "t": {"z": 1}})


def cur3():
    """当前方案：一个范围，三个条件 [性别女, 作品标签百合, 热度≥100]。"""
    d = default_spec()
    d["ranges"][0]["conditions"] = [
        {"id": "c_a", "type": "gender", "values": ["女"]},
        {"id": "c_b", "type": "game_tags", "quant": "any", "tags": ["百合"]},
        {"id": "c_c", "type": "char_heat", "min": 100, "max": None}]
    return d


class TestFillRobust(AITestBase):
    """AI 改坏方案时不能报成功：要么照 AI 的本意改对，要么明确报错。"""

    def test_typo_field_rejected(self):
        for path in ("/ranges/0/source/year", "/ranges/0/pick/role", "/ranges/0/year_from"):
            self.use([{"patch": [{"op": "replace", "path": path, "value": 2024}]}])
            r = ai.fill("2024 年的", default_spec(), "claude")
            self.assertFalse(r["ok"], path)
            self.assertEqual(r["error_code"], "parse")
            self.assertIn(path, r["error"])
            self.assertIsNone(r["spec"])

    def test_added_unknown_key_rejected(self):
        self.use([{"patch": [{"op": "add", "path": "/ranges/0/source/year", "value": 2024}]}])
        r = ai.fill("2024 年的", default_spec(), "claude")
        self.assertFalse(r["ok"])
        self.assertIn("/ranges/0/source/year", r["error"])
        self.assertIn("字段名写错", r["error"])
        # 新加的条件里字段名写错（tag 少了 s）：不然这个条件会是空的、悄悄不筛人
        self.use([{"patch": [{"op": "add", "path": "/ranges/0/conditions/-", "value": {"type": "game_tags", "tag": ["百合"]}}]}])
        r = ai.fill("百合番", default_spec(), "claude")
        self.assertFalse(r["ok"])
        self.assertIn("/ranges/0/conditions/0/tag", r["error"])

    def test_existing_unknown_keys_in_current_spec_are_fine(self):
        cur = default_spec()
        cur["ranges"][0]["ui_collapsed"] = True                       # 前端自己加的键：不是 AI 写的，不算
        cur["meta"] = {"name": "我的方案", "ui_note": "x"}
        self.use([{"patch": patch_2024(["百合"])}])
        r = ai.fill("2024 年的百合番", cur, "claude")
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["spec"]["ranges"][0]["ui_collapsed"])

    def test_multiple_removes_hit_the_intended_conditions(self):
        self.use([{"patch": [{"op": "remove", "path": "/ranges/0/conditions/0"}, {"op": "remove", "path": "/ranges/0/conditions/1"}]}])
        r = ai.fill("去掉性别和百合条件", cur3(), "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual([c["id"] for c in r["spec"]["ranges"][0]["conditions"]], ["c_c"])
        self.assertEqual(sorted(r["changes"]), sorted(["去掉了条件：性别为女", "去掉了条件：作品标签含『百合』"]))

    def test_partial_root_replace_rejected(self):
        self.use([{"patch": [{"op": "replace", "path": "", "value": {"game": {"mode": "game"}}}]}])
        r = ai.fill("改成游戏模式", cur3(), "claude")
        self.assertFalse(r["ok"])
        self.assertIn("不完整", r["error"])
        self.use([{"spec": {"game": {"mode": "game"}}}])                 # AI 直接给整份方案（{"spec": …}）时也一样
        self.assertFalse(ai.fill("改成游戏模式", cur3(), "claude")["ok"])
        full = cur3()
        full["game"]["mode"] = "game"
        self.use([{"patch": [{"op": "replace", "path": "", "value": full}]}])     # 完整的整份替换照常接受
        r = ai.fill("改成游戏模式", cur3(), "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["changes"], ["对局模式：动画 → 游戏"])

    def test_partial_source_replace_keeps_other_fields(self):
        cur = default_spec()
        cur["ranges"][0]["source"].update(rank_to=None, subject_types=[4])
        self.use([{"patch": [{"op": "replace", "path": "/ranges/0/source",
                              "value": {"kind": "rank", "year_from": 2024, "year_to": 2024}}]}])
        r = ai.fill("2024 年的", cur, "claude")
        self.assertTrue(r["ok"], r)
        src = r["spec"]["ranges"][0]["source"]
        self.assertEqual((src["year_from"], src["year_to"], src["subject_types"], src["rank_to"]), (2024, 2024, [4], None))
        self.assertEqual(r["changes"], ["年份：2016–2026 年 → 2024 年"])
        # 换了来源种类：整个换掉（原来 rank 的字段没有意义了）
        self.use([{"patch": [{"op": "replace", "path": "/ranges/0/source", "value": {"kind": "char_list", "list_id": "l_c"}}]}])
        r = ai.fill("只要清单里的角色", default_spec(), "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["spec"]["ranges"][0]["source"], {"kind": "char_list", "list_id": "l_c"})

    def test_condition_replace_keeps_identity(self):
        self.use([{"patch": [{"op": "replace", "path": "/ranges/0/conditions/1",
                              "value": {"type": "game_tags", "quant": "any", "tags": ["战斗"]}}]}])
        r = ai.fill("把百合换成战斗", cur3(), "claude")
        self.assertTrue(r["ok"], r)
        c = r["spec"]["ranges"][0]["conditions"][1]
        self.assertEqual((c["id"], c["tags"]), ("c_b", ["战斗"]))

    def test_roles_change_without_per_work_follows_game_default(self):
        for ops in ([{"op": "replace", "path": "/ranges/0/pick/roles", "value": ["主角", "配角"]}],
                    [{"op": "replace", "path": "/ranges/0/pick", "value": {"roles": ["主角", "配角"]}}]):
            self.use([{"patch": ops}])
            r = ai.fill("主角和配角", default_spec(), "claude")
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["spec"]["ranges"][0]["pick"]["per_work"], 6, ops)
            self.assertIn("身份：只要主角 → 主角和配角", r["changes"])
        # AI 明确写了人数（包括写 null = 不限）：照 AI 的
        self.use([{"patch": [{"op": "replace", "path": "/ranges/0/pick/roles", "value": ["主角", "配角"]},
                             {"op": "replace", "path": "/ranges/0/pick/per_work", "value": None}]}])
        r = ai.fill("主角和配角，每部不限人数", default_spec(), "claude")
        self.assertIsNone(r["spec"]["ranges"][0]["pick"]["per_work"])
        # 改回只要主角：6 → 不限
        cur = default_spec()
        cur["ranges"][0]["pick"] = {"roles": ["主角", "配角"], "per_work": 6, "order": "heat"}
        self.use([{"patch": [{"op": "replace", "path": "/ranges/0/pick/roles", "value": ["主角"]}]}])
        r = ai.fill("只要主角", cur, "claude")
        self.assertIsNone(r["spec"]["ranges"][0]["pick"]["per_work"])

    def test_alternative_with_unknown_key_dropped(self):
        self.use([{"patch": patch_2024(["百合"]),
                   "alternative": {"label": "另一种", "patch": [{"op": "add", "path": "/ranges/0/source/yaer", "value": 1}]}}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertTrue(r["ok"])
        self.assertIsNone(r["alternative"])
        self.assertTrue(any("另一种理解" in w and "/ranges/0/source/yaer" in w for w in r["warnings"]), r["warnings"])

    def test_dropped_alternative_tags_not_shown(self):
        """被丢掉的「另一种理解」里的标签问题，不该出现在结果卡上。"""
        alt = patch_2024(["完全不存在的标签甲"])                       # 0 人 → 丢掉
        self.use([{"patch": patch_2024(["百合"]), "alternative": {"label": "另一种", "patch": alt}}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertIsNone(r["alternative"])
        self.assertEqual(r["tag_fixes"], [])
        self.assertFalse(any("完全不存在的标签甲" in w for w in r["warnings"]), r["warnings"])
        alt = patch_2024(["百合番"], quant="all") + [{"op": "replace", "path": "/ranges/0/source/rank_to", "value": 1}]
        self.use([{"patch": patch_2024(["百合"]), "alternative": {"label": "另一种", "patch": alt}}])
        r = ai.fill("x", default_spec(), "claude")
        if r["alternative"] is None:                                   # 被丢掉了：它自动换过的名字也不提
            self.assertEqual(r["tag_replaced"], [])

    def test_note_split_when_suggestions(self):
        self.use([{"patch": patch_2024(["百合", "恋爱"], quant="all"), "note": "注意：这两个标签很少同时出现"}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertEqual(r["total"], 0)
        self.assertEqual(r["ai_note"], "注意：这两个标签很少同时出现")
        self.assertTrue(r["suggestion_note"].startswith("现在是 0 人。可以试试："))
        self.assertEqual(r["note"], r["ai_note"] + "；" + r["suggestion_note"])   # note = ai_note 和 suggestion_note 拼起来

    def test_ask_no_sql_keeps_explanation(self):
        self.use(["说明：库里没有声优的出生年份，没法按年龄统计。\n范围：无"])
        r = ai.ask("30 岁以下的声优有多少", "claude")
        self.assertFalse(r["ok"])
        self.assertIn("库里没有声优的出生年份", r["error"])
        self.assertEqual(r["explanation"], "库里没有声优的出生年份，没法按年龄统计。")
        self.assertFalse(r["fixable"])


class TestFill(AITestBase):
    def test_happy_path_patch_one_call(self):
        fr = self.use([{"patch": patch_2024(["百合"]), "defaults_used": ["热度前 50 部", "只要主角"], "note": None,
                        "alternative": None}])
        r = ai.fill("2024 年的百合番角色，别太冷门", default_spec(), "claude")
        self.assertTrue(r["ok"], r)
        # 2024 前 50 部的主角（默认每部不限）= 101 的 c1 c2 c13-c17、102 的 c4 c5、104 的 c6；作品标签含百合（n=6）→ 去掉 c6
        self.assertEqual(r["total"], 9)
        self.assertIn("加了条件：作品标签含『百合』", r["changes"])
        self.assertTrue(any(c.startswith("年份：") for c in r["changes"]))
        self.assertEqual(r["defaults_used"], ["热度前 50 部", "只要主角"])
        self.assertIsNone(r["alternative"])
        self.assertEqual(len(fr.calls), 1)
        self.assertEqual(r["ai_calls"], 1)
        self.assertEqual(r["patch_ops"], 3)
        self.assertEqual(fr.calls[0]["kind"], "fill")
        self.assertIn("当前方案", fr.calls[0]["user"])
        self.assertIn("l_t", fr.calls[0]["user"])                 # 现有清单发给了 AI
        self.assertEqual(r["spec"]["ranges"][0]["id"], "r_default")  # 没改的部分原样保留（包括 id）
        for k in ("ai_first_token_ms", "ai_total_ms", "warm"):
            self.assertIn(k, r)
        self.assertEqual(r["tag_fixes"], [])
        self.assertEqual(r["tag_replaced"], [])

    def test_full_spec_format_accepted(self):
        self.use([{"spec": spec_2024(["百合"]), "changes": ["年份 → 2024"], "defaults_used": []}])
        r = ai.fill("2024 年的百合番", default_spec(), "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["total"], 9)
        self.assertEqual(r["patch_ops"], -1)

    def test_patch_against_current_spec(self):
        cur = spec_2024(["百合"])                                  # 当前方案已经有一个条件
        fr = self.use([{"patch": [{"op": "add", "path": "/ranges/0/conditions/-", "value": {"type": "gender", "values": ["女"]}}]}])
        r = ai.fill("只要女性", cur, "claude")
        self.assertTrue(r["ok"], r)
        conds = r["spec"]["ranges"][0]["conditions"]
        self.assertEqual([c["type"] for c in conds], ["game_tags", "gender"])
        self.assertEqual(conds[0]["id"], "c_ai1")
        self.assertTrue(conds[1]["id"])                              # 后端补了 id
        self.assertEqual(r["changes"], ["加了条件：性别为女"])
        self.assertIn('"c_ai1"', fr.calls[0]["user"])               # AI 看到的是当前方案

    def test_unknown_tag_auto_replaced_without_second_call(self):
        fr = self.use([{"patch": patch_2024(["百合番"])}])
        r = ai.fill("2024 年的百合番", default_spec(), "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(fr.calls), 1)                           # 只调一次 AI：标签名由后端自己换，不让 AI 再改一次
        self.assertEqual(r["spec"]["ranges"][0]["conditions"][0]["tags"], ["百合"])
        self.assertEqual(r["total"], 9)
        rep = r["tag_replaced"]
        self.assertEqual((rep[0]["from"], rep[0]["to"], rep[0]["style"]), ("百合番", "百合", "game"))
        self.assertEqual(rep[0]["message"], "你说的『百合番』库里叫『百合』，已替换")
        self.assertEqual(r["tag_fixes"], [])
        self.assertIn("加了条件：作品标签含『百合』", r["changes"])

    def test_unknown_tag_uncertain_gives_fixes(self):
        fr = self.use([{"patch": patch_2024(["百"])}])               # 「百」：库里没有，也没法确定是哪个
        r = ai.fill("x", default_spec(), "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(fr.calls), 1)
        self.assertEqual(r["spec"]["ranges"][0]["conditions"][0]["tags"], ["百"])   # 原样保留
        fx = r["tag_fixes"]
        self.assertEqual(len(fx), 1)
        self.assertEqual((fx[0]["name"], fx[0]["style"], fx[0]["what"]), ("百", "game", "角色的作品标签"))
        self.assertIn("百合", [c["name"] for c in fx[0]["candidates"]])
        self.assertTrue(all(isinstance(c["count"], int) for c in fx[0]["candidates"]))
        self.assertTrue(any("『百』库里没有" in w for w in r["warnings"]))
        self.assertFalse(any("『百』" in w and "不存在" in w for w in r["warnings"]), r["warnings"])   # 引擎的同一句提示不重复

    def test_nothing_close(self):
        self.use([{"patch": patch_2024(["完全不存在的标签甲"])}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertEqual(r["tag_fixes"][0]["candidates"], [])
        self.assertIn("也没有相近的", r["tag_fixes"][0]["message"])

    def test_meta_tag_case_fixed(self):
        d = [{"op": "replace", "path": "/ranges/0/source/subject_types", "value": [4]},
             {"op": "replace", "path": "/ranges/0/source/work_filter",
              "value": {"quant": "any", "tags": ["galgame"], "tag_mode": "meta"}}]
        self.use([{"patch": d}])
        r = ai.fill("热门 galgame 的主角", default_spec(), "claude")
        self.assertEqual(r["spec"]["ranges"][0]["source"]["work_filter"]["tags"], ["Galgame"])
        self.assertEqual(r["tag_replaced"][0]["style"], "meta")
        self.assertEqual(r["total"], 1)                              # 201 的 c10

    def test_patch_error_discarded(self):
        self.use([{"patch": [{"op": "replace", "path": "/ranges/5/source/year_from", "value": 2024}]}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "parse")
        self.assertIn("用不上", r["error"])
        self.assertIn("第 1 条", r["error"])
        self.assertIsNone(r["spec"])

    def test_parse_failure_discarded(self):
        self.use(["我觉得你应该选百合番。"])
        r = ai.fill("百合", default_spec(), "claude")
        self.assertFalse(r["ok"])
        self.assertIn("解析", r["error"])
        self.assertIsNone(r["spec"])

    def test_no_patch_key(self):
        self.use([{"defaults_used": []}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertFalse(r["ok"])
        self.assertIn("没有 patch", r["error"])

    def test_invalid_spec_discarded(self):
        self.use([{"patch": [{"op": "replace", "path": "/ranges/0/source/year_from", "value": 2030},
                             {"op": "replace", "path": "/ranges/0/source/year_to", "value": 2020}]}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertFalse(r["ok"])
        self.assertIn("不合格", r["error"])

    def test_empty_patch_no_change(self):
        self.use([{"patch": []}])
        r = ai.fill("就这样", default_spec(), "claude")
        self.assertTrue(r["ok"])
        self.assertEqual(r["changes"], ["（方案没有变化）"])

    def test_alternative_same_total_dropped(self):
        alt = patch_2024(["百合"], quant="all")                       # 单个标签 all = any → 人数一样
        self.use([{"patch": patch_2024(["百合"]), "alternative": {"label": "另一种", "patch": alt}}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertIsNone(r["alternative"])

    def test_alternative_patch_is_relative_to_current(self):
        alt = [{"op": "replace", "path": "/ranges/0/source/year_from", "value": 2024},
               {"op": "replace", "path": "/ranges/0/source/year_to", "value": 2024},
               {"op": "replace", "path": "/ranges/0/source/work_filter", "value": {"quant": "any", "tags": ["战斗"]}}]
        self.use([{"patch": patch_2024(["百合"]), "alternative": {"label": "另一种理解：作品本身带战斗", "patch": alt}}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertEqual(r["alternative"]["total"], 2)              # 只有 102 → c4 c5
        self.assertEqual(r["alternative"]["label"], "另一种理解：作品本身带战斗")
        self.assertEqual(r["alternative"]["spec"]["ranges"][0]["conditions"], [])   # 不是在主 patch 上再改

    def test_zero_person_alternative_dropped(self):
        alt = patch_2024(["百合", "恋爱"], quant="all")                 # 0 人
        self.use([{"patch": patch_2024(["百合"]), "alternative": {"label": "另一种", "patch": alt}}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertEqual(r["total"], 9)
        self.assertIsNone(r["alternative"])

    def test_prompt_says_bie_tai_lengmen_is_not_lengmen(self):
        self.assertIn("「别太冷门」的意思是「要热门一点」，不是「要冷门」", ai.fill_system())

    def test_bad_alternative_dropped_main_kept(self):
        self.use([{"patch": patch_2024(["百合"]),
                   "alternative": {"label": "坏的", "patch": [{"op": "remove", "path": "/ranges/9"}]}}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertTrue(r["ok"])
        self.assertIsNone(r["alternative"])
        self.assertTrue(any("另一种理解" in w for w in r["warnings"]))

    def test_alternative_tags_also_fixed(self):
        alt = patch_2024(["战斗番"])
        self.use([{"patch": patch_2024(["百合"]), "alternative": {"label": "另一种", "patch": alt}}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertEqual(r["alternative"]["spec"]["ranges"][0]["conditions"][0]["tags"], ["战斗"])
        self.assertEqual(r["tag_replaced"][0]["to"], "战斗")
        self.assertIn("AI 写的『战斗番』", r["tag_replaced"][0]["message"])   # 用户原话里没有「战斗番」

    def test_zero_total_template_only_one_call(self):
        # 2024 前 50 部的主角里「同时含 百合 和 恋爱」→ 0 人
        fr = self.use([{"patch": patch_2024(["百合", "恋爱"], quant="all")}])
        r = ai.fill("x", default_spec(), "claude")
        self.assertEqual(r["total"], 0)
        self.assertEqual(len(fr.calls), 1)                           # 建议由模板生成，不调 AI
        self.assertTrue(r["suggestions"])
        for s in r["suggestions"]:
            self.assertGreater(s["total"], 0)
        self.assertIn("现在是 0 人。可以试试：", r["note"])
        self.assertIn(f"{r['suggestions'][0]['total']:,} 人", r["note"])

    def test_huge_total_template(self):
        d = [{"op": "replace", "path": "/ranges/0/source/year_from", "value": None},
             {"op": "replace", "path": "/ranges/0/source/year_to", "value": None},
             {"op": "replace", "path": "/ranges/0/source/rank_to", "value": None},
             {"op": "replace", "path": "/ranges/0/pick", "value": {"roles": ["主角", "配角"], "per_work": None, "order": "heat"}}]
        fr = self.use([{"patch": d}])
        with mock.patch.object(ai, "HUGE_TOTAL", 5):
            r = ai.fill("全部角色", default_spec(), "claude")
        self.assertGreater(r["total"], 5)
        self.assertEqual(len(fr.calls), 1)
        self.assertTrue(r["suggestions"])
        self.assertTrue(all(s["total"] < r["total"] for s in r["suggestions"]))
        self.assertIn("偏多", r["note"])

    def test_input_checks(self):
        self.use([])
        self.assertFalse(ai.fill("", default_spec(), "claude")["ok"])
        self.assertFalse(ai.fill("字" * 600, default_spec(), "claude")["ok"])
        r = ai.fill("x", default_spec(), "gpt")
        self.assertFalse(r["ok"])
        self.assertIn("引擎", r["error"])

    def test_timeout_reported(self):
        self.use([ai.AIError("AI 超过 120 秒没有返回，已中止", code="timeout")])
        r = ai.fill("x", default_spec(), "claude")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "timeout")

    def test_bad_current_spec_raises(self):
        self.use([])
        with self.assertRaises(ai.SpecError):
            ai.fill("x", {"game": {"tag_count": 99}}, "claude")

    def test_spec_size_cap(self):
        """当前方案整体太大：和「这句话太长」一样返回 too_long，不解析、不调 AI。"""
        fr = self.use([])
        big = spec_2024(["标签%05d" % i for i in range(12000)])
        r = ai.fill("x", big, "claude")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "too_long")
        self.assertIn(f"太长了（最多 {ai.MAX_SPEC_CHARS} 个字）", r["error"])
        self.assertEqual(fr.calls, [])
        # 大但没超的方案照常交给 AI
        fr = self.use([{"patch": patch_2024(["百合"])}])
        mid = spec_2024(["标签%05d" % i for i in range(6000)])
        self.assertFalse(ai.spec_too_long(mid))
        ai.fill("x", mid, "claude")
        self.assertEqual(len(fr.calls), 1)

    def test_spec_size_boundary(self):
        edge = ai.MAX_SPEC_CHARS - len('{"x":""}')
        self.assertFalse(ai.spec_too_long({"x": "a" * edge}))            # 刚好等于上限：放行
        self.assertTrue(ai.spec_too_long({"x": "a" * (edge + 1)}))       # 多一个字：拒绝
        self.assertFalse(ai.spec_too_long(None))                         # 没带方案 = 用默认方案
        self.assertFalse(ai.spec_too_long(default_spec()))
        deep = cur = {}
        for _ in range(3000):                                            # 嵌套太深转不成 JSON：当作太大
            cur["a"] = {}
            cur = cur["a"]
        self.assertTrue(ai.spec_too_long(deep))


class TestNameFix(unittest.TestCase):
    def test_auto_fix_rules(self):
        universe = {"后宫": 10, "后宫向": 5, "Galgame": 3, "SF": 4, "sf": 1, "百合": 9, "战斗": 8, "日常": 7}
        idx = {}
        for k in universe:
            idx.setdefault(ai._norm_name(k), []).append(k)
        ex = universe.__contains__

        def f(n, st="game"):
            return ai.auto_fix_name(n, st, ex, idx)
        self.assertEqual(f("后宫番"), "后宫")                          # 去掉后缀
        self.assertEqual(f("百合番剧"), "百合")                        # 长后缀先试
        self.assertEqual(f("战斗类"), "战斗")
        self.assertEqual(f("日常系"), "日常")
        self.assertEqual(f("galgame"), "Galgame")                     # 大小写
        self.assertEqual(f("Ｇａｌｇａｍｅ"), "Galgame")                # 全角
        self.assertEqual(f("Gal game"), "Galgame")                    # 空格
        self.assertIsNone(f("ＳＦ"))                                   # 库里 SF / sf 两个：拿不准
        self.assertIsNone(f("后"))                                     # 不是写法差异也不是后缀
        self.assertIsNone(f("番"))
        self.assertIsNone(f("恋爱番"))                                 # 去掉后缀库里也没有
        self.assertIsNone(f("后宫番", "va"))                           # 声优名只认写法差异

    def test_va_width_fix(self):
        d = default_spec()
        d["ranges"][0]["conditions"] = [{"type": "va", "names": ["声优Ａ"]}]
        sp, rep, fx = ai.fix_names(parse_spec(d), "")
        self.assertEqual(sp.ranges[0].conditions[0].names, ["声优A"])
        self.assertEqual(rep[0]["style"], "va")

    def test_replace_name_dedupes_and_respects_style(self):
        d = spec_to_dict(parse_spec(spec_2024(["百合番", "百合"])))
        d["ranges"][0]["source"]["work_filter"] = {"quant": "any", "tags": ["百合番"]}
        self.assertTrue(ai.replace_name(d, "game", "百合番", "百合"))
        self.assertEqual(d["ranges"][0]["conditions"][0]["tags"], ["百合"])
        self.assertEqual(d["ranges"][0]["source"]["work_filter"]["tags"], ["百合番"])   # 另一类（作品本身的标签）不动


class TestHumanText(AITestBase):
    """给人看的文字只用中文模式名；作品类型和对局模式对不上时提示。"""

    def test_humanize(self):
        self.assertEqual(ai.humanize("对局模式保持 anime"), "对局模式保持 动画")
        self.assertEqual(ai.humanize("游戏模式：anime"), "游戏模式：动画")
        self.assertEqual(ai.humanize("game.mode 改成 game，subject_types = [4]"), "对局模式 改成 游戏，作品类型 = [4]")
        self.assertEqual(ai.humanize("加了条件：game_tags 含『all』"), "加了条件：作品标签 含『all』")   # 引号里的不动
        self.assertEqual(ai.humanize("你说「game」"), "你说「game」")
        self.assertEqual(ai.humanize("Galgame 和 gamer 不动"), "Galgame 和 gamer 不动")
        self.assertIsNone(ai.humanize(None))

    def test_fill_output_humanized(self):
        self.use([{"patch": patch_2024(["百合"]), "defaults_used": ["对局模式保持 anime", "作品标签数 6"],
                   "note": "按 anime 模式算", "alternative": None}])
        r = ai.fill("2024 年的百合番角色", default_spec(), "claude")
        self.assertEqual(r["defaults_used"], ["对局模式保持 动画", "作品标签数 6"])
        self.assertEqual(r["note"], "按 动画 模式算")
        for x in r["changes"] + r["defaults_used"] + [r["note"]]:
            for word in ("anime", " game", "book", "real"):
                self.assertNotIn(word, x)

    def test_mode_type_mismatch_warning(self):
        p = [{"op": "replace", "path": "/ranges/0/source/subject_types", "value": [4]},
             {"op": "replace", "path": "/ranges/0/source/year_from", "value": 2021},
             {"op": "add", "path": "/ranges/0/conditions/-", "value": {"type": "gender", "values": ["女"]}}]
        self.use([{"patch": p}])
        r = ai.fill("近 5 年热门游戏的女主角", default_spec(), "claude")
        self.assertTrue(any("对局模式还是动画" in w for w in r["warnings"]), r["warnings"])
        # 模式跟着改了 → 不提示，changes 里有「对局模式：动画 → 游戏」
        self.use([{"patch": p + [{"op": "replace", "path": "/game/mode", "value": "game"}]}])
        r = ai.fill("近 5 年热门游戏的女主角", default_spec(), "claude")
        self.assertFalse(any("对局模式还是动画" in w for w in r["warnings"]))
        self.assertIn("对局模式：动画 → 游戏", r["changes"])

    def test_galgame_keeps_anime_mode(self):
        p = [{"op": "replace", "path": "/ranges/0/source/subject_types", "value": [4]},
             {"op": "replace", "path": "/ranges/0/source/work_filter",
              "value": {"quant": "any", "tags": ["Galgame"], "tag_mode": "meta"}}]
        self.use([{"patch": p}])
        r = ai.fill("热门 Galgame 的女主角", default_spec(), "claude")
        self.assertFalse(any("对局模式还是动画" in w for w in r["warnings"]))

    def test_prompt_rules(self):
        sysmsg = ai.fill_system()
        self.assertIn("JSON Patch", sysmsg)
        self.assertIn('"op":"replace","path":"/ranges/0/source/year_from"', sysmsg)
        self.assertIn("alternative.patch 也是对「当前方案」的完整修改", sysmsg)
        self.assertIn("例外：Galgame", sysmsg)
        self.assertIn("不要写 anime / game / book / real / all", sysmsg)
        self.assertNotIn('"changes"', sysmsg)                        # changes 由后端算，提示词不要求 AI 写


# ================================================================ 问数据
GOOD_SQL = "SELECT id AS character_id, display_name, heat FROM character ORDER BY heat DESC LIMIT 3"


def ask_text(sql, explanation="按热度排的前 3 个角色。", scope="统计的是库里所有角色", save="character character_id"):
    return f"说明：{explanation}\n范围：{scope}\n```sql\n{sql}\n```\n存为：{save}"


class TestAsk(AITestBase):
    def test_marked_text_format(self):
        fr = self.use([ask_text(GOOD_SQL)])
        r = ai.ask("热度最高的 3 个角色", "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(fr.calls), 1)
        self.assertEqual(fr.calls[0]["kind"], "ask")
        self.assertEqual([row[0] for row in r["rows"]], [9, 5, 1])
        self.assertEqual(r["sql"], GOOD_SQL)
        self.assertEqual(r["explanation"], "按热度排的前 3 个角色。")
        self.assertEqual(r["save_hint"], {"kind": "character", "id_column": "character_id"})
        self.assertIn("统计的是库里所有角色", r["scope_note"])
        self.assertIn("库的覆盖（后端统计）", r["scope_note"])
        self.assertIsInstance(r["sql_ms"], (int, float))
        for k in ("ai_first_token_ms", "ai_total_ms", "warm"):
            self.assertIn(k, r)
        self.assertFalse(r["fixable"])

    def test_sql_error_not_retried(self):
        fr = self.use([ask_text("SELECT nope FROM character")])
        r = ai.ask("热度最高的 3 个角色", "claude")
        self.assertEqual(len(fr.calls), 1)                            # SQL 出错不自动重试，由用户点「让 AI 改」
        self.assertFalse(r["ok"])
        self.assertTrue(r["fixable"])
        self.assertEqual(r["error_code"], "sql")
        self.assertIn("列不存在", r["error"])
        self.assertEqual(r["sql"], "SELECT nope FROM character")    # 前端要拿它去「让 AI 改」
        self.assertEqual(r["explanation"], "按热度排的前 3 个角色。")

    def test_ask_fix(self):
        fr = self.use([ask_text(GOOD_SQL)])
        r = ai.ask_fix("热度最高的 3 个角色", "SELECT nope FROM character", "列不存在：nope", "claude")
        self.assertTrue(r["ok"], r)
        u = fr.calls[0]["user"]
        self.assertIn("上一次写的 SQL", u)
        self.assertIn("SELECT nope FROM character", u)
        self.assertIn("列不存在：nope", u)
        self.assertIn("热度最高的 3 个角色", u)
        self.assertEqual(r["fixed_from"], "SELECT nope FROM character")
        self.assertEqual([row[0] for row in r["rows"]], [9, 5, 1])

    def test_ask_fix_still_broken_is_fixable_again(self):
        self.use([ask_text("SELECT still_nope FROM character")])
        r = ai.ask_fix("q", "SELECT nope FROM character", "列不存在", "claude")
        self.assertFalse(r["ok"])
        self.assertTrue(r["fixable"])

    def test_ask_fix_needs_sql(self):
        self.use([])
        r = ai.ask_fix("q", "  ", "err", "claude")
        self.assertFalse(r["ok"])

    def test_ask_fix_sql_and_error_caps(self):
        """「让 AI 改」带回来的 SQL ≤ 20000 字、报错 ≤ 2000 字；超了返回 too_long，不调 AI。"""
        self.assertEqual((ai.MAX_FIX_SQL_CHARS, ai.MAX_FIX_ERROR_CHARS), (20000, 2000))
        fr = self.use([ask_text(GOOD_SQL)])
        r = ai.ask_fix("q", "SELECT 1".ljust(ai.MAX_FIX_SQL_CHARS + 1), "err", "claude")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "too_long")
        self.assertEqual(r["error"], "要改的 SQL 太长了（最多 20000 个字）")
        self.assertFalse(r["fixable"])
        r = ai.ask_fix("q", "SELECT nope", "错" * (ai.MAX_FIX_ERROR_CHARS + 1), "claude")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "too_long")
        self.assertEqual(r["error"], "报错信息太长了（最多 2000 个字）")
        self.assertEqual(fr.calls, [])
        # 刚好等于上限：照常交给 AI
        r = ai.ask_fix("q", "SELECT 1".ljust(ai.MAX_FIX_SQL_CHARS), "错" * ai.MAX_FIX_ERROR_CHARS, "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(fr.calls), 1)
        self.assertIn("错" * ai.MAX_FIX_ERROR_CHARS, fr.calls[0]["user"])

    def test_plain_ask_has_no_fix_caps(self):
        """普通提问没有 fix，不受这两个上限影响（它自己的上限是 max_input_chars）。"""
        fr = self.use([])
        r = ai.ask("字" * 600, "claude")
        self.assertEqual(r["error_code"], "too_long")
        self.assertEqual(r["error"], "问题太长了（最多 500 个字）")
        self.assertEqual(fr.calls, [])

    def test_write_sql_rejected(self):
        self.use([ask_text("DELETE FROM character", save="无")])
        r = ai.ask("删掉所有角色", "claude")
        self.assertFalse(r["ok"])
        self.assertIn("只允许查询", r["error"])
        self.assertTrue(r["fixable"])

    def test_no_sql(self):
        self.use(["说明：我没法回答\n范围：无"])
        r = ai.ask("?", "claude")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error_code"], "parse")
        self.assertFalse(r["fixable"])

    def test_json_format_accepted(self):
        self.use([{"sql": GOOD_SQL, "explanation": "热度前 3", "scope_note": "统计的是库里所有角色",
                   "save_hint": {"kind": "character", "id_column": "character_id"}}])
        r = ai.ask("热度最高的 3 个角色", "claude")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["explanation"], "热度前 3")

    def test_save_hint_validation(self):
        self.use([ask_text("SELECT id AS subject_id, display_name FROM subject WHERE type = 2 LIMIT 5", save="work not_a_column")])
        r = ai.ask("几部动画", "claude")
        self.assertEqual(r["save_hint"], {"kind": "work", "id_column": "subject_id"})

    def test_prompt_has_schema_format_and_lists(self):
        fr = self.use([ask_text("SELECT 1")])
        ai.ask("随便", "claude")
        sysmsg = fr.calls[0]["system"]
        self.assertIn("game_tag_n6", sysmsg)
        self.assertIn("user_list_item", sysmsg)
        self.assertIn("说明：", sysmsg)
        self.assertIn("```sql", sysmsg)
        self.assertIn("存为：", sysmsg)
        self.assertNotIn('"sql": "一条 SELECT', sysmsg)               # 提示词要的是带「说明：/范围：/存为：」标记的文字，不是 JSON


class TestParseAskOutput(unittest.TestCase):
    def test_variants(self):
        p = ai.parse_ask_output(ask_text(GOOD_SQL, explanation="两行\n说明", scope="只算动画"))
        self.assertEqual((p["explanation"], p["scope_note"], p["sql"]), ("两行\n说明", "只算动画", GOOD_SQL))
        self.assertEqual(p["save_hint"], {"kind": "character", "id_column": "character_id"})
        # 「统计范围：」也认；没有 sql 语言标记；「存为：无」
        p = ai.parse_ask_output("说明：x\n统计范围：y\n```\nSELECT 1\n```\n存为：无")
        self.assertEqual((p["scope_note"], p["sql"], p["save_hint"]), ("y", "SELECT 1", None))
        # 没有代码块：从 SELECT 开始到「存为」
        p = ai.parse_ask_output("说明：x\n范围：y\nSELECT a\nFROM b\n存为：作品 subject_id")
        self.assertEqual(p["sql"], "SELECT a\nFROM b")
        self.assertEqual(p["save_hint"], {"kind": "work", "id_column": "subject_id"})
        # 代码块没关（输出被截断）
        p = ai.parse_ask_output("说明：x\n范围：y\n```sql\nWITH t AS (SELECT 1) SELECT * FROM t")
        self.assertEqual(p["sql"], "WITH t AS (SELECT 1) SELECT * FROM t")
        # 全角 / 半角冒号、「存为：tag 标签」
        p = ai.parse_ask_output("说明: x\n范围: y\n```sql\nSELECT 1 AS 标签\n```\n存为：tag 标签")
        self.assertEqual((p["explanation"], p["save_hint"]), ("x", {"kind": "tag", "id_column": "标签"}))
        with self.assertRaises(ai.AIError):
            ai.parse_ask_output("  ")


# ================================================================ 流式（SSE）
def run_sse(gen_factory, cancel_after=None):
    """跑一个 sse_events 生成器，收集 (event, data)。cancel_after = 收到这么多个事件后断开连接。"""
    async def go():
        out = []
        gen = gen_factory()
        try:
            async for chunk in gen:
                if chunk.startswith(":"):
                    continue
                ev, data = None, None
                for line in chunk.strip().split("\n"):
                    if line.startswith("event: "):
                        ev = line[7:]
                    elif line.startswith("data: "):
                        data = json.loads(line[6:])
                out.append((ev, data))
                if cancel_after is not None and len(out) >= cancel_after:
                    break
        finally:
            await gen.aclose()
        return out
    return asyncio.run(go())


def wait(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return bool(cond())


class TestSSE(AITestBase):
    def test_pack(self):
        s = ai.sse_pack("delta", {"text": "你好\n世界"})
        self.assertEqual(s, 'event: delta\ndata: {"text": "你好\\n世界"}\n\n')   # 一条 data 一行，换行转义

    def test_fill_stream_events(self):
        self.use([{"patch": patch_2024(["百合"])}], stream=True)
        evs = run_sse(lambda: ai.sse_events("fill", lambda job: ai.fill_job("2024 年的百合番", default_spec(), "claude", job),
                                            job_id="t1"))
        names = [e for e, _ in evs]
        self.assertEqual(names[0], "open")
        self.assertEqual(evs[0][1]["job_id"], "t1")
        self.assertEqual(names[-1], "result")
        self.assertIn("delta", names)
        stages = [d["stage"] for e, d in evs if e == "status"]
        self.assertIn("writing", stages)
        self.assertIn("checking", stages)
        self.assertLess(names.index("delta"), names.index("result"))
        text = "".join(d["text"] for e, d in evs if e == "delta")
        self.assertIn('"patch"', text)
        res = evs[-1][1]
        self.assertTrue(res["ok"])
        self.assertEqual(res["total"], 9)
        self.assertIsNotNone(res["ai_first_token_ms"])

    def test_ask_stream_events_and_sql_error(self):
        self.use([ask_text("SELECT nope FROM character")], stream=True)
        evs = run_sse(lambda: ai.sse_events("ask", lambda job: ai.ask_job("q", "claude", job)))
        res = evs[-1][1]
        self.assertEqual(evs[-1][0], "result")
        self.assertFalse(res["ok"])
        self.assertTrue(res["fixable"])
        self.assertIn("sql", [d["stage"] for e, d in evs if e == "status"])

    def test_error_event(self):
        def boom(job):
            raise RuntimeError("坏了")
        with mock.patch("traceback.print_exc"):
            evs = run_sse(lambda: ai.sse_events("fill", boom))
        self.assertEqual(evs[-1][0], "error")
        self.assertEqual(evs[-1][1]["code"], "internal")
        self.assertIn("坏了", evs[-1][1]["message"])

    def test_disconnect_cancels_job(self):
        seen = {}

        def slow(job):
            seen["job"] = job
            job.status("start", "开始")
            for _ in range(200):
                if job.cancelled.is_set():
                    seen["cancelled"] = True
                    raise ai.AIError("已取消", code="cancelled")
                time.sleep(0.02)
            return {"ok": True}
        evs = run_sse(lambda: ai.sse_events("ask", slow, job_id="t-cancel"), cancel_after=2)
        self.assertEqual([e for e, _ in evs], ["open", "status"])
        self.assertTrue(wait(lambda: seen.get("cancelled")))
        self.assertTrue(wait(lambda: not ai.cancel_job("t-cancel")))   # 结束后不在登记表里了

    def test_cancel_endpoint(self):
        from backend.v2 import router as R
        started = threading.Event()
        result = {}

        def slow(job):
            started.set()
            for _ in range(300):
                if job.cancelled.is_set():
                    raise ai.AIError("已取消", code="cancelled")
                time.sleep(0.01)
            return {"ok": True}

        def consume():
            result["evs"] = run_sse(lambda: ai.sse_events("fill", slow, job_id="t-cancel-2"))
        th = threading.Thread(target=consume)
        th.start()
        self.assertTrue(started.wait(5))
        self.assertEqual(R.v2_ai_cancel({"job_id": "t-cancel-2"}), {"ok": True})
        th.join(10)
        self.assertEqual(result["evs"][-1][0], "error")
        self.assertEqual(result["evs"][-1][1]["code"], "cancelled")
        self.assertEqual(R.v2_ai_cancel({"job_id": "nope"}), {"ok": False})

    def test_router_stream_endpoint(self):
        from backend.v2 import router as R
        self.use([{"patch": patch_2024(["百合"])}], stream=True)

        async def go():
            resp = await R.v2_ai_fill_stream({"text": "2024 年的百合番", "spec": default_spec(), "client_id": "r1"})
            self.assertEqual(resp.media_type, "text/event-stream")
            out = []
            async for chunk in resp.body_iterator:
                out.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))
            bad = await R.v2_ai_fill_stream({"text": "x", "spec": {"game": {"tag_count": 99}}})
            return "".join(out), bad
        body, bad = asyncio.run(go())
        self.assertIn("event: open", body)
        self.assertIn("event: result", body)
        self.assertIn('"total": 9', body)
        self.assertEqual(bad.status_code, 422)                       # 当前方案不合格：不开流，直接 422

    def test_router_ask_fix(self):
        from backend.v2 import router as R
        self.use([ask_text(GOOD_SQL)])
        r = R.v2_ai_ask_fix({"question": "热度最高的 3 个角色", "sql": "SELECT nope FROM character", "error": "列不存在"})
        self.assertTrue(r["ok"], r)

    def test_router_ask_fix_caps(self):
        """非流式和流式的「让 AI 改」都在调 AI 之前拦下超长的 SQL / 报错。"""
        from backend.v2 import router as R
        fr = self.use([ask_text(GOOD_SQL)])
        long_sql = "SELECT 1".ljust(ai.MAX_FIX_SQL_CHARS + 1)
        long_err = "错" * (ai.MAX_FIX_ERROR_CHARS + 1)
        r = R.v2_ai_ask_fix({"question": "q", "sql": long_sql, "error": "列不存在"})
        self.assertEqual((r["ok"], r["error_code"]), (False, "too_long"))
        r = R.v2_ai_ask_fix({"question": "q", "sql": "SELECT nope", "error": long_err})
        self.assertEqual((r["ok"], r["error_code"]), (False, "too_long"))

        async def go(body):
            resp = await R.v2_ai_ask_fix_stream(body)
            return "".join([c if isinstance(c, str) else c.decode("utf-8") async for c in resp.body_iterator])
        for body in ({"question": "q", "sql": long_sql, "error": "e"}, {"question": "q", "sql": "SELECT nope", "error": long_err}):
            out = asyncio.run(go(body))
            self.assertIn("event: result", out)
            self.assertIn('"error_code": "too_long"', out)
        self.assertEqual(fr.calls, [])

    def test_router_fill_huge_spec(self):
        """方案太大：非流式返回 too_long；流式不先解析（不是 422），在流里给出同样的 too_long。"""
        from backend.v2 import router as R
        fr = self.use([])
        big = spec_2024(["标签%05d" % i for i in range(12000)])
        r = R.v2_ai_fill({"text": "x", "spec": big})
        self.assertEqual((r["ok"], r["error_code"]), (False, "too_long"))

        async def go():
            resp = await R.v2_ai_fill_stream({"text": "x", "spec": big})
            self.assertEqual(resp.media_type, "text/event-stream")
            return "".join([c if isinstance(c, str) else c.decode("utf-8") async for c in resp.body_iterator])
        out = asyncio.run(go())
        self.assertIn("event: result", out)
        self.assertIn('"error_code": "too_long"', out)
        self.assertEqual(fr.calls, [])

    def test_warm_endpoint_noop_with_fake_runner(self):
        from backend.v2 import router as R
        self.use([])
        r = R.v2_ai_warm({"kinds": ["fill"]})
        self.assertTrue(r["ok"])
        self.assertEqual(r["warming"], [])                           # 假 RUNNER：不开真进程
        r = R.v2_ai_warm({"kinds": ["ask"], "engine": "codex"})
        self.assertIn("codex", r["note"])
        self.assertIn("slots", R.v2_ai_pool())


# ================================================================ 通道检查
class TestChannel(unittest.TestCase):
    def test_base_url_checks(self):
        with mock.patch.object(ai, "_claude_user_settings", lambda: {}):
            with mock.patch.dict(os.environ, {"ANTHROPIC_BASE_URL": "https://relay.example.com/anthropic"}):
                ok, note = ai.check_claude_channel(run_auth_status=False)
                self.assertFalse(ok)
                self.assertIn("不是 Anthropic 官方域名", note)
            with mock.patch.dict(os.environ, {"ANTHROPIC_BASE_URL": "https://api.anthropic.com"}):
                self.assertTrue(ai.check_claude_channel(run_auth_status=False)[0])
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_BASE_URL", None)
            with mock.patch.object(ai, "_claude_user_settings", lambda: {"env": {"ANTHROPIC_BASE_URL": "https://openrouter.ai/api"}}):
                ok, note = ai.check_claude_channel(run_auth_status=False)
                self.assertFalse(ok)
                self.assertIn("settings.json", note)
            with mock.patch.object(ai, "_claude_user_settings", lambda: {"apiKeyHelper": "x.sh"}):
                self.assertFalse(ai.check_claude_channel(run_auth_status=False)[0])
            with mock.patch.object(ai, "_claude_user_settings", lambda: {"env": {"CLAUDE_CODE_USE_BEDROCK": "1"}}):
                self.assertFalse(ai.check_claude_channel(run_auth_status=False)[0])

    def test_auth_status(self):
        with mock.patch.object(ai, "_claude_user_settings", lambda: {}), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_BASE_URL", None)
            with mock.patch.object(ai, "_claude_auth_status", lambda: {"loggedIn": True, "authMethod": "apiKey"}):
                self.assertFalse(ai.check_claude_channel()[0])
            with mock.patch.object(ai, "_claude_auth_status", lambda: {"loggedIn": True, "authMethod": "claude.ai",
                                                                        "subscriptionType": "max"}):
                self.assertTrue(ai.check_claude_channel()[0])

    def test_child_env_scrubbed(self):
        with mock.patch.dict(os.environ, {"CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "x", "ANTHROPIC_API_KEY": "k",
                                          "OPENAI_API_KEY": "k", "PATH": os.environ.get("PATH", "")}):
            env = ai.child_env()
        for k in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
            self.assertNotIn(k, env)
        self.assertIn("PATH", env)

    def test_codex_channel(self):
        import tempfile
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "auth.json"), "w", encoding="utf-8") as f:
            json.dump({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-x"}, f)
        with mock.patch.dict(os.environ, {"CODEX_HOME": d}):
            self.assertFalse(ai.check_codex_channel()[0])
        with open(os.path.join(d, "auth.json"), "w", encoding="utf-8") as f:
            json.dump({"auth_mode": "chatgpt", "tokens": {"a": 1}}, f)
        with mock.patch.dict(os.environ, {"CODEX_HOME": d}):
            self.assertTrue(ai.check_codex_channel()[0])

    def test_effort_config(self):
        with mock.patch.object(ai.settings, "ai_config", lambda: {"claude_effort": "low"}):
            self.assertEqual(ai.claude_effort(), "low")
        with mock.patch.object(ai.settings, "ai_config", lambda: {"claude_effort": None}):
            self.assertIsNone(ai.claude_effort())
        with mock.patch.object(ai.settings, "ai_config", lambda: {"claude_effort": "default"}):
            self.assertIsNone(ai.claude_effort())
        self.assertEqual(ai.settings.AI_DEFAULTS["claude_effort"], "low")

    def test_real_runner_checks_channel_before_spawn(self):
        """真 RUNNER：通道不对时不开进程（预热池 acquire 抛 channel），根本走不到 claude。"""
        job = ai.AiJob("fill")
        with mock.patch.object(ai, "claude_cmd", lambda: ["claude-不存在"]), \
                mock.patch.object(ai, "check_claude_channel", lambda run_auth_status=True: (False, "通道不对，拒绝调用")), \
                mock.patch.object(ai.aipool, "WarmProc", side_effect=AssertionError("不该开进程")):
            with self.assertRaises(ai.AIError) as cm:
                ai.run_engine("claude", "fill", "sys", "user", 5, job)
        self.assertEqual(cm.exception.code, "channel")

    def test_real_runner_uses_warm_process_and_streams(self):
        """真 RUNNER + 假 claude（tests/fake_claude.py）：走预热池、边写边推、一次一用。"""
        import sys
        fake = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_claude.py")]
        events = []
        job = ai.AiJob("fill", emit=lambda ev, data: events.append((ev, data)))
        # 补开时用的提示词和请求用的一样（生产里是 fill_system() / ask_system_cached()），指纹才对得上
        pool = ai.aipool.Pool(spawn=ai._spawn_claude, prompt_for=lambda k: ("你是测试", ai._pool_key("你是测试")),
                              channel_check=lambda full: (True, "ok"), enabled=lambda: True, idle_s=lambda: 600,
                              reap_every=3600)
        with mock.patch.object(ai, "claude_cmd", lambda: list(fake)), mock.patch.object(ai, "POOL", pool):
            r = ai.run_engine("claude", "fill", "你是测试", "用户的话：你好", 20, job)
            self.assertTrue(r.text.startswith("好的："))
            self.assertFalse(r.warm)                                        # 池子是空的：现开
            self.assertIsNotNone(r.first_token_ms)
            self.assertIn("delta", [e for e, _ in events])
            self.assertTrue(wait(lambda: pool.status()["slots"]["fill"]["state"] == "ready", 10))   # 用完后台补开
            job2 = ai.AiJob("fill")
            r2 = ai.run_engine("claude", "fill", "你是测试", "第二个问题", 20, job2)
            self.assertTrue(r2.warm)                                        # 第二次用的是预热好的
            pool.shutdown()


class TestConfiguredCommand(unittest.TestCase):
    """config 里写的 claude_cmd / codex_cmd 得真的存在；不存在就不算可用，也不会退回去用 PATH 里别的。全程不启动 claude / codex。"""

    def cfg(self, **kw):
        return mock.patch.object(ai.settings, "ai_config", lambda: dict(kw))

    def test_missing_file_is_unavailable(self):
        import sys
        gone = os.path.join(os.path.dirname(sys.executable), "no-such-claude-cli.exe")
        with self.cfg(claude_cmd=[gone, "--x"], codex_cmd=gone):
            self.assertIsNone(ai.claude_cmd())
            self.assertIsNone(ai.codex_cmd())                                # 写成字符串也一样
        with self.cfg(claude_cmd=["no-such-claude-cli-xyz"]):
            self.assertIsNone(ai.claude_cmd())                               # 不是路径、PATH 里也没有

    def test_existing_file_or_path_name_is_available(self):
        import sys
        with self.cfg(claude_cmd=[sys.executable, "--flag"], codex_cmd=sys.executable):
            self.assertEqual(ai.claude_cmd(), [sys.executable, "--flag"])    # 只查第一项（可执行文件），参数原样带上
            self.assertEqual(ai.codex_cmd(), [sys.executable])
        with self.cfg(claude_cmd=["my-claude"]), mock.patch.object(ai.shutil, "which", lambda n: "/bin/my-claude" if n == "my-claude" else None):
            self.assertEqual(ai.claude_cmd(), ["my-claude"])                 # PATH 里找得到也行

    def test_missing_does_not_fall_back_to_path(self):
        with self.cfg(claude_cmd=["no-such-claude-cli-xyz"]), \
                mock.patch.object(ai.shutil, "which", lambda n: "/bin/claude" if n == "claude" else None):
            self.assertIsNone(ai.claude_cmd())                               # PATH 里即使有 claude，也不替用户换
        with self.cfg(), mock.patch.object(ai.shutil, "which", lambda n: "/bin/claude" if n == "claude" else None):
            self.assertEqual(ai.claude_cmd(), ["/bin/claude"])               # 没配置才自动找

    def test_not_ready_and_status_unavailable(self):
        import sys
        gone = os.path.join(os.path.dirname(sys.executable), "no-such-cli.exe")
        with self.cfg(claude_cmd=[gone], codex_cmd=[gone]), \
                mock.patch.object(ai, "check_claude_channel", side_effect=AssertionError("不该查通道")), \
                mock.patch.object(ai, "check_codex_channel", side_effect=AssertionError("不该查通道")):
            ok, note = ai.engine_ready("claude")
            self.assertFalse(ok)
            self.assertIn("找不到 claude", note)
            self.assertFalse(ai.engine_ready("codex")[0])
            engines = {e["id"]: e for e in ai.status()["engines"]}
            for eid in ("claude", "codex"):
                self.assertFalse(engines[eid]["available"])
                self.assertFalse(engines[eid]["channel_ok"])

    def test_real_runner_does_not_spawn_missing_cmd(self):
        import sys
        gone = os.path.join(os.path.dirname(sys.executable), "no-such-cli.exe")
        with self.cfg(claude_cmd=[gone], codex_cmd=[gone]), \
                mock.patch.object(ai.aipool, "WarmProc", side_effect=AssertionError("不该开进程")), \
                mock.patch.object(ai.subprocess, "Popen", side_effect=AssertionError("不该开进程")):
            for eid in ("claude", "codex"):
                with self.assertRaises(ai.AIError) as cm:
                    ai.run_engine(eid, "fill", "sys", "user", 5, ai.AiJob("fill"))
                self.assertEqual(cm.exception.code, "unavailable")


class TestCodexProcessTree(unittest.TestCase):
    """codex 子进程也放进 Windows 作业对象——取消 / 正常结束后，它开的孙子进程都跟着结束。"""
    CHILD = ("import subprocess, sys, time\n"
             "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],"
             " stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
             "print('GRANDCHILD', g.pid, flush=True)\n"
             "time.sleep(float(sys.argv[1]))\n")

    def _gpid(self, out):
        return int(out.split("GRANDCHILD")[1].split()[0])

    def test_normal_exit_kills_leftover_grandchild(self):
        import sys
        import tempfile
        from .test_aipool import pid_alive, wait_until
        rc, out, err = ai._run([sys.executable, "-c", self.CHILD, "0"], "", tempfile.gettempdir(), 30)
        self.assertEqual(rc, 0, err)
        g = self._gpid(out)
        self.assertTrue(wait_until(lambda: not pid_alive(g), timeout=10))

    def test_cancel_kills_tree(self):
        import sys
        import tempfile
        from .test_aipool import pid_alive, wait_until
        job = ai.AiJob("fill")
        threading.Timer(1.5, job.cancel).start()
        box = {}
        orig_attach = job.attach

        def attach(h):
            box["h"] = h
            orig_attach(h)
        job.attach = attach
        with self.assertRaises(ai.AIError) as cm:
            ai._run([sys.executable, "-c", self.CHILD, "30"], "", tempfile.gettempdir(), 30, job)
        self.assertEqual(cm.exception.code, "cancelled")
        self.assertIsNotNone(box["h"].pjob)                          # 进了作业对象
        self.assertTrue(wait_until(lambda: box["h"].proc.poll() is not None, timeout=10))


if __name__ == "__main__":
    unittest.main()
