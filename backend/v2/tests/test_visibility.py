# -*- coding: utf-8 -*-
"""subject.search_visible / anon_detail 两列：
- 热度排名、作品本身的标签筛选（work_filter）、标签词表、作品补全 → 只算 search_visible = 1；
- 登场作品条件、per_work 的绑定作品、「角色有没有登场作品」→ 只算 anon_detail = 1 且不是 locked（和库里画像同一规则）；
- 库里没有这两列 → 退回 nsfw = 0。
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from . import base, synth
from backend.v2 import engine, schema_doc
from backend.v2 import router as R
from backend.v2.spec import parse_spec
from backend.v2.storage import LISTS
from backend.v2.store import HUB, S_COUNTS, S_VISIBLE, open_ro

WITH_COLS = os.path.join(base.TMP, "vis_with_cols.sqlite")
NO_COLS = os.path.join(base.TMP, "vis_no_cols.sqlite")
synth.build(WITH_COLS, variant="visibility")
synth.build(NO_COLS, variant="visibility_nocols")
MAIN6 = {"roles": ["主角"], "per_work": 6, "order": "heat"}


def on(path):
    return mock.patch.dict(os.environ, {"OUTSETTER_V2_DB": path})


def pool(sp):
    return set(engine.evaluate(parse_spec(sp), use_cache=False).pool)


APPEAR_2024_MAIN = [{"type": "appearance", "subject_types": [2], "year_from": 2024, "year_to": 2024, "roles": ["主角"]}]


class TestRanking(unittest.TestCase):
    def test_hidden_subjects_take_no_rank_slot(self):
        with on(WITH_COLS):
            snap = HUB.current()
            self.assertEqual(snap.visible_col, "search_visible")
            self.assertEqual([sid for sid, _ in snap.ranked([2], 2024, 2024)], [101, 102, 104, 108])
            self.assertEqual(pool(base.spec([base.one(base.rng(rank_to=2), MAIN6)])), {1, 2, 13, 14, 15, 16, 4, 5})

    def test_db_without_visibility_columns_falls_back_to_nsfw(self):
        with on(NO_COLS):
            snap = HUB.current()
            self.assertEqual(snap.visible_col, "nsfw")
            # 没有这两列的库：109（locked）、110（404）都是 nsfw = 0 → 也进排名
            self.assertEqual([sid for sid, _ in snap.ranked([2], 2024, 2024)], [101, 110, 109, 102, 104, 108])
            self.assertEqual(pool(base.spec([base.one(base.rng(rank_to=2), MAIN6)])),
                             {1, 2, 13, 14, 15, 16, 12, 18})

    def test_work_filter_uses_visible_subjects(self):
        wf = {"quant": "any", "tags": ["战斗"]}
        with on(WITH_COLS):
            e = engine.evaluate(parse_spec(base.spec([base.one(base.rng(rank_to=None, work_filter=wf), MAIN6)])),
                                use_cache=False)
            self.assertEqual(e.ranges[0].works, 1)          # 只有 102；locked 的 109 不算
        with on(NO_COLS):
            e = engine.evaluate(parse_spec(base.spec([base.one(base.rng(rank_to=None, work_filter=wf), MAIN6)])),
                                use_cache=False)
            self.assertEqual(e.ranges[0].works, 2)          # 没有这两列的库：102 + 109


class TestAppearanceCounts(unittest.TestCase):
    def test_flags(self):
        with on(WITH_COLS):
            S = HUB.current().S
            self.assertEqual((S[101][S_COUNTS], S[101][S_VISIBLE]), (1, 1))
            self.assertEqual((S[109][S_COUNTS], S[109][S_VISIBLE]), (0, 0))   # locked：能拿详情，但游戏不算
            self.assertEqual((S[110][S_COUNTS], S[110][S_VISIBLE]), (0, 0))   # 匿名 404
            self.assertEqual((S[106][S_COUNTS], S[106][S_VISIBLE]), (0, 0))   # NSFW
        with on(NO_COLS):
            S = HUB.current().S
            self.assertEqual((S[110][S_COUNTS], S[110][S_VISIBLE]), (1, 1))
            self.assertEqual(S[109][S_COUNTS], 0)                              # 没有这两列的库也看 locked 列

    def test_appearance_condition(self):
        base_pool = {1, 2, 4, 5, 6, 13, 14, 15, 16, 17}                        # 2024 年能算登场的动画里的主角
        with on(WITH_COLS):
            self.assertEqual(pool(base.all_with(*APPEAR_2024_MAIN)), base_pool)          # c11（109）、c12 c18（110）不算
        with on(NO_COLS):
            self.assertEqual(pool(base.all_with(*APPEAR_2024_MAIN)), base_pool | {12, 18})  # 没有这两列的库：110 按 nsfw=0 算

    def test_best_work_and_per_work_binding(self):
        LISTS.save({"name": "只在 404 条目登场", "kind": "character", "items": [{"id": 18}, {"id": 12}]}, list_id="l_c18")
        try:
            with on(WITH_COLS):
                snap = HUB.current()
                self.assertIsNone(snap.best_work(18))                           # 没有游戏算的登场作品
                self.assertEqual(snap.best_work(12), 101)                       # 101（客串）能算；110 不算
                sp = base.spec([base.one({"kind": "char_list", "list_id": "l_c18"})], method="per_work")
                ev = engine.evaluate(parse_spec(sp), use_cache=False)
                self.assertIsNone(engine.build_item(ev, 18)["bound_work"])
                works = {engine.draw(ev, s, "per_work")[2] for s in range(200)}
                self.assertEqual(works, {None, 101})                            # c18 自成一组，c12 归到 101
            with on(NO_COLS):
                self.assertEqual(HUB.current().best_work(18), 110)
        finally:
            LISTS.delete("l_c18")


class TestVocabularyAndSuggest(unittest.TestCase):
    def test_tag_counts(self):
        with on(WITH_COLS):
            snap = HUB.current()
            self.assertEqual(snap.work_tag_counts().get("战斗"), 1)            # 102；不算 locked 的 109
            self.assertEqual(snap.work_tag_counts().get("百合"), 2)            # 101、102；不算 NSFW 的 106、404 的 110
            self.assertNotIn("测试公共", snap.meta_tag_counts())
        with on(NO_COLS):
            snap = HUB.current()
            self.assertEqual(snap.work_tag_counts().get("战斗"), 2)
            self.assertEqual(snap.work_tag_counts().get("百合"), 3)
            self.assertEqual(snap.meta_tag_counts().get("测试公共"), 1)

    def test_work_suggest(self):
        with on(WITH_COLS):
            d = R.v2_suggest(kind="work", q="的番", mode="anime", limit=50, n=6)
            ids = {x["id"] for x in d}
            self.assertNotIn(109, ids)
            self.assertNotIn(110, ids)
            self.assertEqual(ids, {105, 107})                   # 「没日期的番」「还没播的番」：搜索可见
        with on(NO_COLS):
            ids = {x["id"] for x in R.v2_suggest(kind="work", q="的番", mode="anime", limit=50, n=6)}
            self.assertTrue({109, 110} <= ids)

    def test_schema_doc_uses_search_visible(self):
        for path, expect in ((WITH_COLS, "search_visible = 1"), (NO_COLS, "nsfw = 0")):
            conn = open_ro(path)
            try:
                sc = schema_doc.build_schema(conn)
            finally:
                conn.close()
            self.assertIn(expect, sc["examples"][0]["sql"])
            self.assertTrue(any(expect in n for n in sc["notes"]))

    def test_meta_reports_rule(self):
        with on(WITH_COLS):
            self.assertEqual(R.v2_meta()["db"]["counts"]["visibility_rule"], {"rank": "search_visible", "appearance": "anon_detail"})
        with on(NO_COLS):
            self.assertEqual(R.v2_meta()["db"]["counts"]["visibility_rule"], {"rank": "nsfw", "appearance": "nsfw"})


def tearDownModule():
    HUB.current()          # 换回测试基准库


if __name__ == "__main__":
    unittest.main()
