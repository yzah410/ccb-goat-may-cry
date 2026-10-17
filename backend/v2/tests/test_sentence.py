# -*- coding: utf-8 -*-
"""自动生成的一句中文：取反、各种量词、清单、年份只有一边、rank_to 为空……都要读得通。"""
from __future__ import annotations

import unittest

from . import base  # noqa: F401  （设置环境变量 + 建测试清单）
from backend.v2.sentence import condition_phrase, describe_changes, range_sentence
from backend.v2.spec import RangeV2, default_spec, parse_spec
from backend.v2.storage import LISTS


def S(r: dict) -> str:
    return range_sentence(RangeV2.model_validate(r), LISTS.get)


def C(c: dict) -> str:
    r = RangeV2.model_validate({"conditions": [c]})
    return condition_phrase(r.conditions[0], LISTS.get)


class TestRangeSentence(unittest.TestCase):
    def test_default(self):
        sp = parse_spec(default_spec())
        y = sp.ranges[0].source.year_to
        self.assertEqual(range_sentence(sp.ranges[0], LISTS.get), f"{y - 10}–{y} 年热度前 50 部动画的主角")

    def test_typical_example(self):
        r = {"source": {"year_from": 2016, "year_to": 2026}, "pick": {"roles": ["主角"], "per_work": 6, "order": "heat"},
             "conditions": [{"type": "game_tags", "quant": "all", "tags": ["百合", "日常"]}]}
        self.assertEqual(S(r), "2016–2026 年热度前 50 部动画的主角里（每部最多 6 人，按角色热度），作品标签同时含『百合』『日常』的角色")
        r.pop("pick")                                   # 默认：只要主角、每部不限 → 不写括号
        self.assertEqual(S(r), "2016–2026 年热度前 50 部动画的主角里，作品标签同时含『百合』『日常』的角色")

    def test_years_and_ranks(self):
        src = lambda **k: {"source": {"kind": "rank", **k}}  # noqa: E731
        self.assertTrue(S(src(year_from=2024, year_to=2024)).startswith("2024 年热度前 50 部动画"))
        self.assertTrue(S(src(year_from=2016, year_to=None)).startswith("2016 年及以后热度前 50 部动画"))
        self.assertTrue(S(src(year_from=None, year_to=2010)).startswith("2010 年及以前热度前 50 部动画"))
        self.assertTrue(S(src(year_from=None, year_to=None)).startswith("热度前 50 部动画"))
        self.assertTrue(S(src(year_from=2024, year_to=2024, rank_to=None)).startswith("2024 年的全部动画的主角"))
        self.assertTrue(S(src(year_from=None, year_to=None, rank_to=None)).startswith("全部动画的主角"))
        self.assertTrue(S(src(year_from=2024, year_to=2024, rank_from=51, rank_to=100)).startswith("2024 年热度第 51–100 名的动画"))
        self.assertTrue(S(src(year_from=2024, year_to=2024, rank_from=101, rank_to=None)).startswith("2024 年热度第 101 名及以后的动画"))
        self.assertTrue(S(src(year_from=2016, year_to=2026, rank_scope="per_year")).startswith("2016–2026 年每年热度前 50 部动画"))
        self.assertTrue(S(src(year_from=2016, year_to=2026, rank_to=1000)).startswith("2016–2026 年热度前 1,000 部动画"))
        self.assertTrue(S(src(subject_types=[2, 4], year_from=2024, year_to=2024)).startswith("2024 年热度前 50 部动画和游戏"))

    def test_work_filter(self):
        r = {"source": {"subject_types": [4], "year_from": 2016, "year_to": 2026,
                        "work_filter": {"quant": "any", "tags": ["Galgame"], "tag_mode": "meta"}}}
        self.assertEqual(S(r), "2016–2026 年带『Galgame』公共标签的游戏中热度前 50 部的主角")
        r["source"]["rank_to"] = None
        self.assertTrue(S(r).startswith("2016–2026 年所有带『Galgame』公共标签的游戏的主角"))
        after = {"source": {"year_from": 2016, "year_to": 2026, "work_filter": {"tags": ["战斗"]},
                            "work_filter_order": "after_rank"}}
        self.assertEqual(S(after), "2016–2026 年热度前 50 部动画中带『战斗』标签的作品的主角")

    def test_pick(self):
        r = {"source": {"year_from": 2024, "year_to": 2024}, "pick": {"roles": ["主角", "配角"], "per_work": None}}
        self.assertEqual(S(r), "2024 年热度前 50 部动画的主角和配角")
        r["pick"] = {"roles": ["主角"], "per_work": 3, "order": "game"}
        self.assertEqual(S(r), "2024 年热度前 50 部动画的主角（每部最多 3 人，按游戏的顺序）")
        r["pick"] = {"roles": ["主角"], "per_work": 3, "order": "bangumi"}              # 'bangumi' 是 'game' 的别名
        self.assertEqual(S(r), "2024 年热度前 50 部动画的主角（每部最多 3 人，按游戏的顺序）")
        r["pick"] = {"roles": ["主角", "配角"]}                                          # 没给人数：带配角 → 6
        self.assertEqual(S(r), "2024 年热度前 50 部动画的主角和配角（每部最多 6 人，按角色热度）")

    def test_other_sources(self):
        self.assertEqual(S({"source": {"kind": "char_list", "list_id": "l_c"}}), "角色清单『测试角色清单』里的全部角色")
        self.assertEqual(S({"source": {"kind": "char_list", "list_id": "l_c"},
                            "conditions": [{"type": "gender", "values": ["女"]}]}), "角色清单『测试角色清单』里，性别为女的角色")
        self.assertEqual(S({"source": {"kind": "all_characters"}}), "整个角色库的所有角色")
        self.assertEqual(S({"source": {"kind": "all_characters"}, "conditions": [{"type": "char_list", "list_id": "l_c"}]}),
                         "整个角色库里，在角色清单『测试角色清单』里的角色")
        self.assertEqual(S({"source": {"kind": "work_list", "list_id": "l_w"}}), "作品清单『测试作品清单』中各部作品的主角")
        self.assertTrue(S({"source": {"kind": "work_list", "list_id": "l_gone"}}).startswith("作品清单 l_gone（已不存在）中各部作品"))
        self.assertEqual(C({"type": "char_list", "list_id": "l_gone"}), "在角色清单 l_gone（已不存在）里")

    def test_disabled_and_empty_conditions_not_in_sentence(self):
        r = {"source": {"year_from": 2024, "year_to": 2024},
             "conditions": [{"type": "gender", "values": ["女"], "enabled": False}, {"type": "game_tags", "tags": []}]}
        self.assertEqual(S(r), "2024 年热度前 50 部动画的主角")

    def test_multiple_conditions_joined(self):
        r = {"source": {"year_from": 2024, "year_to": 2024},
             "conditions": [{"type": "gender", "values": ["女"]}, {"type": "game_tags", "tags": ["战斗"]}]}
        self.assertEqual(S(r), "2024 年热度前 50 部动画的主角里，性别为女、作品标签含『战斗』的角色")


