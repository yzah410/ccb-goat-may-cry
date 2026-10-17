# -*- coding: utf-8 -*-
"""标签分档 / 公式（data/tag_tiers.json，GET / PUT /v2/tiers）。"""
from __future__ import annotations

import json
import os
import unittest

from . import base  # noqa: F401  设置临时数据目录
from backend.canvas_logic import TAG_GROUPS
from backend.v2 import router as R, tiers
from backend.v2.tagnote import TAG_GROUPS_ORDERED
from .test_router import body

CUSTOM = {
    "G_1": ["奇幻", "战斗", "校园", "百合", "科幻", "超能力"],
    "G_2": ["音乐", "偶像"],
    "G_3": ["恋爱", "搞笑", "日常", "日本"],
    "G_4": [],
}
FORMULA = {"chars": [{"id": 1, "name": "角色一"}, {"id": 5, "name": "角色五"}]}


class TiersTests(unittest.TestCase):
    def setUp(self):
        self._cleanup()

    def tearDown(self):
        self._cleanup()

    def _cleanup(self):
        if os.path.exists(tiers.path()):
            os.remove(tiers.path())
        tiers.load()

    def test_default_when_no_file(self):
        st, d = body(R.v2_tiers_get())
        self.assertEqual(st, 200)
        self.assertFalse(d["configured"])
        self.assertIsNone(d["formula"])
        self.assertEqual(d["tiers"], tiers.DEFAULT_TIERS)
        self.assertEqual(d["defaults"]["G_1"][:3], ["恋爱", "百合", "战斗"])
        self.assertIn("漫画改", d["fixed"]["G_source"])
        self.assertEqual(TAG_GROUPS["G_1"], set(tiers.DEFAULT_TIERS["G_1"]))

    def test_put_saves_and_applies(self):
        st, d = body(R.v2_tiers_put({"formula": FORMULA, "tiers": CUSTOM}))
        self.assertEqual(st, 200)
        self.assertTrue(d["configured"])
        self.assertEqual(d["formula"], FORMULA)
        self.assertEqual(d["tiers"], CUSTOM)
        # 两份表都原地改了：导图（set）和标签笔记（有序列表）
        self.assertEqual(TAG_GROUPS["G_1"], set(CUSTOM["G_1"]))
        self.assertEqual(TAG_GROUPS["G_4"], set())
        self.assertEqual(TAG_GROUPS_ORDERED["G_3"], CUSTOM["G_3"])
        with open(tiers.path(), encoding="utf-8") as fh:
            saved = json.load(fh)
        self.assertEqual(saved["tiers"], CUSTOM)
        # 重启（重新读文件）以后还是这套
        tiers.load()
        self.assertEqual(body(R.v2_tiers_get())[1]["tiers"], CUSTOM)
        self.assertTrue(body(R.v2_tiers_get())[1]["configured"])

    def test_skip_formula_is_configured(self):
        st, d = body(R.v2_tiers_put({"formula": None, "tiers": tiers.DEFAULT_TIERS}))
        self.assertEqual(st, 200)
        self.assertTrue(d["configured"])
        self.assertIsNone(d["formula"])

    def test_bad_input_rejected_and_nothing_changes(self):
        bad = [
            {"formula": None, "tiers": {"G_1": ["奇幻"], "G_2": [], "G_3": []}},                    # 少一档
            {"formula": None, "tiers": {**CUSTOM, "G_4": ["奇幻"]}},                                 # 一个标签两档
            {"formula": None, "tiers": {**CUSTOM, "G_4": ["漫画改"]}},                               # 来源不能进分档
            {"formula": None, "tiers": {**CUSTOM, "G_4": ["  "]}},                                   # 空标签
            {"formula": None, "tiers": {**CUSTOM, "G_4": ["x" * 41]}},                               # 太长
            {"formula": {"chars": [{"id": 1, "name": "a"}]}, "tiers": CUSTOM},                       # 公式只有 1 人
            {"formula": {"chars": [{"id": 1, "name": "a"}, {"id": 1, "name": "b"}]}, "tiers": CUSTOM},  # 重复
            {"formula": {"chars": [{"id": True, "name": "a"}, {"id": 2, "name": "b"}]}, "tiers": CUSTOM},
            "not a dict",
        ]
        for b in bad:
            st, d = body(R.v2_tiers_put(b))
            self.assertEqual(st, 400, b)
            self.assertEqual(d["error"], "storage")
        self.assertFalse(os.path.exists(tiers.path()))
        self.assertEqual(TAG_GROUPS["G_1"], set(tiers.DEFAULT_TIERS["G_1"]))

    def test_broken_file_falls_back_to_defaults(self):
        os.makedirs(os.path.dirname(tiers.path()), exist_ok=True)
        with open(tiers.path(), "w", encoding="utf-8") as fh:
            fh.write("{not json")
        tiers.load()
        d = body(R.v2_tiers_get())[1]
        self.assertFalse(d["configured"])
        self.assertIn("读不了", d["error"])
        self.assertEqual(d["tiers"], tiers.DEFAULT_TIERS)

    def test_tags_are_trimmed(self):
        t = {**CUSTOM, "G_4": [" 历史 "]}
        d = body(R.v2_tiers_put({"formula": None, "tiers": t}))[1]
        self.assertEqual(d["tiers"]["G_4"], ["历史"])


if __name__ == "__main__":
    unittest.main()
