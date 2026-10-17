# -*- coding: utf-8 -*-
"""引擎：每种来源、每种条件和取反、量词、排除、三种抽题的分布。数字都能对着 synth.py 手算。"""
from __future__ import annotations

import unittest
from collections import Counter

from .base import (BASE_PICK, BASE_POOL, BASE_SRC, HUB, all_with, base_with, engine, ev, one, parse_spec, pool,
                   rng, spec)

MAIN6 = {"roles": ["主角"], "per_work": 6, "order": "heat"}


class TestRankSource(unittest.TestCase):
    def test_top2_2024(self):
        e = ev(spec([one(rng(rank_to=2), MAIN6)]))
        self.assertEqual(set(e.pool), {1, 2, 13, 14, 15, 16, 5, 4})   # 101 前 6 个主角（c17 被截掉）+ 102 的两个主角
        self.assertEqual(e.ranges[0].works, 2)
        self.assertEqual(e.ranges[0].picked, 8)

    def test_tie_break_by_id(self):
        # 102 和 104 同为 900：id 小的排前面
        self.assertEqual(pool(spec([one(rng(rank_from=2, rank_to=2), MAIN6)])), {4, 5})
        self.assertEqual(pool(spec([one(rng(rank_from=3, rank_to=3), MAIN6)])), {6})

    def test_rank_to_null_all_works_and_empty_works_take_slots(self):
        e = ev(spec([one(rng(rank_to=None), MAIN6)]))
        self.assertEqual(e.ranges[0].works, 4)                          # 101 102 104 108（108 没角色也算一部）
        self.assertEqual(set(e.pool), {1, 2, 13, 14, 15, 16, 4, 5, 6})
        # 108 热度只有 10，排第 4；取第 4 名 → 0 人
        self.assertEqual(pool(spec([one(rng(rank_from=4, rank_to=4), MAIN6)])), set())

    def test_per_work_and_order(self):
        self.assertEqual(pool(spec([one(rng(rank_to=1), {"roles": ["主角"], "per_work": None, "order": "heat"})])),
                         {1, 2, 13, 14, 15, 16, 17})
        self.assertEqual(pool(spec([one(rng(rank_to=1), {"roles": ["主角"], "per_work": 1, "order": "heat"})])), {1})
        # 'game' = 角色 id 从小到大（游戏截取的顺序）；'bangumi' 是 'game' 的别名
        self.assertEqual(pool(spec([one(rng(rank_to=1), {"roles": ["主角"], "per_work": 1, "order": "game"})])), {1})
        self.assertEqual(pool(spec([one(rng(rank_to=1), {"roles": ["主角"], "per_work": 1, "order": "bangumi"})])), {1})
        # 102 的两个主角：c4（id 小、热度 50）、c5（热度 800）→ 按游戏顺序取 c4，按热度取 c5
        second = rng(rank_from=2, rank_to=2)
        self.assertEqual(pool(spec([one(second, {"roles": ["主角"], "per_work": 1, "order": "game"})])), {4})
        self.assertEqual(pool(spec([one(second, {"roles": ["主角"], "per_work": 1, "order": "heat"})])), {5})

    def test_roles(self):
        both = pool(spec([one(rng(rank_to=1), {"roles": ["主角", "配角"], "per_work": None})]))
        self.assertEqual(both, {1, 2, 3, 13, 14, 15, 16, 17})           # 客串的 c12 不算
        self.assertEqual(pool(spec([one(rng(rank_to=1), {"roles": ["配角"], "per_work": None})])), {3})

    def test_year_bounds_and_no_date(self):
        # 没日期的作品永远不占名次（游戏的搜索总带日期范围）：105（热度 5000）即使年份两端都不限也不算；
        # 107 未上映也不算 → 第一是 101
        self.assertEqual(pool(spec([one(rng(year_from=None, year_to=None, rank_to=1), MAIN6)])),
                         {1, 2, 13, 14, 15, 16})
        self.assertEqual(pool(spec([one(rng(year_from=2000, year_to=None, rank_to=1), MAIN6)])),
                         {1, 2, 13, 14, 15, 16})

    def test_undated_never_ranked(self):
        snap = HUB.current()
        self.assertEqual([sid for sid, _ in snap.ranked([2], None, None)], [101, 102, 104, 103, 108])
        self.assertNotIn(105, {sid for sid, _ in snap.ranked([2], None, None, include_unaired=True)})
        # 只在没日期的 105 当主角的 c7 不会被「全部动画」范围带进来
        self.assertNotIn(7, pool(spec([one(rng(year_from=None, year_to=None, rank_to=None),
                                           {"roles": ["主角", "配角"], "per_work": None})])))

    def test_unaired_excluded_by_default(self):
        e = ev(spec([one(rng(year_from=2026, year_to=2026, rank_to=None), MAIN6)]))
        self.assertEqual(e.ranges[0].works, 0)
        self.assertEqual(pool(spec([one(rng(year_from=2026, year_to=2026, rank_to=None, include_unaired=True), MAIN6)])),
                         {9})

    def test_nsfw_not_ranked(self):
        self.assertEqual(ev(spec([one(rng(year_from=2025, year_to=2025, rank_to=None), MAIN6)])).ranges[0].works, 0)

    def test_per_year(self):
        e = ev(spec([one(rng(year_from=2023, year_to=2024, rank_to=1, rank_scope="per_year"), MAIN6)]))
        self.assertEqual(e.ranges[0].works, 2)
        self.assertEqual(set(e.pool), {5, 1, 2, 13, 14, 15, 16})
        merged = ev(spec([one(rng(year_from=2023, year_to=2024, rank_to=1), MAIN6)]))
        self.assertEqual(merged.ranges[0].works, 1)

    def test_work_filter_filters_before_ranking(self):
        # 先筛再排：带「战斗」的只有 102 → 第一名就是 102（如果先排再筛，第一名 101 会被筛掉 → 0 人）
        wf = {"quant": "any", "tags": ["战斗"]}
        self.assertEqual(pool(spec([one(rng(rank_to=1, work_filter=wf), MAIN6)])), {4, 5})
        wf = {"quant": "any", "tags": ["百合"]}                         # 101（100/100）和 102（20/80 ≥ 10%）都是主要标签
        self.assertEqual(ev(spec([one(rng(rank_to=None, work_filter=wf), MAIN6)])).ranges[0].works, 2)

    def test_work_filter_after_rank_option(self):
        # 可选的「先排名再筛」：2024 第 1 名是 101（不带战斗）→ 0 部；前 2 名里带战斗的只有 102
        wf = {"quant": "any", "tags": ["战斗"]}
        e = ev(spec([one(rng(rank_to=1, work_filter=wf, work_filter_order="after_rank"), MAIN6)]))
        self.assertEqual((e.ranges[0].works, len(e.pool)), (0, 0))
        self.assertEqual(pool(spec([one(rng(rank_to=2, work_filter=wf, work_filter_order="after_rank"), MAIN6)])), {4, 5})

    def test_work_filter_tag_modes_and_quants(self):
        main = {"quant": "any", "tags": ["校园"], "tag_mode": "main"}     # 101 的校园只有 5/100，不是主要标签
        anyt = {"quant": "any", "tags": ["校园"], "tag_mode": "any"}
        self.assertEqual(ev(spec([one(rng(rank_to=None, work_filter=main), MAIN6)])).ranges[0].works, 0)
        self.assertEqual(ev(spec([one(rng(rank_to=None, work_filter=anyt), MAIN6)])).ranges[0].works, 1)
        none = {"quant": "none", "tags": ["百合"]}
        self.assertEqual(pool(spec([one(rng(rank_to=1, work_filter=none), MAIN6)])), {6})     # 104
        both = {"quant": "all", "tags": ["百合", "战斗"]}
        self.assertEqual(pool(spec([one(rng(rank_to=None, work_filter=both), MAIN6)])), {4, 5})
        k2 = {"quant": "at_least", "k": 2, "tags": ["百合", "日常", "战斗"]}
        self.assertEqual(ev(spec([one(rng(rank_to=None, work_filter=k2), MAIN6)])).ranges[0].works, 2)

    def test_work_filter_meta_tags(self):
        games = rng(subject_types=[4], year_from=None, year_to=None, rank_to=1)
        self.assertEqual(pool(spec([one(games, MAIN6)])), {11})                     # 202 热度最高
        games["work_filter"] = {"quant": "any", "tags": ["Galgame"], "tag_mode": "meta"}
        self.assertEqual(pool(spec([one(games, MAIN6)])), {10})                     # 公共标签 Galgame 只有 201

    def test_multiple_types_merged(self):
        src = rng(subject_types=[2, 4], year_from=None, year_to=None, rank_to=3)
        # 202(1500) 101(1000) 102(900，和 104 同分、id 小)；没日期的 105 不算
        self.assertEqual(ev(spec([one(src, {"roles": ["主角"], "per_work": 1})])).pool, {11, 1, 5})


