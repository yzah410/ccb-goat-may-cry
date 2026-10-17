# -*- coding: utf-8 -*-
"""单人版反馈（backend/v2/solo/feedback.py）：合成库手算 + 纯函数边界。

合成库里和反馈有关的数（anime 模式，today = 2026-06-15；人气 = heat + comments）：
  c1 女 人气 500+50=550  评分 8.0  登场 [101] + 特殊游戏 [202]  2024~2024  cut -1  标签 [百合 日常 校园 漫画改 TV 搞笑 音乐]  角色标签 [黑长直]  声优 [声优A]
  c2 女 人气 300+20=320  评分 8.0  登场 [101]                   2024~2024  cut  2  标签 [百合 日常 校园 漫画改]               角色标签 [双马尾]  声优 [声优B]
  c3 男 人气 100         评分 8.0  登场 [101]                   2024~2024  cut -1  标签 [日常 校园 百合]
  c4 无 人气 50+10=60    评分 7.0  登场 [102] + 特殊游戏 [201]  2024~2024  cut -1  标签 [战斗 百合]
  c5 女 人气 800+100=900 评分 7.5  登场 [102, 103] + 特殊 [202] 2023~2024  cut -1  标签 [战斗 日常 百合]  角色标签 [黑长直 双马尾]  声优 [声优A 声优C]
  c6 男 人气 20          评分 6.5  登场 [104] + 特殊游戏 [201]  2024~2024  cut -1  标签 [恋爱]
  c7 女 人气 5           没有画像行
  c9 男 人气 900+7=907   登场数 0（只在未上映作品里登场），评分 / 年份都没有
"""
from __future__ import annotations

import unittest

from . import base                      # noqa: F401  必须先于 backend.v2 的导入（设置环境变量、造合成库）
from backend.v2.solo import feedback as F
from backend.v2.store import HUB


def fb(guess, answer, n=6, ctn=4, mode="anime"):
    snap = HUB.current()
    return F.solo_feedback(snap, mode, guess, answer, n, ctn)


def view(**kw) -> F.CharView:
    """造一个角色数据，只写关心的字段。"""
    d = dict(id=1, name="x", gender="女", heat=100, comments=0, n_app=1, earliest=2020, latest=2020, rating=7.0,
             tags=(), regular_apps=(), extra_apps=(), char_tags=(), vas=())
    d.update(kw)
    return F.CharView(**d)


def pure(g, a, n=6, ctn=4, g_names=None, a_names=None):
    def names(v, given):
        return given if given is not None else [(f"作品{s}", f"作品{s}") for s in v.regular_apps]
    return F.compute_feedback(g, a, n, ctn, names(g, g_names), names(a, a_names))


