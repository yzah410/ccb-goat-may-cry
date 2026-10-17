# -*- coding: utf-8 -*-
"""单人版容错搜索：backend/v2/solo/fuzzy.py（纯算法）、search.py（服务 + 别名旁路文件）、GET /v2/solo/search。

- 算法部分用一份手写的小语料直接测 FuzzyIndex，不碰数据库；
- 服务 / 路由部分用 synth.py 的合成库（角色 c1…c18「角色一」…；c7 原名 セブン / 中文名 七号角色；作品 101…）；
- 别名旁路文件在合成库旁边临时写一个，用完删掉；
- 同音字相关的用例需要 pypinyin（backend/requirements.txt 里有；没装就跳过那几条）。
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import sqlite3
import time
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from . import base
from backend.v2 import router as R
from backend.v2.solo import fuzzy
from backend.v2.solo import search as search_mod
from backend.v2.solo.router import router as solo_router
from backend.v2.solo.search import SEARCH
from backend.v2.store import HUB, DataHub, with_snapshot

HAS_PINYIN = fuzzy._pypinyin is not None
needs_pinyin = unittest.skipUnless(HAS_PINYIN, "没装 pypinyin")

app = FastAPI()
app.include_router(solo_router)
client = TestClient(app)

# (id, 热度, [名字…], 正式名字个数)，已按 (热度降序, id 升序) 排好
ENTS = [
    (10, 900, ["灶门炭治郎", "竈門炭治郎", "Kamado Tanjirou"], 2),
    (11, 800, ["Lelouch Lamperouge", "鲁路修", "ルルーシュ・ランペルージ"], 3),
    (12, 700, ["黑崎一护", "Kurosaki Ichigo"], 1),          # 第二个名字是别名
    (13, 600, ["李白"], 1),
    (14, 500, ["李白白"], 1),
    (15, 450, ["诗音"], 1),
    (16, 400, ["エドワード・エルリック", "爱德华·艾尔利克"], 2),
    (40, 350, ["A・B"], 1),                                  # 规范化后和 41 一样（都是 ab）
    (41, 340, ["AB"], 1),
    (17, 300, ["Odd Taxi", "奇巧计程车"], 2),
    (18, 200, ["甲乙", "丙丁"], 1),                          # 丙丁 是别名
    (19, 100, ["丙丁"], 1),                                  # 丙丁 是正式名字
    (20, 90, ["御坂美琴", "Misaka Mikoto"], 1),
]


def ids(hits):
    return [h[2] for h in hits]


def eid(idx, hit):
    return idx.ent_ids[hit[2]]


# ================================================================ 规范化、代价、距离
class TestNormalizeAndCost(unittest.TestCase):
    def test_normalize(self):
        n = fuzzy.normalize
        self.assertEqual(n("Ｌｅｌｏｕｃｈ"), "lelouch")                      # 全角、大小写
        self.assertEqual(n("灶门 炭治郎"), n("灶门炭治郎"))                      # 空白
        self.assertEqual(n("灶门・炭治郎"), n("灶门炭治郎"))                    # 间隔符
        self.assertEqual(n("L.Lawliet"), "llawliet")
        self.assertEqual(n("ルルーシュ"), n("るるーしゅ"))                      # 片假名折成平假名
        self.assertEqual(n("Café Ōkami"), "cafeokami")                        # 拉丁字母去附加符号
        self.assertEqual(n("  ・ "), "")
        self.assertEqual(n(""), "")

    def test_max_cost_table(self):
        mc = fuzzy.max_cost
        self.assertLess(mc(1, False), 0)                                    # 1 个字不容错
        self.assertEqual((mc(2, False), mc(3, False), mc(4, False)), (0.5, 1.0, 1.0))
        self.assertEqual((mc(5, False), mc(9, False), mc(10, False), mc(30, False)), (1.5, 1.5, 2.0, 2.0))
        self.assertLess(mc(3, True), 0)                                     # 拉丁字母 < 4 不容错
        self.assertEqual((mc(4, True), mc(7, True), mc(8, True)), (1.0, 1.0, 2.0))

    def test_within1(self):
        w = fuzzy.within1
        self.assertTrue(w("abc", "abc"))
        self.assertTrue(w("abc", "abd"))            # 替换
        self.assertTrue(w("abc", "abcd"))           # 插入
        self.assertTrue(w("abcd", "abd"))           # 删除
        self.assertTrue(w("abc", "acb"))            # 相邻两字颠倒
        self.assertFalse(w("abc", "bca"))
        self.assertFalse(w("abc", "abcde"))
        self.assertFalse(w("abc", "xyz"))

    def _cost(self, q, r, maxc=2.0):
        return fuzzy.approx_cost(q, fuzzy.phon(q), r, fuzzy.phon(r), maxc)

    def test_approx_cost(self):
        self.assertEqual(self._cost("灶门炭治郎", "灶门炭治郎"), 0)
        self.assertEqual(self._cost("炭治", "灶门炭治郎"), 0)                  # 名字的一段，两头可以不要
        self.assertEqual(self._cost("灶门炭郎", "灶门炭治郎"), 1)               # 少一个字
        self.assertEqual(self._cost("灶门炭治郎吗", "灶门炭治郎"), 1)            # 多一个字
        self.assertEqual(self._cost("灶门治炭郎", "灶门炭治郎"), 1)              # 相邻两字颠倒记 1，不是 2
        self.assertEqual(self._cost("灶门炭治邮", "灶门炭治郎"), 1)              # 错一个字（邮 you / 郎 lang 读音不同）
        self.assertEqual(self._cost("完全不同的名字", "灶门炭治郎", 1.5), fuzzy.INF)
        self.assertEqual(self._cost("", "灶门炭治郎"), fuzzy.INF)

    @needs_pinyin
    def test_homophone_substitution_is_cheap(self):
        self.assertEqual(self._cost("施音", "诗音"), fuzzy.HOMO_COST)
        self.assertEqual(self._cost("灶门炭治朗", "灶门炭治郎"), fuzzy.HOMO_COST)      # 朗 / 郎 同音
        self.assertEqual(self._cost("四音", "诗音", 0.5), fuzzy.INF)                  # shi / si 不同音：1 > 0.5

    @needs_pinyin
    def test_segment_pinyin(self):
        fuzzy.phon("炭治郎")                                                 # 用到的音节才进表
        self.assertEqual(fuzzy.segment_pinyin("tanzhilang")[0], ["tan", "zhi", "lang"])
        self.assertEqual(fuzzy.segment_pinyin("ab"), [])
        self.assertEqual(fuzzy.segment_pinyin("zzzzzz"), [])

    @needs_pinyin
    def test_segment_pinyin_long_input_returns_fast(self):
        fuzzy.phon("先西安炭治郎")                                           # xian / xi / an / tan / zhi / lang 进表
        for s in ("a" * 200, "xian" * 50, "tanzhilang" * 20, "q" * 200):
            t0 = time.perf_counter()
            self.assertEqual(fuzzy.segment_pinyin(s), [], s[:12])           # 超过 PINYIN_MAX_LEN：不切
            self.assertLess(time.perf_counter() - t0, 0.1, s[:12])
        self.assertEqual(fuzzy.PINYIN_MAX_LEN, 64)
        self.assertEqual(fuzzy.PINYIN_MAX_NODES, 5000)
        self.assertNotEqual(fuzzy.segment_pinyin("tanzhilang" * 6 + "tan"), [])    # 63 个字符：照常切

    @needs_pinyin
    def test_segment_pinyin_ambiguous_input_is_capped_by_node_count(self):
        fuzzy.phon("先西安炭治郎")
        # 每个 xian 能切成 xian 或 xi+an，14 个连着、最后接一个切不开的「xq」：切法有 2^14 条，全部走完才知道没有解
        t0 = time.perf_counter()
        self.assertEqual(fuzzy.segment_pinyin("xian" * 14 + "xq"), [])
        self.assertLess(time.perf_counter() - t0, 0.1)
        # 上限是真的在起作用：同一个能切的串，节点上限调到 3 就放弃，调回去就能切；长度上限同理
        self.assertEqual(fuzzy.segment_pinyin("tanzhilang")[0], ["tan", "zhi", "lang"])
        with mock.patch.object(fuzzy, "PINYIN_MAX_NODES", 3):
            self.assertEqual(fuzzy.segment_pinyin("tanzhilang"), [])
        with mock.patch.object(fuzzy, "PINYIN_MAX_LEN", 9):
            self.assertEqual(fuzzy.segment_pinyin("tanzhilang"), [])


# ================================================================ FuzzyIndex
class TestFuzzyIndex(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idx = fuzzy.FuzzyIndex(ENTS)

    def search(self, q, limit=12):
        return self.idx.search(q, limit)

    def tiers(self, q, limit=12):
        return [(eid(self.idx, h), fuzzy.TIER_NAMES[h[0]]) for h in self.search(q, limit)]

    # ---------------- 完全相同 / 前缀 / 包含
    def test_exact_prefix_contains(self):
        self.assertEqual(self.tiers("灶门炭治郎")[0], (10, "exact"))
        self.assertEqual(self.tiers("灶门")[0], (10, "prefix"))
        self.assertEqual(self.tiers("炭治")[0], (10, "contains"))
        self.assertEqual(self.tiers("李白")[:2], [(13, "exact"), (14, "prefix")])        # 完全相同 + 前缀合并成一档：13 号更热，在前

    def test_case_width_separator_and_kana_are_ignored(self):
        self.assertEqual(self.tiers("LELOUCH")[0], (11, "prefix"))
        self.assertEqual(self.tiers("lelouch lamperouge")[0], (11, "exact"))
        self.assertEqual(self.tiers("Lelouch-Lamperouge")[0], (11, "exact"))
        self.assertEqual(self.tiers("灶门 炭治郎")[0], (10, "exact"))
        self.assertEqual(self.tiers("るるーしゅ")[0], (11, "prefix"))                       # 片假名 / 平假名
        self.assertEqual(self.tiers("エドワード エルリック")[0], (16, "exact"))

    def test_same_tier_ordered_by_heat(self):
        self.assertEqual(self.tiers("白"), [(13, "contains"), (14, "contains")])           # 热度 600 / 500
        # 「ro」在 10 / 12 号的别名、11 号的正式名字里：正式名字在前，别名之间再按热度 900 / 700
        self.assertEqual(self.tiers("ro"), [(11, "contains"), (10, "contains"), (12, "contains")])

    def test_exact_hits_follow_heat_whether_primary_or_alias(self):
        # 18 号的「丙丁」是别名（热度 200），19 号的「丙丁」是正式名字（热度 100）。
        # 完全相同的命中不分正式名字和别名，按热度排：热的在前（雷姆 -> 蕾姆 这类「别名完全相同」的热门对象不能被冷门同名对象压下去）
        self.assertEqual(self.tiers("丙丁")[:2], [(18, "exact"), (19, "exact")])
        # 包含档里正式名字命中在前、别名命中在后（11 号的「ro」是正式名字里的，见 test_same_tier_ordered_by_heat）

    def test_literal_equal_raw_wins_inside_exact_tier(self):
        # 「A・B」和「AB」规范化后都是 ab；查询原文是哪个，哪个在前，不看热度
        self.assertEqual([e for e, _ in self.tiers("AB")[:2]], [41, 40])
        self.assertEqual([e for e, _ in self.tiers("A・B")[:2]], [40, 41])

    def test_each_entity_once_and_matched_raw(self):
        hits = self.search("tanjirou")
        self.assertEqual(ids(hits).count(0), 1)
        h = self.search("kamado tanjirou")[0]
        self.assertEqual((eid(self.idx, h), fuzzy.TIER_NAMES[h[0]]), (10, "exact"))
        self.assertEqual(self.idx.row_raw(h[3]), "Kamado Tanjirou")                    # matched = 命中的那个名字的原文
        h = self.search("灶门炭治郎")[0]
        self.assertEqual(self.idx.row_raw(h[3]), "灶门炭治郎")

    def test_multi_token_any_order_is_contains(self):
        hits = self.search("Lamperouge Lelouch")
        self.assertEqual((eid(self.idx, hits[0]), fuzzy.TIER_NAMES[hits[0][0]]), (11, "contains"))
        hits = self.search("Ichigo Kurosaki")                                          # 名字里的两个词颠倒
        self.assertEqual(eid(self.idx, hits[0]), 12)
        # 两个词分别在两个对象的名字里：不算命中
        self.assertEqual([h for h in self.search("Lelouch Ichigo") if h[0] <= 2], [])

    def test_limit_and_empty_queries(self):
        self.assertEqual(self.search("", 5), [])
        self.assertEqual(self.search("   ", 5), [])
        self.assertEqual(self.search("・・", 5), [])                                    # 规范化后是空
        self.assertEqual(self.search("灶门", 0), [])
        self.assertLessEqual(len(self.search("a", 3)), 3)
        self.assertEqual(len(self.search("a", 3)), 3)

    def test_many_words_query_uses_the_whole_name(self):
        """5 个词以上的查询：完全相同 / 前缀不能只看前 4 个词（一个系列的作品前几个词常常一样）。"""
        ents = [
            (1, 900, ["THE IDOLM@STER LIVE THE@TER PERFORMANCE 04"], 1),
            (2, 800, ["THE IDOLM@STER LIVE THE@TER SOLO COLLECTION DIAMOND DAYS"], 1),
            (3, 700, ["THE IDOLM@STER LIVE THE@TER HARMONY 07"], 1),
        ]
        idx = fuzzy.FuzzyIndex(ents)

        def got(q):
            return [(eid(idx, h), fuzzy.TIER_NAMES[h[0]]) for h in idx.search(q, 5)]

        self.assertEqual(got("THE IDOLM@STER LIVE THE@TER SOLO COLLECTION DIAMOND DAYS")[0], (2, "exact"))
        self.assertEqual(got("The Idolm@ster Live The@ter Solo Collection")[0], (2, "prefix"))
        self.assertEqual(got("THE IDOLM@STER LIVE THE@TER HARMONY 07")[0], (3, "exact"))

    def test_long_query_is_capped_and_does_not_blow_up(self):
        t0 = time.perf_counter()
        self.search("a" * 5000)
        self.search("灶门炭治郎" * 300)
        self.search(" ".join(["lelouch"] * 50))
        self.assertLess(time.perf_counter() - t0, 3.0)

    # ---------------- 容错
    def test_deletion_insertion_substitution_transposition(self):
        self.assertEqual(self.tiers("灶门炭郎")[0], (10, "fuzzy"))                      # 少一个字
        self.assertEqual(self.tiers("灶门炭治治郎")[0], (10, "fuzzy"))                  # 多一个字
        self.assertEqual(self.tiers("灶门炭治邮")[0], (10, "fuzzy"))                    # 错一个字
        self.assertEqual(self.tiers("灶门治炭郎")[0], (10, "fuzzy"))                    # 相邻两字颠倒

    @needs_pinyin
    def test_two_char_query_only_accepts_homophones(self):
        self.assertEqual(self.tiers("施音"), [(15, "fuzzy")])                           # 诗音（shi yin）同音
        self.assertEqual(self.tiers("四音"), [])                                        # shi / si 不同音，2 个字不容错
        self.assertEqual(self.tiers("诗"), [(15, "prefix")])
        self.assertEqual(self.tiers("施"), [])                                          # 1 个字不容错

    @needs_pinyin
    def test_homophone_typo_in_longer_name(self):
        self.assertEqual(self.tiers("灶门炭治朗")[0], (10, "fuzzy"))                    # 朗 / 郎 同音
        self.assertEqual(self.tiers("御坂美芹")[0], (20, "fuzzy"))                      # 琴 / 芹 同音

    def test_one_wrong_char_in_a_four_char_name(self):
        self.assertEqual(self.tiers("御坂美琪")[0], (20, "fuzzy"))                      # 琪 / 琴 不同音：错一个字，3–4 个字容 1

    def test_latin_typos(self):
        self.assertEqual(self.tiers("Lelouh Lamperouge")[0], (11, "fuzzy"))             # 少一个字母（16 个字母，容 2 处）
        self.assertEqual(self.tiers("Odd aTxi")[0], (17, "fuzzy"))                      # 两个字母颠倒
        self.assertEqual(self.tiers("Ichgo")[0], (12, "fuzzy"))                         # 5 个字母，少一个（走别名里的词）
        self.assertEqual(self.tiers("Mikotto")[0], (20, "fuzzy"))                       # 多一个字母
        self.assertEqual(self.tiers("kamdo tanjirou")[0], (10, "fuzzy"))

    def test_short_latin_has_no_fuzzy(self):
        self.assertEqual(self.tiers("ixh"), [])                                         # 3 个字母不容错
        self.assertEqual(self.tiers("xyz"), [])
        self.assertEqual(self.tiers("Oxd"), [])

    def test_kana_typo(self):
        self.assertEqual(self.tiers("エドワード・エルリク")[0], (16, "fuzzy"))           # 少了促音「ッ」

    def test_fuzzy_is_after_all_strict_hits(self):
        hits = self.search("李白")
        tiers = [h[0] for h in hits]
        self.assertEqual(tiers, sorted(tiers))
        # 容错命中不会重复出现严格命中的对象
        es = [eid(self.idx, h) for h in hits]
        self.assertEqual(len(es), len(set(es)))

    @needs_pinyin
    def test_pure_pinyin_input_is_last_resort(self):
        hits = self.search("heiqiyihu")
        self.assertEqual([(eid(self.idx, h), fuzzy.TIER_NAMES[h[0]]) for h in hits][:1], [(12, "fuzzy")])
        self.assertEqual(hits[0][1], 99)                                                # 排在所有容错命中之后
        hits = self.search("tanzhilang")
        self.assertEqual(eid(self.idx, hits[0]), 10)

    def test_exact_name_is_not_outranked_by_a_shorter_name_inside_it(self):
        # 查询「李白白」：它自己完全相同；「李白」（13）只是和它相近，排在后面
        self.assertEqual(self.tiers("李白白")[0], (14, "exact"))
        self.assertNotIn(13, [e for e, t in self.tiers("李白白") if t != "fuzzy"])


# ================================================================ 完全相同 + 前缀合并成一档、按热度排
class TestMergedExactPrefixTier(unittest.TestCase):
    """热门对象的前缀命中排在冷门对象的完全相同命中前面；最热的完全相同对象至少排第 3；包含档和容错档不参与合并，各自按热度排。"""

    @staticmethod
    def got(ents, q, limit=12):
        idx = fuzzy.FuzzyIndex(ents)
        return [(eid(idx, h), fuzzy.TIER_NAMES[h[0]]) for h in idx.search(q, limit)]

    def test_hot_prefix_beats_cold_exact(self):
        ents = [(1, 900, ["露西·哈特菲利亚"], 1), (2, 10, ["露西"], 1)]
        self.assertEqual(self.got(ents, "露西"), [(1, "prefix"), (2, "exact")])

    def test_hottest_exact_is_lifted_to_rank_3(self):
        ents = [(1, 900, ["露西·哈特菲利亚"], 1), (2, 800, ["露西先生"], 1), (3, 700, ["露西博士"], 1),
                (4, 600, ["露西老师"], 1), (5, 10, ["露西"], 1)]
        self.assertEqual([e for e, _ in self.got(ents, "露西")], [1, 2, 5, 3, 4])      # 5 号本来排第 5，提到第 3
        self.assertEqual(self.got(ents, "露西")[2], (5, "exact"))

    def test_exact_already_in_top_3_does_not_move(self):
        base = [(1, 900, ["露西·哈特菲利亚"], 1), (2, 800, ["露西先生"], 1), (3, 700, ["露西博士"], 1), (4, 600, ["露西老师"], 1)]
        for heat, want in ((950, [5, 1, 2, 3, 4]), (850, [1, 5, 2, 3, 4]), (750, [1, 2, 5, 3, 4])):
            ents = sorted(base + [(5, heat, ["露西"], 1)], key=lambda x: (-x[1], x[0]))
            self.assertEqual([e for e, _ in self.got(ents, "露西")], want, heat)

    def test_only_the_hottest_exact_is_lifted(self):
        ents = [(1, 900, ["露西·哈特菲利亚"], 1), (2, 800, ["露西先生"], 1), (3, 700, ["露西博士"], 1),
                (4, 600, ["露西老师"], 1), (5, 10, ["露西"], 1), (6, 5, ["露・西"], 1)]
        # 5 号和 6 号的名字规范化后都是「露西」；热的 5 号提到第 3，6 号仍按热度排在合并档的最后
        self.assertEqual([e for e, _ in self.got(ents, "露西")], [1, 2, 5, 3, 4, 6])

    def test_no_exact_hit_means_plain_heat_order(self):
        ents = [(1, 900, ["露西·哈特菲利亚"], 1), (2, 800, ["露西先生"], 1), (3, 700, ["露西博士"], 1), (4, 600, ["露西老师"], 1)]
        self.assertEqual(self.got(ents, "露西"), [(1, "prefix"), (2, "prefix"), (3, "prefix"), (4, "prefix")])

    def test_alias_prefix_goes_to_the_end_of_the_merged_tier(self):
        # 1 号只有别名「Rock Lee」以 roc 开头（热度 900），2 号的正式名字「Rocket」以 roc 开头（热度 100）：2 号在前
        ents = [(1, 900, ["李小龙", "Rock Lee"], 1), (2, 100, ["Rocket"], 1)]
        self.assertEqual(self.got(ents, "roc"), [(2, "prefix"), (1, "prefix")])
        # 但别名是完全相同的就不降：热门的 蕾姆（别名「雷姆」）排在冷门的、正式名字就叫「雷姆」的对象前面
        ents = [(1, 900, ["蕾姆", "雷姆"], 1), (2, 5, ["雷姆"], 1)]
        self.assertEqual(self.got(ents, "雷姆"), [(1, "exact"), (2, "exact")])

    def test_literal_original_text_still_wins_among_exact_hits(self):
        # 「银魂'」和「银魂」规范化后一样；完全相同的两个之间，查询原文是哪个，哪个在前（不看热度）。有热门前缀命中时这条照样成立
        ents = [(1, 900, ["银魂"], 1), (2, 800, ["银魂 第二季"], 1), (3, 700, ["银魂篇"], 1), (4, 10, ["银魂'"], 1)]
        got = self.got(ents, "银魂'")
        self.assertEqual(got[0], (4, "exact"))                                         # 原文一样的排在最前面
        self.assertEqual([e for e, t in got if t == "exact"], [4, 1])
        self.assertEqual(got[2], (1, "exact"))                                         # 最热的完全相同对象（1 号）保底第 3
        got = self.got(ents, "银魂")
        self.assertEqual([e for e, t in got if t == "exact"], [1, 4])
        self.assertEqual(got[0], (1, "exact"))

    def test_contains_and_fuzzy_tiers_are_not_merged(self):
        # 热门的「包含」不会跑到冷门的「完全相同 / 前缀」前面；包含档里按热度
        ents = [(1, 900, ["小露西"], 1), (2, 800, ["大露西"], 1), (3, 10, ["露西"], 1), (4, 5, ["露西们"], 1)]
        self.assertEqual(self.got(ents, "露西"), [(3, "exact"), (4, "prefix"), (1, "contains"), (2, "contains")])
        ents = [(1, 900, ["灶门炭治郎"], 1), (2, 10, ["灶门炭治朗"], 1)]
        self.assertEqual(self.got(ents, "灶门炭治郎")[0], (1, "exact"))
        self.assertEqual(self.got(ents, "灶门炭治")[0][1], "prefix")

    def test_every_entity_appears_once(self):
        ents = [(1, 900, ["露西·哈特菲利亚", "露西"], 2), (2, 10, ["露西"], 1), (3, 5, ["露西先生"], 1)]
        es = [e for e, _ in self.got(ents, "露西")]
        self.assertEqual(sorted(es), [1, 2, 3])


class TestCaps(unittest.TestCase):
    def test_multi_word_cap_limits_how_many_entities_each_word_collects(self):
        ents = [(i, 1000 - i, [f"ea{i:03d}"], 1) for i in range(100)]
        idx = fuzzy.FuzzyIndex(ents)
        self.assertLessEqual(fuzzy.MULTI_CAP, 10000)                                   # 4 个常见词最坏要在 50 ms 内
        self.assertEqual(len(idx.search("a e", 50)), 50)                               # 上限够大时，要几个有几个
        with mock.patch.object(fuzzy, "MULTI_CAP", 10):
            got = idx.search("a e", 50)                                                # 「ae」整串没有命中，走多词任意顺序
            self.assertEqual(len(got), 10)
            self.assertEqual(sorted(h[2] for h in got), list(range(10)))               # 只收最热的 10 个

    @needs_pinyin
    def test_ambiguous_pinyin_query_through_search_returns_fast(self):
        fuzzy.phon("先西安炭治郎")
        idx = fuzzy.FuzzyIndex(ENTS)
        for q in ("xian" * 15, "xian" * 14 + "xq", "a" * 200, "xianxi" * 40):
            t0 = time.perf_counter()
            idx.search(q, 12)
            self.assertLess(time.perf_counter() - t0, 0.1, q[:12])

    def test_200_letters_returns_within_100ms(self):
        idx = fuzzy.FuzzyIndex(ENTS)
        for q in ("a" * 200, "ab" * 100, "lelouch lamperouge " * 12):
            t0 = time.perf_counter()
            idx.search(q, 12)
            self.assertLess(time.perf_counter() - t0, 0.1, q[:12])


# ================================================================ 服务（合成库）
class ServiceCase(unittest.TestCase):
    def setUp(self):
        self.alias_path = search_mod.alias_path_for(base.DB)
        self._rm_alias()
        SEARCH.reset()
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        self._rm_alias()
        SEARCH.reset()

    def _rm_alias(self):
        for p in (self.alias_path, self.alias_path + ".tmp"):
            with contextlib.suppress(OSError):
                os.remove(p)

    def write_aliases(self, char=(), subject=(), meta=None):
        con = sqlite3.connect(self.alias_path)
        con.executescript("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);"
                          "CREATE TABLE char_alias(id INTEGER NOT NULL, alias TEXT NOT NULL);"
                          "CREATE TABLE subject_alias(id INTEGER NOT NULL, alias TEXT NOT NULL);")
        con.executemany("INSERT INTO char_alias VALUES(?,?)", list(char))
        con.executemany("INSERT INTO subject_alias VALUES(?,?)", list(subject))
        con.executemany("INSERT INTO meta VALUES(?,?)", list((meta or {"dump_name": "test"}).items()))
        con.commit()
        con.close()

    def built(self):
        b = with_snapshot(lambda snap: SEARCH.wait_ready(snap, 30))
        self.assertIsNotNone(b, SEARCH.status())
        return b

    def search(self, kind, q, limit=12):
        return with_snapshot(lambda snap: SEARCH.search(snap, kind, q, limit))


class TestSearchService(ServiceCase):
    def test_item_fields_match_suggest(self):
        self.built()
        for kind, q in (("character", "角色一"), ("work", "恋爱番")):
            d = self.search(kind, q)
            self.assertTrue(d["fuzzy"])
            it = d["items"][0]
            self.assertEqual(set(it), {"id", "value", "label", "count", "matched", "match"})
            self.assertEqual(it["match"], "exact")
            self.assertIsNone(it["matched"])                                           # 命中的就是 value 本身
            sug = R.v2_suggest(kind=kind, q=q, mode="anime", limit=5, n=6)[0]
            self.assertEqual({k: it[k] for k in ("id", "value", "label", "count")}, sug)

    def test_matched_shows_original_and_chinese_names(self):
        self.built()
        it = self.search("character", "セブン")["items"][0]
        self.assertEqual((it["id"], it["value"], it["matched"], it["match"]), (7, "角色七", "セブン", "exact"))
        it = self.search("character", "七号")["items"][0]
        self.assertEqual((it["id"], it["matched"], it["match"]), (7, "七号角色", "prefix"))

    @needs_pinyin
    def test_homophone_typo_through_service(self):
        self.built()
        d = self.search("character", "角色柒")                                           # 柒 / 七 同音
        self.assertEqual((d["items"][0]["id"], d["items"][0]["match"]), (7, "fuzzy"))

    def test_tier_order_and_hidden_works(self):
        self.built()
        d = self.search("work", "NSFW 番")
        self.assertNotIn(106, [x["id"] for x in d["items"]])                           # nsfw 的作品不收
        d = self.search("character", "角色十")
        self.assertEqual(d["items"][0]["id"], 10)                                      # 完全相同在前
        self.assertEqual([x["match"] for x in d["items"][:3]], ["exact", "prefix", "prefix"])

    def test_alias_file_adds_names_and_splits_lists(self):
        self.write_aliases(char=[(1, "小一"), (2, "小甲、小乙"), (3, "Third / 老三")], subject=[(104, "Love Bangumi")])
        b = self.built()
        self.assertTrue(b.info["aliases"])
        self.assertEqual((b.info["char_aliases"], b.info["subject_aliases"]), (3, 1))
        it = self.search("character", "小一")["items"][0]
        self.assertEqual((it["id"], it["value"], it["matched"], it["match"]), (1, "角色一", "小一", "exact"))
        it = self.search("character", "小乙")["items"][0]                               # 拆开的那一段
        self.assertEqual((it["id"], it["matched"], it["match"]), (2, "小乙", "exact"))
        it = self.search("character", "小甲、小乙")["items"][0]                          # 整串也收
        self.assertEqual((it["id"], it["matched"]), (2, "小甲、小乙"))
        it = self.search("character", "老三")["items"][0]
        self.assertEqual((it["id"], it["matched"]), (3, "老三"))
        it = self.search("work", "love bangumi")["items"][0]
        self.assertEqual((it["id"], it["value"], it["matched"], it["match"]), (104, "恋爱番", "Love Bangumi", "exact"))

    def test_exact_alias_of_a_hotter_entity_ranks_by_heat(self):
        # c5 的别名「角色一」和 c1 的正式名字相同：两个都是完全相同，按热度排，c5 更热所以在前；
        # c1 照样在前两名里，c5 的 matched 显示命中的是别名「角色一」
        self.write_aliases(char=[(5, "角色一")])
        self.built()
        d = self.search("character", "角色一")
        self.assertEqual([x["id"] for x in d["items"][:2]], [5, 1])
        self.assertEqual([x["match"] for x in d["items"][:2]], ["exact", "exact"])
        self.assertEqual((d["items"][0]["matched"], d["items"][0]["value"]), ("角色一", "角色五"))

    def test_without_or_with_broken_alias_file(self):
        b = self.built()
        self.assertFalse(b.info["aliases"])
        self.assertEqual(self.search("character", "角色一")["items"][0]["id"], 1)
        SEARCH.reset()
        with open(self.alias_path, "wb") as f:
            f.write(b"this is not a sqlite file" * 100)
        b = self.built()
        self.assertFalse(b.info["aliases"])                                            # 读不了就当没有，不报错
        self.assertEqual(self.search("character", "角色一")["items"][0]["id"], 1)

    def test_empty_query(self):
        self.built()
        for q in ("", "   ", "・"):
            self.assertEqual(self.search("character", q)["items"], [])

    def test_strict_fallback_while_index_is_not_ready(self):
        with mock.patch.object(SEARCH, "ensure", return_value=None):
            for kind, q in (("character", "角色十"), ("work", "番"), ("character", "角色")):
                d = self.search(kind, q, 12)
                sug = R.v2_suggest(kind=kind, q=q, mode="anime", limit=12, n=6)
                self.assertFalse(d["fuzzy"])
                self.assertEqual([x["id"] for x in d["items"]], [x["id"] for x in sug])      # 和 /v2/suggest 同一个顺序
                self.assertTrue(all(x["matched"] is None for x in d["items"]))
                self.assertTrue(all(x["match"] in ("exact", "prefix", "contains") for x in d["items"]))
            d = self.search("character", "角色柒")                                        # 严格规则不容错
            self.assertEqual((d["items"], d["fuzzy"]), ([], False))
            self.assertEqual(self.search("character", "角色一")["items"][0]["match"], "exact")

    def test_background_build_and_status(self):
        st = SEARCH.status()
        self.assertFalse(st["ready"])
        with_snapshot(lambda snap: SEARCH.kick(snap))
        self.built()
        st = SEARCH.status()
        self.assertTrue(st["ready"] and not st["building"])
        self.assertEqual(st["info"]["char_entities"], 17)                              # 合成库默认 c1…c17
        self.assertIsNone(st["error"])

    def test_new_snapshot_drops_old_index_and_falls_back(self):
        self.built()

        def run(snap):
            other = copy.copy(snap)
            other.sig = ("another", 0, 0)                                              # 假装库换了
            self.assertIsNone(SEARCH.ensure(other))                                    # 先放掉旧索引，新的在后台建
            self.assertIsNone(SEARCH._built)
            t = SEARCH._thread
            if t is not None:
                t.join(10)
            d = SEARCH.search(other, "character", "角色一", 5)
            return d
        d = with_snapshot(run)
        self.assertFalse(d["fuzzy"])                                                   # 建不起来（快照过期）→ 严格规则
        self.assertEqual(d["items"][0]["id"], 1)

    def test_failed_build_is_retried_only_after_a_minute(self):
        calls = []

        def boom(snap):
            calls.append(1)
            raise RuntimeError("boom")

        err = io.StringIO()
        with mock.patch.object(search_mod, "load_entities", boom), contextlib.redirect_stderr(err):
            self.assertIsNone(with_snapshot(lambda snap: SEARCH.wait_ready(snap, 10)))
            self.assertEqual(len(calls), 1)
            self.assertIn("boom", SEARCH.status()["error"])
            d = self.search("character", "角色一")                                      # 失败期间走严格规则，不抛错
            self.assertEqual((d["fuzzy"], d["items"][0]["id"]), (False, 1))
            self.assertIsNone(with_snapshot(lambda snap: SEARCH.ensure(snap)))
            self.assertEqual(len(calls), 1)                                            # 不到 60 秒不重试
        sig, _t, msg = SEARCH._failed
        SEARCH._failed = (sig, time.time() - search_mod.RETRY_AFTER_FAIL_SEC - 1, msg)
        self.built()                                                                   # 过了 60 秒：重新建，这次成功
        self.assertTrue(self.search("character", "角色一")["fuzzy"])

    def test_snapshot_hook_fires_after_a_snapshot_switch(self):
        seen = []
        hub = DataHub()

        def bad(snap):
            raise RuntimeError("hook error must not break loading")

        hub.snapshot_hooks.extend([bad, lambda snap: seen.append(snap.sig)])
        snap = hub.current()
        self.assertEqual(seen, [snap.sig])
        hub.current()                                                                  # 没换库：不再触发
        self.assertEqual(len(seen), 1)

    def test_install_registers_hook_once(self):
        try:
            search_mod.install()
            search_mod.install()
            self.assertEqual(HUB.snapshot_hooks.count(SEARCH.kick), 1)
            self.built()
        finally:
            while SEARCH.kick in HUB.snapshot_hooks:
                HUB.snapshot_hooks.remove(SEARCH.kick)


# ================================================================ HTTP 接口
class TestSearchRoute(ServiceCase):
    def get(self, **params):
        return client.get("/v2/solo/search", params=params)

    def test_registered_and_mounted(self):
        paths = {(r.path, tuple(sorted(r.methods))) for r in solo_router.routes}
        self.assertIn(("/v2/solo/search", ("GET",)), paths)
        here = os.path.dirname(__file__)
        with open(os.path.join(here, "..", "..", "app.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("v2_solo_search.install()", src)                                  # 启动时开始后台建索引

    def test_basic_response(self):
        self.built()
        r = self.get(kind="character", q="角色一")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual(set(d), {"items", "fuzzy"})
        self.assertTrue(d["fuzzy"])
        self.assertEqual(set(d["items"][0]), {"id", "value", "label", "count", "matched", "match"})
        self.assertEqual(d["items"][0]["id"], 1)
        r = self.get(kind="work", q="恋爱番")
        self.assertEqual(r.json()["items"][0]["id"], 104)

    def test_bad_kind_and_missing_kind(self):
        r = self.get(kind="person", q="x")
        self.assertEqual(r.status_code, 422)
        d = r.json()
        self.assertEqual((d["ok"], d["error"]), (False, "bad_kind"))
        self.assertTrue(d["message"])
        self.assertEqual(self.get(q="x").status_code, 422)

    def test_empty_q_gives_empty_items(self):
        for params in ({"kind": "character"}, {"kind": "character", "q": ""}, {"kind": "work", "q": "   "}):
            r = self.get(**params)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["items"], [])

    def test_limit_bounds_and_default(self):
        self.built()
        self.assertEqual(len(self.get(kind="character", q="角色").json()["items"]), 12)           # 默认 12
        self.assertEqual(len(self.get(kind="character", q="角色", limit=3).json()["items"]), 3)
        self.assertEqual(len(self.get(kind="character", q="角色", limit=50).json()["items"]), 17)   # 全库才 17 人
        self.assertEqual(self.get(kind="character", q="角色", limit=0).status_code, 422)
        self.assertEqual(self.get(kind="character", q="角色", limit=51).status_code, 422)

    def test_no_answer_or_internal_fields_leak(self):
        self.built()
        d = self.get(kind="character", q="角色一").json()
        text = json.dumps(d, ensure_ascii=False)
        for bad in ("answer", "heat", "gender"):
            self.assertNotIn(bad, text)

    def test_works_while_index_is_not_ready(self):
        with mock.patch.object(SEARCH, "ensure", return_value=None):
            d = self.get(kind="character", q="角色十").json()
        self.assertFalse(d["fuzzy"])
        self.assertEqual(d["items"][0]["id"], 10)


if __name__ == "__main__":
    unittest.main()