class TestOtherSources(unittest.TestCase):
    def test_work_list(self):
        e = ev(spec([one({"kind": "work_list", "list_id": "l_w"}, MAIN6)]))
        self.assertEqual(e.ranges[0].works, 2)                                        # 101 + 按名字对上的 104
        self.assertEqual(set(e.pool), {1, 2, 13, 14, 15, 16, 6})

    def test_char_list(self):
        e = ev(spec([one({"kind": "char_list", "list_id": "l_c"})]))
        self.assertEqual(set(e.pool), {1, 5})
        self.assertTrue(any("不在角色库" in w for w in e.warnings))

    def test_all_characters(self):
        self.assertEqual(len(pool(spec([one({"kind": "all_characters"})]))), 17)

    def test_missing_list(self):
        e = ev(spec([one({"kind": "work_list", "list_id": "l_nope"})]))
        self.assertEqual(len(e.pool), 0)
        self.assertIn("不存在", e.ranges[0].error)

    def test_wrong_list_kind(self):
        e = ev(spec([one({"kind": "char_list", "list_id": "l_t"})]))
        self.assertIn("标签清单", e.ranges[0].error)


class TestConditions(unittest.TestCase):
    def test_base(self):
        self.assertEqual(pool(base_with()), BASE_POOL)

    def test_gender(self):
        self.assertEqual(pool(base_with({"type": "gender", "values": ["女"]})), {1, 2, 13, 14, 15, 16, 17, 5})
        self.assertEqual(pool(base_with({"type": "gender", "values": ["女"], "negate": True})), {3, 4, 6})
        self.assertEqual(pool(base_with({"type": "gender", "values": ["未知"]})), {4})

    def test_char_heat(self):
        self.assertEqual(pool(base_with({"type": "char_heat", "min": 100})), {1, 2, 3, 5})       # 含等号
        self.assertEqual(pool(base_with({"type": "char_heat", "max": 50})), {4, 6, 13, 14, 15, 16, 17})
        self.assertEqual(pool(base_with({"type": "char_heat", "min": 100, "negate": True})), BASE_POOL - {1, 2, 3, 5})

    def test_game_tags_quantifiers(self):
        gt = lambda **k: {"type": "game_tags", **k}  # noqa: E731
        self.assertEqual(pool(base_with(gt(quant="any", tags=["百合"]))), BASE_POOL - {6})
        self.assertEqual(pool(base_with(gt(quant="all", tags=["百合", "日常"]))), {1, 2, 3, 5})
        self.assertEqual(pool(base_with(gt(quant="at_least", k=2, tags=["百合", "日常", "战斗"]))), {1, 2, 3, 4, 5})
        self.assertEqual(pool(base_with(gt(quant="none", tags=["百合"]))), {6})
        self.assertEqual(pool(base_with(gt(quant="any", tags=["百合"], negate=True))), {6})
        self.assertEqual(pool(base_with(gt(quant="all", tags=["百合", "日常"], negate=True))), BASE_POOL - {1, 2, 3, 5})
        self.assertEqual(pool(base_with(gt(quant="none", tags=["百合"], negate=True))), BASE_POOL - {6})
        self.assertEqual(pool(base_with(gt(quant="at_least", k=4, tags=["百合", "日常", "战斗"]))), set())   # k > 标签数

    def test_game_tags_tag_list(self):
        c = {"type": "game_tags", "quant": "at_least", "k": 2, "tags": [], "tag_list_id": "l_t"}
        self.assertEqual(pool(base_with(c)), {1, 2, 3, 4, 5})

    def test_game_tags_depend_on_n_and_cut(self):
        c = {"type": "game_tags", "quant": "any", "tags": ["百合"]}
        # n=2：c3 的百合排第 3、c5 的百合排第 3 → 不显示
        self.assertEqual(pool(base_with(c, n=2)), {1, 2, 4, 13, 14, 15, 16, 17})
        # n=1：c2 的 cut=2 → 显示前 max(2,1)=2 个（含「日常」）；c1 的 cut=-1 → 只显示 1 个
        d = {"type": "game_tags", "quant": "any", "tags": ["日常"]}
        self.assertEqual(pool(base_with(d, n=1)), {2, 3})

    def test_unknown_tag_warning(self):
        e = ev(base_with({"type": "game_tags", "quant": "any", "tags": ["百合番"]}))
        self.assertEqual(len(e.pool), 0)
        self.assertTrue(any("『百合番』在库里不存在" in w and "百合" in w for w in e.warnings), e.warnings)

    def test_char_tags(self):
        self.assertEqual(pool(base_with({"type": "char_tags", "quant": "any", "tags": ["黑长直"]})), {1, 5})
        self.assertEqual(pool(base_with({"type": "char_tags", "quant": "all", "tags": ["黑长直", "双马尾"]})), {5})

    def test_va(self):
        self.assertEqual(pool(base_with({"type": "va", "names": ["声优A"]})), {1, 5})
        self.assertEqual(pool(base_with({"type": "va", "names": [" 声优b "]})), {2})            # 不分大小写、去空格
        self.assertEqual(pool(base_with({"type": "va", "names": ["声优A"], "negate": True})), BASE_POOL - {1, 5})

    def test_source_tag(self):
        self.assertEqual(pool(base_with({"type": "source_tag", "values": ["原创"]})), {3, 4, 5})
        self.assertEqual(pool(base_with({"type": "source_tag", "values": ["原创"], "negate": True})), BASE_POOL - {3, 4, 5})

    def test_numeric(self):
        self.assertEqual(pool(base_with({"type": "n_app", "min": 2})), {5})
        self.assertEqual(pool(base_with({"type": "earliest_year", "max": 2023})), {5})
        self.assertEqual(pool(base_with({"type": "latest_year", "min": 2024})), BASE_POOL)
        self.assertEqual(pool(base_with({"type": "rating", "min": 7.5})), {1, 2, 3, 5, 13, 14, 15, 16, 17})

    def test_no_profile_numeric_fails_negate_passes(self):
        # c7 没有画像行，c9 的 n_app = 0：数值条件一律不满足，取反后满足
        self.assertEqual(pool(all_with({"type": "n_app", "min": 0})), set(range(1, 18)) - {7, 9})
        self.assertEqual(pool(all_with({"type": "n_app", "min": 0, "negate": True})), {7, 9})
        # 标签类：没画像 = 空集合 → 「都不含」满足
        self.assertTrue({7, 9} <= pool(all_with({"type": "game_tags", "quant": "none", "tags": ["百合"]})))

    def test_appearance(self):
        ap = lambda **k: {"type": "appearance", **k}  # noqa: E731
        self.assertEqual(pool(all_with(ap(subject_types=[2], year_from=2023, year_to=2023, roles=["主角"]))), {5})
        self.assertEqual(pool(all_with(ap(subject_types=[2], year_from=2023, year_to=2023, roles=["配角"]))), {8})
        self.assertEqual(pool(all_with(ap(year_from=2025, year_to=2025))), set())                 # 只有 NSFW 的 106
        self.assertEqual(pool(all_with(ap(roles=["客串"]))), {12})
        wt = ap(subject_types=[2], roles=["主角"], work_tags={"quant": "any", "tags": ["百合"]})
        self.assertEqual(pool(all_with(wt)), {1, 2, 13, 14, 15, 16, 17, 4, 5})
        self.assertEqual(pool(all_with(ap(roles=["主角"], work_list_id="l_w"))), {1, 2, 13, 14, 15, 16, 17, 6})
        self.assertEqual(pool(all_with(ap(subject_types=[2], year_from=2023, year_to=2023, roles=["主角"], negate=True))),
                         set(range(1, 18)) - {5})

    def test_char_list_condition(self):
        self.assertEqual(pool(base_with({"type": "char_list", "list_id": "l_c"})), {1, 5})
        self.assertEqual(pool(base_with({"type": "char_list", "list_id": "l_c", "negate": True})), BASE_POOL - {1, 5})

    def test_sql_condition(self):
        self.assertEqual(pool(base_with({"type": "sql", "sql": "SELECT id FROM character WHERE heat >= 400"})), {1, 5})
        e = ev(base_with({"type": "sql", "sql": "SELECT nope FROM character"}))
        self.assertEqual(set(e.pool), BASE_POOL)                         # 出错的条件跳过，不筛人
        self.assertEqual(e.ranges[0].steps[0]["skipped"], "error")
        self.assertIn("自定义查询出错", e.ranges[0].error)

    def test_empty_and_disabled_conditions_skipped(self):
        e = ev(base_with({"type": "game_tags", "quant": "any", "tags": []},
                         {"type": "gender", "values": ["男"], "enabled": False}))
        self.assertEqual(set(e.pool), BASE_POOL)
        self.assertEqual([s["skipped"] for s in e.ranges[0].steps], ["empty", "disabled"])

    def test_steps_record_removed(self):
        e = ev(base_with({"id": "c_g", "type": "gender", "values": ["女"]},
                         {"id": "c_t", "type": "game_tags", "quant": "all", "tags": ["百合", "日常"]}))
        s = e.ranges[0].steps
        self.assertEqual((s[0]["condition_id"], s[0]["before"], s[0]["after"], s[0]["removed"]), ("c_g", 11, 8, 3))
        self.assertEqual((s[1]["condition_id"], s[1]["before"], s[1]["after"], s[1]["removed"]), ("c_t", 8, 3, 5))
        self.assertEqual(set(e.pool), {1, 2, 5})

    def test_final_set_independent_of_order(self):
        a = pool(base_with({"type": "gender", "values": ["女"]}, {"type": "game_tags", "quant": "all", "tags": ["百合", "日常"]}))
        b = pool(base_with({"type": "game_tags", "quant": "all", "tags": ["百合", "日常"]}, {"type": "gender", "values": ["女"]}))
        self.assertEqual(a, b)