class TestConditionPhrase(unittest.TestCase):
    def test_game_tags_quantifiers(self):
        g = lambda **k: C({"type": "game_tags", **k})  # noqa: E731
        self.assertEqual(g(tags=["百合"]), "作品标签含『百合』")
        self.assertEqual(g(tags=["百合", "GL"]), "作品标签含『百合』或『GL』")
        self.assertEqual(g(tags=["A", "B", "C"]), "作品标签含『A』『B』『C』中的任意一个")
        self.assertEqual(g(quant="all", tags=["百合", "日常"]), "作品标签同时含『百合』『日常』")
        self.assertEqual(g(quant="all", tags=["百合"]), "作品标签含『百合』")
        self.assertEqual(g(quant="at_least", k=2, tags=["A", "B", "C"]), "作品标签至少含『A』『B』『C』中的 2 个")
        self.assertEqual(g(quant="none", tags=["BL"]), "作品标签不含『BL』")
        self.assertEqual(g(quant="none", tags=["BL", "乙女"]), "作品标签既不含『BL』也不含『乙女』")
        self.assertEqual(g(quant="at_least", k=4, tags=[], tag_list_id="l_t"), "作品标签至少含清单『测试标签清单』里的 4 个标签")
        self.assertEqual(g(quant="any", tags=[], tag_list_id="l_t"), "作品标签含清单『测试标签清单』里的任意一个标签")
        many = [f"T{i}" for i in range(9)]
        self.assertIn("等 9 个", g(tags=many))

    def test_game_tags_negated(self):
        g = lambda **k: C({"type": "game_tags", "negate": True, **k})  # noqa: E731
        self.assertEqual(g(tags=["百合"]), "作品标签不含『百合』")
        self.assertEqual(g(quant="none", tags=["BL"]), "作品标签含『BL』")
        self.assertEqual(g(quant="all", tags=["百合", "日常"]), "作品标签没有同时含『百合』『日常』")
        self.assertEqual(g(quant="at_least", k=2, tags=["A", "B", "C"]), "作品标签含『A』『B』『C』中的不到 2 个")
        self.assertEqual(g(quant="at_least", k=4, tags=[], tag_list_id="l_t"), "作品标签含清单『测试标签清单』里的标签不到 4 个")

    def test_char_tags(self):
        self.assertEqual(C({"type": "char_tags", "tags": ["黑长直"]}), "角色标签含『黑长直』")

    def test_gender(self):
        self.assertEqual(C({"type": "gender", "values": ["女"]}), "性别为女")
        self.assertEqual(C({"type": "gender", "values": ["男", "女"]}), "性别为男或女")
        self.assertEqual(C({"type": "gender", "values": ["未知"]}), "性别未知")
        self.assertEqual(C({"type": "gender", "values": ["女"], "negate": True}), "性别不是女")
        self.assertEqual(C({"type": "gender", "values": ["男", "女"], "negate": True}), "性别未知")

    def test_numbers(self):
        self.assertEqual(C({"type": "char_heat", "min": 1000}), "角色热度至少 1,000")
        self.assertEqual(C({"type": "char_heat", "max": 500}), "角色热度不超过 500")
        self.assertEqual(C({"type": "char_heat", "min": 100, "max": 1000}), "角色热度在 100–1,000 之间")
        self.assertEqual(C({"type": "char_heat", "min": 1000, "negate": True}), "角色热度低于 1,000")
        self.assertEqual(C({"type": "char_heat", "min": 100, "max": 1000, "negate": True}), "角色热度不在 100–1,000 之间")
        self.assertEqual(C({"type": "n_app", "min": 3}), "登场作品至少 3 部")
        self.assertEqual(C({"type": "n_app", "min": 3, "negate": True}), "登场作品少于 3 部")
        self.assertEqual(C({"type": "rating", "min": 7.5}), "最高评分至少 7.5")
        self.assertEqual(C({"type": "earliest_year", "min": 2020}), "最早登场于 2020 年或以后")
        self.assertEqual(C({"type": "earliest_year", "min": 2010, "max": 2015}), "最早登场于 2010–2015 年")
        self.assertEqual(C({"type": "latest_year", "max": 2010, "negate": True}), "最晚登场晚于 2010 年")

    def test_va_source_list_sql(self):
        self.assertEqual(C({"type": "va", "names": ["花澤香菜"]}), "由『花澤香菜』配音")
        self.assertEqual(C({"type": "va", "names": ["A", "B"], "negate": True}), "不是由『A』或『B』配音")
        self.assertEqual(C({"type": "source_tag", "values": ["漫画改", "小说改"]}), "来源是漫画改或小说改")
        self.assertEqual(C({"type": "source_tag", "values": ["原创"], "negate": True}), "来源不是原创")
        self.assertEqual(C({"type": "char_list", "list_id": "l_c", "negate": True}), "不在角色清单『测试角色清单』里")
        self.assertEqual(C({"type": "sql", "sql": "SELECT 1", "label": "高人气"}), "满足自定义查询『高人气』")

    def test_appearance(self):
        a = lambda **k: C({"type": "appearance", **k})  # noqa: E731
        self.assertEqual(a(subject_types=[2], year_from=2024, year_to=2024, roles=["主角"]), "至少在一部 2024 年的动画里当过主角")
        self.assertEqual(a(subject_types=[2], year_from=2024, year_to=2024, roles=["主角"], negate=True),
                         "没有在任何一部 2024 年的动画里当过主角")
        self.assertEqual(a(subject_types=[2], roles=["主角"], work_tags={"tags": ["百合"]}),
                         "至少在一部带『百合』标签的动画里当过主角")
        self.assertEqual(a(roles=["客串"]), "至少在一部作品里客串过")
        self.assertEqual(a(work_list_id="l_w", roles=["主角", "配角"]), "在作品清单『测试作品清单』里某一部作品当过主角或配角")