class TestSynthHandComputed(unittest.TestCase):
    def test_c1_vs_c2(self):
        r = fb(1, 2)
        self.assertFalse(r["correct"])
        self.assertEqual(r["gender"], {"guess": "female", "feedback": "yes"})
        # 550 - 320 = 230 > 320 * 0.2 = 64
        self.assertEqual(r["popularity"], {"guess": 550, "feedback": "++"})
        self.assertEqual(r["rating"], {"guess": 8.0, "feedback": "="})
        # c1 的 id 列表是 [101, 202(特殊游戏)]，c2 是 [101]：共同 1 部，名字也对得上
        self.assertEqual(r["shared_appearances"],
                         {"first": "百合日常番", "firstOriginal": "百合日常番", "firstCn": "百合日常番", "count": 1})
        self.assertEqual(r["appearancesCount"], {"guess": 1, "feedback": "="})
        # c1 显示前 6 个标签（cut=-1 只看 n）；c2 的 cut=2、n=6 → 显示 max(2,6)=6 个，只有 4 个
        # 共有（按猜的顺序）：百合 日常 校园 漫画改；再补不共有的到 6 个：TV 搞笑
        # 角色标签没有共有 → 补猜的 黑长直；声优 声优A 不共有
        self.assertEqual(r["metaTags"]["guess"],
                         ["百合", "日常", "校园", "漫画改", "TV", "搞笑", "黑长直", "声优A"])
        self.assertEqual(r["metaTags"]["shared"], ["百合", "日常", "校园", "漫画改"])
        self.assertEqual(r["latestAppearance"], {"guess": 2024, "feedback": "="})
        self.assertEqual(r["earliestAppearance"], {"guess": 2024, "feedback": "="})

    def test_display_block(self):
        d = fb(1, 2)["display"]
        self.assertEqual((d["id"], d["name"], d["gender"], d["gender_symbol"]), (1, "角色一", "female", "♀"))
        self.assertEqual((d["popularity"], d["heat"], d["comments"]), (550, 500, 50))
        self.assertEqual((d["rating"], d["n_app"], d["earliest"], d["latest"]), (8.0, 1, 2024, 2024))
        self.assertEqual([(x["tag"], x["shared"]) for x in d["subject_tags"]],
                         [("百合", True), ("日常", True), ("校园", True), ("漫画改", True), ("TV", False), ("搞笑", False)])
        self.assertEqual(d["char_tags"], [{"tag": "黑长直", "shared": False}])
        self.assertEqual(d["vas"], [{"name": "声优A", "shared": False}])
        self.assertEqual(d["shared_work"], {"name": "百合日常番", "name_original": "百合日常番", "count": 1})

    def test_c5_vs_c1_shared_through_special_game(self):
        r = fb(5, 1, n=4)
        self.assertEqual(r["popularity"], {"guess": 900, "feedback": "++"})          # 350 > 550*0.2=110
        self.assertEqual(r["rating"], {"guess": 7.5, "feedback": "-"})               # 7.5-8.0=-0.5：超过 0.3、不超过 1
        # 唯一共同作品是特殊游戏 202：数得进「共同 1 部」，但它不在登场名单里，所以没有名字
        self.assertEqual(r["shared_appearances"], {"first": "", "firstOriginal": None, "firstCn": None, "count": 1})
        # display 里补上游戏名（猜猜呗游戏界面这里是空的绿块）；上面的上游字段不动
        self.assertEqual(r["display"]["shared_work"], {"name": "某 RPG", "name_original": "某 RPG", "count": 1})
        self.assertEqual(r["appearancesCount"], {"guess": 2, "feedback": "+"})        # 特殊游戏不算登场数
        # c5 n=4 → 标签 [战斗 日常 百合]；c1 n=4 → [百合 日常 校园 漫画改]；共有 日常 百合；补 战斗
        # 角色标签共有 黑长直，补 双马尾；声优共有 声优A
        self.assertEqual(r["metaTags"]["guess"], ["日常", "百合", "战斗", "黑长直", "双马尾", "声优A", "声优C"])
        self.assertEqual(r["metaTags"]["shared"], ["日常", "百合", "黑长直", "声优A"])
        self.assertEqual(r["latestAppearance"], {"guess": 2024, "feedback": "="})
        self.assertEqual(r["earliestAppearance"], {"guess": 2023, "feedback": "-"})

    def test_c1_vs_c5_zero_tag_nums(self):
        r = fb(1, 5, n=0, ctn=0)
        # n=0：c1(cut=-1) 不显示标签；角色标签数 0：不显示角色标签；声优照常全列
        self.assertEqual(r["metaTags"], {"guess": ["声优A"], "shared": ["声优A"]})
        self.assertEqual(r["popularity"], {"guess": 550, "feedback": "--"})          # -350 < -900*0.2
        self.assertEqual(r["rating"], {"guess": 8.0, "feedback": "+"})
        self.assertEqual(r["appearancesCount"], {"guess": 1, "feedback": "-"})
        self.assertEqual(r["earliestAppearance"], {"guess": 2024, "feedback": "+"})
        # 共同的只有特殊游戏 202，在 c1 的 id 列表第 2 位（登场名单只有 1 部）→ 没有名字
        self.assertEqual(r["shared_appearances"], {"first": "", "firstOriginal": None, "firstCn": None, "count": 1})
        self.assertEqual(r["display"]["shared_work"]["name"], "某 RPG")

    def test_every_synth_special_game_gets_a_display_name(self):
        # 合成库里 4 条特殊游戏登场：c1 / c5 共有 202「某 RPG」，c4 / c6 共有 201「某 Galgame」。两个方向都要有名字
        snap = HUB.current()
        self.assertEqual(F.extra_apps(snap, "anime"), {1: (202,), 5: (202,), 4: (201,), 6: (201,)})
        for g, a, name in [(1, 5, "某 RPG"), (5, 1, "某 RPG"), (4, 6, "某 Galgame"), (6, 4, "某 Galgame")]:
            r = fb(g, a)
            self.assertEqual(r["shared_appearances"]["count"], 1, (g, a))
            self.assertEqual((r["shared_appearances"]["firstOriginal"], r["shared_appearances"]["firstCn"]),
                             (None, None), (g, a))                                  # 上游字段：特殊游戏没有名字
            self.assertEqual(r["display"]["shared_work"], {"name": name, "name_original": name, "count": 1}, (g, a))

    def test_shared_regular_work_comes_before_special_game(self):
        # c1 的名单是 [101, 202]，c2 是 [101]：共同的第一部是 101（普通作品），display 取它，不去碰特殊游戏
        r = fb(1, 2)
        self.assertEqual(r["display"]["shared_work"], {"name": "百合日常番", "name_original": "百合日常番", "count": 1})

    def test_char_names_original_and_cn(self):
        snap = HUB.current()
        self.assertEqual(F.char_names(snap, [1, 7, 8, 99999]),
                         {1: ("角色一", "角色一"), 7: ("セブン", "七号角色"), 8: ("エイト", None)})
        self.assertEqual(F.char_names(snap, []), {})
        self.assertEqual(F.char_names(snap, [7]), {7: ("セブン", "七号角色")})        # 第二次走缓存，结果一样

    def test_cut_overrides_small_n(self):
        # c2 的 cut=2：n=0 时仍显示前 2 个标签；猜 c2、答案 c3（n=0，c3 cut=-1 → 不显示标签）
        d = fb(2, 3, n=0, ctn=0)["display"]
        self.assertEqual([x["tag"] for x in d["subject_tags"]], [])            # 反馈格子里最多 n 个
        # 但作为答案时，c2 的 2 个标签参与比较：猜 c1(n=2)，共有 百合 日常
        r = fb(1, 2, n=2, ctn=0)
        self.assertEqual(r["metaTags"]["shared"], ["百合", "日常"])
        self.assertEqual(F.shown_tags((0, 1, 2024, 2024, 8.0, 2, None), ["a", "b", "c", "d"], 0), ("a", "b"))
        self.assertEqual(F.shown_tags((0, 1, 2024, 2024, 8.0, -1, None), ["a", "b", "c", "d"], 3), ("a", "b", "c"))
        self.assertEqual(F.shown_tags((0, 1, 2024, 2024, 8.0, 5, None), ["a", "b", "c", "d"], 3), ("a", "b", "c", "d"))
        self.assertEqual(F.shown_tags((0, 0, -1, -1, None, -1, None), ["a"], 3), ())     # 登场数 0：没有标签

    def test_answer_without_appearances(self):
        r = fb(3, 9)                                       # c9 登场数 0，评分 / 年份没有
        self.assertEqual(r["gender"]["feedback"], "yes")   # 男 / 男
        self.assertEqual(r["popularity"], {"guess": 100, "feedback": "--"})          # 100-907
        self.assertEqual(r["rating"], {"guess": 8.0, "feedback": "?"})
        self.assertEqual(r["shared_appearances"], {"first": "", "firstOriginal": "", "firstCn": "", "count": 0})   # 没有共同作品：上游是 ''
        self.assertEqual(r["appearancesCount"], {"guess": 1, "feedback": "+"})
        self.assertEqual(r["metaTags"]["guess"], ["日常", "校园", "百合"])             # 答案没有标签 → 全是补的
        self.assertEqual(r["metaTags"]["shared"], [])
        self.assertEqual(r["latestAppearance"], {"guess": 2024, "feedback": "?"})
        self.assertEqual(r["earliestAppearance"], {"guess": 2024, "feedback": "?"})

    def test_guess_without_appearances(self):
        r = fb(9, 3)
        self.assertEqual(r["popularity"], {"guess": 907, "feedback": "++"})
        self.assertEqual(r["rating"], {"guess": None, "feedback": "?"})
        self.assertEqual(r["appearancesCount"], {"guess": 0, "feedback": "-"})
        self.assertEqual(r["latestAppearance"], {"guess": None, "feedback": "?"})     # 上游这里 guess 是 '?'
        self.assertEqual(r["earliestAppearance"], {"guess": None, "feedback": "?"})   # 上游这里 guess 是 -1
        self.assertEqual(r["metaTags"], {"guess": [], "shared": []})
        self.assertFalse(r["display"]["has_profile"])

    def test_both_without_data(self):
        r = fb(9, 7)                                       # c7 连画像行都没有；c9 男、c7 女
        self.assertEqual(r["gender"]["feedback"], "no")
        self.assertEqual(r["rating"]["feedback"], "?")                                # 两边都没有评分也是 ?
        self.assertEqual(r["latestAppearance"], {"guess": None, "feedback": "="})     # 两边都没有年份是 =
        self.assertEqual(r["earliestAppearance"], {"guess": None, "feedback": "="})
        self.assertEqual(r["appearancesCount"], {"guess": 0, "feedback": "="})

    def test_unknown_gender_vs_known(self):
        r = fb(4, 6)                                       # c4 性别未知（?），c6 男
        self.assertEqual(r["gender"], {"guess": "?", "feedback": "no"})
        self.assertEqual(r["display"]["gender_symbol"], "?")
        self.assertEqual(fb(4, 4)["gender"], {"guess": "?", "feedback": "yes"})     # 两边都是 ? 算相同
        # c4 和 c6 只共有特殊游戏 201
        self.assertEqual(r["shared_appearances"], {"first": "", "firstOriginal": None, "firstCn": None, "count": 1})
        self.assertEqual(r["popularity"], {"guess": 60, "feedback": "++"})            # 40 > 20*0.2
        self.assertEqual(r["rating"], {"guess": 7.0, "feedback": "+"})                # +0.5

    def test_guess_equals_answer(self):
        r = fb(5, 5)
        self.assertTrue(r["correct"])
        self.assertEqual(r["gender"]["feedback"], "yes")
        for k in ("popularity", "rating", "appearancesCount", "latestAppearance", "earliestAppearance"):
            self.assertEqual(r[k]["feedback"], "=", k)
        # 登场 [102, 103] + 特殊 [202]：共同 3 部，第一部是 102
        self.assertEqual(r["shared_appearances"], {"first": "战斗番", "firstOriginal": "战斗番", "firstCn": "战斗番", "count": 3})

    def test_errors(self):
        snap = HUB.current()
        with self.assertRaises(F.SoloError) as cm:
            F.solo_feedback(snap, "anime", 99999, 1, 6, 4)
        self.assertEqual((cm.exception.status, cm.exception.code), (404, "not_found"))
        self.assertNotIn("99999", cm.exception.message)              # 不带 id：它可能是一局的答案
        with self.assertRaises(F.SoloError) as cm:
            F.solo_feedback(snap, "anime", 1, 99999, 6, 4)
        self.assertEqual(cm.exception.code, "not_found")
        self.assertNotIn("99999", cm.exception.message)
        with self.assertRaises(F.SoloError) as cm:
            F.solo_feedback(snap, "nope", 1, 2, 6, 4)
        self.assertEqual(cm.exception.code, "bad_mode")
        for bad in (-1, 11, 1.5, "6", None, True):
            with self.assertRaises(F.SoloError, msg=repr(bad)) as cm:
                F.solo_feedback(snap, "anime", 1, 2, bad, 4)
            self.assertEqual(cm.exception.code, "bad_tag_num")
        with self.assertRaises(F.SoloError):
            F.solo_feedback(snap, "anime", 1, 2, 6, 11)

    def test_other_mode_without_profile_rows(self):
        # 合成库只有 anime 模式画像：其它模式所有角色都是「登场数 0」，但不会报错
        r = fb(1, 2, mode="game")
        self.assertEqual(r["appearancesCount"], {"guess": 0, "feedback": "="})
        self.assertEqual(r["popularity"], {"guess": 550, "feedback": "++"})          # 人气和模式无关

    def test_comments_and_extra_loaded_once(self):
        snap = HUB.current()
        self.assertIs(F.comments_map(snap), F.comments_map(snap))
        self.assertEqual(F.comments_map(snap), {1: 50, 2: 20, 4: 10, 5: 100, 9: 7})
        self.assertEqual(F.extra_apps(snap, "anime"), {1: (202,), 5: (202,), 4: (201,), 6: (201,)})
        self.assertEqual(F.extra_apps(snap, "game"), {})
        # 引擎自己的 apps 仍然不含特殊游戏
        self.assertEqual(snap.mode("anime").apps[5], (102, 103))