class TestUnionExclude(unittest.TestCase):
    def test_union_minus_excludes(self):
        sp = spec([one(rng(rank_to=1), MAIN6, id="r1"), one(rng(year_from=2023, year_to=2023, rank_to=1), MAIN6, id="r2")],
                  excludes=[one({"kind": "char_list", "list_id": "l_c"}, id="x1")])
        e = ev(sp)
        self.assertEqual(set(e.pool), {2, 13, 14, 15, 16})
        resp = e.to_response()
        self.assertEqual(resp["total"], 5)
        self.assertEqual([r["unique"] for r in resp["ranges"]], [5, 0])
        self.assertEqual(resp["excludes"][0]["matched"], 2)
        self.assertEqual(resp["excludes"][0]["removed_from_pool"], 2)

    def test_unique_with_overlap(self):
        sp = spec([one(rng(year_from=2023, year_to=2023, rank_to=1), MAIN6, id="a"),
                   one(rng(rank_from=2, rank_to=2), MAIN6, id="b")])
        resp = ev(sp).to_response()
        self.assertEqual(resp["total"], 2)                              # {5} ∪ {4,5}
        self.assertEqual([r["unique"] for r in resp["ranges"]], [0, 1])

    def test_disabled_range_and_exclude(self):
        sp = spec([one(rng(rank_to=1), MAIN6, enabled=False), one(rng(rank_from=2, rank_to=2), MAIN6)],
                  excludes=[one({"kind": "char_list", "list_id": "l_c"}, enabled=False)])
        e = ev(sp)
        self.assertEqual(set(e.pool), {4, 5})
        self.assertEqual(e.to_response()["ranges"][0]["final"], 6)      # 停用的范围照算，但不进题库

    def test_exclude_with_conditions(self):
        sp = spec([one(BASE_SRC, BASE_PICK)], excludes=[one({"kind": "all_characters"}, None,
                                                            [{"type": "gender", "values": ["女"]}])])
        self.assertEqual(pool(sp), {3, 4, 6})

    def test_no_ranges(self):
        e = ev(spec([]))
        self.assertEqual(len(e.pool), 0)
        self.assertTrue(e.warnings)