class TestDescribeChanges(unittest.TestCase):
    def test_changes(self):
        old = parse_spec(default_spec())
        d = default_spec()
        d["ranges"][0]["source"]["year_from"] = 2024
        d["ranges"][0]["source"]["year_to"] = 2024
        d["ranges"][0]["conditions"] = [{"type": "game_tags", "tags": ["百合"]}]
        d["ranges"][0]["pick"]["roles"] = ["主角", "配角"]
        d["game"]["tag_count"] = 4
        ch = describe_changes(old, parse_spec(d), LISTS.get)
        y = old.ranges[0].source.year_to
        self.assertIn("作品标签数：6 → 4", ch)
        self.assertIn(f"年份：{y - 10}–{y} 年 → 2024 年", ch)
        self.assertIn("身份：只要主角 → 主角和配角", ch)
        self.assertIn("加了条件：作品标签含『百合』", ch)

    def test_no_change(self):
        a = parse_spec(default_spec())
        self.assertEqual(describe_changes(a, parse_spec(default_spec()), LISTS.get), [])

    def test_removed_condition_and_new_range(self):
        d1 = default_spec()
        d1["ranges"][0]["conditions"] = [{"id": "c1", "type": "gender", "values": ["女"]}]
        d2 = default_spec()
        d2["ranges"].append({"id": "r2", "source": {"kind": "char_list", "list_id": "l_c"}})
        ch = describe_changes(parse_spec(d1), parse_spec(d2), LISTS.get)
        self.assertTrue(any(x.startswith("范围 1 · 去掉了条件：性别为女") for x in ch), ch)
        self.assertTrue(any(x.startswith("加了范围：角色清单『测试角色清单』") for x in ch), ch)