class TestPureRules(unittest.TestCase):
    def test_popularity_thresholds(self):
        a = view(heat=100)
        for guess, want in [(100, "="), (105, "="), (95, "="), (106, "+"), (120, "+"), (121, "++"), (94, "-"), (80, "-"),
                            (79, "--"), (0, "--"), (1000, "++")]:
            self.assertEqual(pure(view(heat=guess), a)["popularity"]["feedback"], want, guess)
        # 吐槽数算进人气
        self.assertEqual(pure(view(heat=60, comments=45), a)["popularity"], {"guess": 105, "feedback": "="})
        # 答案人气 0：只有猜的也是 0 才是 =
        z = view(heat=0)
        self.assertEqual(pure(view(heat=0), z)["popularity"]["feedback"], "=")
        self.assertEqual(pure(view(heat=1), z)["popularity"]["feedback"], "++")

    def test_rating_thresholds(self):
        a = view(rating=8.0)
        # 8.3-8.0 在浮点数里是 0.3000000000000007，略大于 0.3，所以是 +（JS 同样）；7.7 则是 0.2999999999999998
        for guess, want in [(8.0, "="), (7.7, "="), (8.2, "="), (8.3, "+"), (7.6, "-"), (8.4, "+"), (7.0, "-"), (9.0, "+"),
                            (9.1, "++"), (6.9, "--"), (0.0, "--")]:
            self.assertEqual(pure(view(rating=guess), a)["rating"]["feedback"], want, guess)
        self.assertEqual(pure(view(rating=None), a)["rating"], {"guess": None, "feedback": "?"})
        self.assertEqual(pure(a, view(rating=None))["rating"]["feedback"], "?")
        self.assertEqual(pure(view(rating=0.0), view(rating=0.0))["rating"]["feedback"], "=")   # 0 分不是「无」

    def test_count_and_year_thresholds(self):
        for diff, want in [(0, "="), (1, "+"), (2, "+"), (3, "++"), (-1, "-"), (-2, "-"), (-3, "--")]:
            self.assertEqual(pure(view(n_app=5 + diff), view(n_app=5))["appearancesCount"]["feedback"], want, diff)
            self.assertEqual(pure(view(latest=2020 + diff), view(latest=2020))["latestAppearance"]["feedback"], want, diff)
            self.assertEqual(pure(view(earliest=2020 + diff), view(earliest=2020))["earliestAppearance"]["feedback"], want, diff)

    def test_shared_appearances_name_vs_id(self):
        # 名字对得上但 id 不同（两部同名作品）：first 有值，count 退回按名字数；没有共同 id → firstOriginal / firstCn 是 ''
        g = view(regular_apps=(1, 2), n_app=2)
        a = view(regular_apps=(3,), n_app=1)
        r = pure(g, a, g_names=[("乙", "乙"), ("甲", "甲中")], a_names=[("甲", "甲")])
        self.assertEqual(r["shared_appearances"], {"first": "甲", "firstOriginal": "", "firstCn": "", "count": 1})
        # id 对得上：firstOriginal / firstCn 取猜的角色名单里同一位置；中文名为空时退回原名
        g = view(regular_apps=(1, 2, 3), n_app=3)
        a = view(regular_apps=(9, 2, 3), n_app=3)
        r = pure(g, a, g_names=[("A", "甲"), ("B", "乙"), ("C", "")], a_names=[("Z", "Z"), ("B", "乙"), ("C", "C")])
        self.assertEqual(r["shared_appearances"], {"first": "B", "firstOriginal": "B", "firstCn": "乙", "count": 2})
        self.assertEqual(r["display"]["shared_work"], {"name": "乙", "name_original": "B", "count": 2})
        r = pure(g, view(regular_apps=(3,), n_app=1), g_names=[("A", "甲"), ("B", "乙"), ("C", "")], a_names=[("C", "C")])
        self.assertEqual(r["shared_appearances"]["firstCn"], "C")        # 中文名为空 → 原名

    def test_special_game_name_only_in_display(self):
        # 猜的角色名单 [甲, 特殊游戏 900]，答案名单 [乙, 特殊游戏 900]：没有共同的普通作品，第一个共同的是 900
        g = view(regular_apps=(1,), extra_apps=(900, 901), n_app=1)
        a = view(regular_apps=(2,), extra_apps=(900,), n_app=1)
        names = dict(g_names=[("甲", "甲")], a_names=[("乙", "乙")])

        def run(extra_names):
            return F.compute_feedback(g, a, 6, 4, names["g_names"], names["a_names"], extra_names)

        # 中文名优先，原名放 name_original；上游字段仍是 None
        r = run({900: ("ゲーム", "游戏"), 901: ("別", "别")})
        self.assertEqual(r["display"]["shared_work"], {"name": "游戏", "name_original": "ゲーム", "count": 1})
        self.assertEqual(r["shared_appearances"], {"first": "", "firstOriginal": None, "firstCn": None, "count": 1})
        # 没有中文名（库里的 (原名, 中文名 or 原名)）→ 两边都是原名
        self.assertEqual(run({900: ("ゲーム", "")})["display"]["shared_work"]["name"], "ゲーム")
        self.assertEqual(run({900: ("ゲーム", "ゲーム")})["display"]["shared_work"],
                         {"name": "ゲーム", "name_original": "ゲーム", "count": 1})
        # 名字查不到（没传 / 不在表里）→ 是 None，不报错
        for nm in (None, {}, {901: ("別", "别")}):
            self.assertEqual(run(nm)["display"]["shared_work"], {"name": None, "name_original": None, "count": 1})
        # 普通作品在前：用普通作品，不碰特殊游戏的名字
        g2 = view(regular_apps=(1, 2), extra_apps=(900,), n_app=2)
        a2 = view(regular_apps=(2,), extra_apps=(900,), n_app=1)
        r = F.compute_feedback(g2, a2, 6, 4, [("甲", "甲"), ("乙", "乙中")], [("乙", "乙")], {900: ("ゲーム", "游戏")})
        self.assertEqual(r["display"]["shared_work"], {"name": "乙中", "name_original": "乙", "count": 2})

    def test_tag_selection_and_caps(self):
        g = view(tags=("a", "b", "c", "d", "e", "f"), char_tags=("p", "q", "r", "s", "t"), vas=("v1", "v2"))
        a = view(tags=("f", "e", "z"), char_tags=("t", "q"), vas=("v2",))
        r = pure(g, a, n=3, ctn=2)
        # 共有按猜的顺序：e f（≤3），再补不共有的 a（凑满 3 个）
        self.assertEqual(r["display"]["subject_tags"], [{"tag": "e", "shared": True}, {"tag": "f", "shared": True},
                                                        {"tag": "a", "shared": False}])
        # 角色标签：共有 q t（≤2），不再补
        self.assertEqual([x["tag"] for x in r["display"]["char_tags"]], ["q", "t"])
        self.assertEqual(r["metaTags"]["guess"], ["e", "f", "a", "q", "t", "v1", "v2"])
        self.assertEqual(r["metaTags"]["shared"], ["e", "f", "q", "t", "v2"])
        # 共有的比 n 还多：只取前 n 个
        r = pure(g, view(tags=("a", "b", "c", "d")), n=2, ctn=0)
        self.assertEqual(r["metaTags"]["shared"], ["a", "b"])
        self.assertEqual(r["metaTags"]["guess"], ["a", "b", "v1", "v2"])

    def test_cross_category_duplicates_collapse_like_upstream_set(self):
        # 上游用 Set 把三类合成一个列表：作品标签、角色标签、声优之间重名只留第一个
        g = view(tags=("同名", "x"), char_tags=("同名",), vas=("同名",))
        a = view(tags=("同名",), char_tags=("同名",), vas=("同名",))
        r = pure(g, a, n=2, ctn=1)
        self.assertEqual(r["metaTags"], {"guess": ["同名", "x"], "shared": ["同名"]})
        # 分类显示不合并
        self.assertEqual(len(r["display"]["subject_tags"]) + len(r["display"]["char_tags"]) + len(r["display"]["vas"]), 4)


if __name__ == "__main__":
    unittest.main()