class TestDraw(unittest.TestCase):
    def test_reproducible(self):
        e = ev(spec([one(rng(rank_to=2), MAIN6)]))
        self.assertEqual(engine.draw(e, 123, "per_character"), engine.draw(e, 123, "per_character"))
        cid, rid, work, seed = engine.draw(e, None, "per_character")
        self.assertIn(cid, e.pool)
        self.assertEqual(engine.draw(e, seed, "per_character")[0], cid)

    def test_empty_pool(self):
        e = ev(spec([one(rng(year_from=2025, year_to=2025), MAIN6)]))
        self.assertIsNone(engine.draw(e, 1, "per_character")[0])

    def test_per_character_uniform(self):
        e = ev(spec([one(rng(rank_to=2), MAIN6)]))                      # 8 人
        cnt = Counter(engine.draw(e, s, "per_character")[0] for s in range(8000))
        self.assertEqual(set(cnt), set(e.pool))
        for cid, n in cnt.items():
            self.assertTrue(850 <= n <= 1150, (cid, n))

    def test_per_work(self):
        # 101 有 6 人、102 有 2 人：先抽作品（各 1/2）再抽人 → c4、c5 各约 1/4，101 的每人约 1/12
        e = ev(spec([one(rng(rank_to=2), MAIN6)], method="per_work"))
        N = 12000
        cnt = Counter(engine.draw(e, s, "per_work")[0] for s in range(N))
        for cid in (4, 5):
            self.assertTrue(abs(cnt[cid] / N - 0.25) < 0.02, (cid, cnt[cid]))
        for cid in (1, 2, 13, 14, 15, 16):
            self.assertTrue(abs(cnt[cid] / N - 1 / 12) < 0.015, (cid, cnt[cid]))
        # 抽到的作品就是绑定作品
        cid, rid, work, _ = engine.draw(e, 7, "per_work")
        self.assertIn(work, (101, 102))

    def test_range_share(self):
        sp = spec([one(rng(rank_to=1), MAIN6, id="big", share=3),
                   one(rng(year_from=2023, year_to=2023, rank_to=1), MAIN6, id="small", share=1)], method="range_share")
        e = ev(sp)
        N = 8000
        res = [engine.draw(e, s, "range_share") for s in range(N)]
        by_range = Counter(r[1] for r in res)
        self.assertTrue(abs(by_range["big"] / N - 0.75) < 0.02, by_range)
        self.assertTrue(abs(Counter(r[0] for r in res)[5] / N - 0.25) < 0.02)

    def test_range_share_skips_empty_after_exclude(self):
        sp = spec([one(rng(rank_to=1), MAIN6, id="a", share=1),
                   one({"kind": "char_list", "list_id": "l_c"}, None, id="b", share=100)],
                  excludes=[one({"kind": "char_list", "list_id": "l_c"})], method="range_share")
        e = ev(sp)
        self.assertEqual({engine.draw(e, s, "range_share")[1] for s in range(200)}, {"a"})