class TestPickDefaults(unittest.TestCase):
    def test_per_work_default_follows_game(self):
        from backend.v2.spec import Pick
        self.assertIsNone(Pick().per_work)                                         # 只要主角：不截断
        self.assertIsNone(Pick.model_validate({"roles": ["主角"]}).per_work)
        self.assertEqual(Pick.model_validate({"roles": ["主角", "配角"]}).per_work, 6)  # 带配角：6（游戏默认）
        self.assertEqual(Pick.model_validate({"roles": ["配角"]}).per_work, 6)
        self.assertIsNone(Pick.model_validate({"roles": ["主角", "配角"], "per_work": None}).per_work)  # 明写 null 就是不限
        self.assertEqual(Pick.model_validate({"roles": ["主角"], "per_work": 3}).per_work, 3)

    def test_bangumi_normalized_to_game(self):
        sp = parse_spec({"ranges": [{"pick": {"roles": ["主角"], "per_work": 2, "order": "bangumi"}}]})
        self.assertEqual(sp.ranges[0].pick.order, "game")
        with self.assertRaises(Exception):
            parse_spec({"ranges": [{"pick": {"order": "weird"}}]})

    def test_default_spec_uncapped(self):
        d = default_spec()
        self.assertEqual(d["ranges"][0]["pick"], {"roles": ["主角"], "per_work": None, "order": "heat"})
        self.assertIsNone(parse_spec({}).ranges[0].pick.per_work)


if __name__ == "__main__":
    unittest.main()