class TestEmptyGridWarning(unittest.TestCase):
    """题库里当前模式下登场数为 0 的人（格子为空）：不删，给提示，并在 empty_grid 里给人数。"""

    def test_all_characters_source(self):
        e = ev(spec([one({"kind": "all_characters"})]))
        self.assertIn(7, e.pool)                                   # c7 没有画像行
        self.assertIn(9, e.pool)                                   # c9 登场数 0
        self.assertEqual(e.to_response()["empty_grid"], 2)
        self.assertIn("题库里有 2 人在当前模式下游戏格子为空（登场数 0），抽到会出没意义的题", e.warnings)

    def test_normal_range_no_warning(self):
        e = ev(spec([one(rng(rank_to=2), {"roles": ["主角"], "per_work": 6, "order": "heat"})]))
        self.assertEqual(e.to_response()["empty_grid"], 0)
        self.assertFalse(any("格子为空" in w for w in e.warnings))

    def test_excluded_ones_not_counted(self):
        e = ev(spec([one({"kind": "all_characters"})],
                    excludes=[one({"kind": "all_characters"}, None, [{"type": "n_app", "min": 0, "negate": True}])]))
        self.assertEqual(e.to_response()["empty_grid"], 0)          # 把格子为空的排除掉之后就没有提示了
        self.assertNotIn(7, e.pool)


class TestItemsAndStats(unittest.TestCase):
    def test_build_item_fields(self):
        e = ev(spec([one(rng(rank_to=2), MAIN6)]))
        it = engine.build_item(e, 5)
        for k in ("char_id", "character", "mode", "weight", "bound_work", "appearances", "work_tags", "char_tags",
                  "source_tag", "grid", "vas", "ranges", "appear_count", "appear_best", "playback_tags"):
            self.assertIn(k, it)
        self.assertEqual(it["mode"], "char-weight")
        self.assertEqual(it["character"]["gender"], "♀")
        self.assertEqual(it["bound_work"]["id"], 102)
        self.assertEqual(it["appearances"], ["战斗番", "日常番2023"])
        self.assertEqual(it["grid"]["tags"], ["战斗", "日常", "百合"])
        self.assertEqual(it["vas"], ["声优A", "声优C"])

    def test_candidates_sort_and_q(self):
        e = ev(spec([one(rng(rank_to=2), MAIN6)]))
        ids = engine.candidate_ids(e, "heat")
        self.assertEqual(ids[:3], [5, 1, 2])
        self.assertEqual(engine.candidate_ids(e, "random", seed=3), engine.candidate_ids(e, "random", seed=3))
        self.assertEqual(engine.candidate_ids(e, "heat", q="角色五"), [5])
        self.assertEqual(set(engine.candidate_ids(e, "heat", q="战斗番")), {4, 5})   # 绑定作品名也能搜

    def test_stats_shape(self):
        st = engine.compute_stats(ev(spec([one(rng(rank_to=2), MAIN6)])))
        for k in ("total", "by_year", "by_gender", "top_work_tags", "top_char_tags", "playback", "source", "year_min",
                  "year_max", "avg_score", "no_year", "elapsed_ms"):
            self.assertIn(k, st)
        self.assertEqual(st["total"], 8)
        self.assertEqual(st["by_gender"], {"♀": 7, "♂": 0, "?": 1})
        self.assertEqual(st["year_min"], 2023)


if __name__ == "__main__":
    unittest.main()
