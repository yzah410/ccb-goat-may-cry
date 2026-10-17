# -*- coding: utf-8 -*-
"""调度器（backend/v2/solo/scheduler.py）的单元测试。

最后一组测试检查 `parts`（每段对总进度的贡献）。
调度器是纯逻辑，不碰库、不碰磁盘，所以这里不用合成库。
"""
import json
import math
import unittest

from backend.v2.solo.scheduler import (Params, Scheduler, apply_grade, blank_item, choose_next,
                                       progress, stable_threshold)

NOJ = Params(jitter=0.0)  # 关掉随机因子，方便手算
LEECH = Params(jitter=0.0, leech_fails=3)  # 停放默认关（难记的角色照常出现），要测停放的用例显式打开


def play(sch, grades, t0=0.0, dur=60.0):
    """按顺序玩几局，返回 [(key, grade)]。"""
    out, t = [], t0
    for g in grades:
        k = sch.start_next(t)
        sch.finish(g, t + dur)
        out.append((k, g))
        t += dur + 5
    return out, t


def keys(n):
    return [f"anime:{i}" for i in range(n)]


class ApplyGradeTests(unittest.TestCase):
    def test_first_hard_and_again_go_to_relearn_gap(self):
        for g in ("hard", "again"):
            it = apply_grade(blank_item(), g, None, NOJ, "k")
            self.assertEqual(it["I"], NOJ.relearn_gap)
            self.assertEqual(it["proven"], 0.0)
            self.assertEqual(it["seen"], 1)
        self.assertEqual(apply_grade(blank_item(), "again", None, NOJ, "k")["fails"], 1)

    def test_first_good_means_already_known(self):
        it = apply_grade(blank_item(), "good", None, NOJ, "k")
        self.assertEqual(it["I"], NOJ.known_gap)
        self.assertGreaterEqual(it["proven"], NOJ.stable_gap)

    def test_on_time_growth_factors(self):
        base = dict(blank_item(), seen=2, I=4.0, last=0.0)
        g = NOJ.growth
        self.assertAlmostEqual(apply_grade(base, "good", 4, NOJ, "k")["I"], 4 * g)
        self.assertAlmostEqual(apply_grade(base, "easy", 4, NOJ, "k")["I"], 4 * g * g)
        self.assertAlmostEqual(apply_grade(base, "hard", 4, NOJ, "k")["I"], 4 * math.sqrt(g))
        self.assertEqual(apply_grade(base, "again", 4, NOJ, "k")["I"], NOJ.relearn_gap)

    def test_overdue_credit_is_capped(self):
        base = dict(blank_item(), seen=2, I=4.0, last=0.0)
        it = apply_grade(base, "good", 10_000, NOJ, "k")
        self.assertAlmostEqual(it["I"], 4.0 * NOJ.overdue_cap * NOJ.growth)
        self.assertEqual(it["proven"], 10_000)  # 进度按真实间隔记

    def test_early_good_never_shrinks(self):
        base = dict(blank_item(), seen=3, I=20.0, last=0.0)
        self.assertEqual(apply_grade(base, "good", 3, NOJ, "k")["I"], 20.0)
        self.assertAlmostEqual(apply_grade(base, "good", 9, NOJ, "k")["I"], 9 * NOJ.growth)

    def test_early_hard_pulls_back_but_not_below_relearn(self):
        base = dict(blank_item(), seen=3, I=20.0, last=0.0)
        it = apply_grade(base, "hard", 4, NOJ, "k")
        self.assertAlmostEqual(it["I"], 4 * math.sqrt(NOJ.growth))

    def test_lapse_remembers_fallback_and_jumps_back(self):
        it = dict(blank_item(), seen=4, I=30.0, proven=12.0, last=0.0)
        it = apply_grade(it, "again", 31, NOJ, "k")
        self.assertEqual(it["I"], NOJ.relearn_gap)
        self.assertEqual(it["F"], 12.0)
        self.assertEqual(it["proven"], 0.0)
        it = apply_grade(it, "good", 2, NOJ, "k")
        self.assertEqual(it["I"], 12.0)   # 跳回 12，而不是 2×2.5=5
        self.assertIsNone(it["F"])

    def test_second_consecutive_lapse_drops_fallback(self):
        it = dict(blank_item(), seen=4, I=30.0, proven=12.0, last=0.0)
        it = apply_grade(it, "again", 31, NOJ, "k")
        it = apply_grade(it, "again", 2, NOJ, "k")
        self.assertIsNone(it["F"])

    def test_leech_parking(self):
        it = apply_grade(blank_item(), "again", None, LEECH, "k")   # fails=1
        it = apply_grade(it, "again", 2, LEECH, "k")                # fails=2
        self.assertEqual(it["I"], LEECH.relearn_gap)
        it = apply_grade(it, "again", 2, LEECH, "k")                # fails=3 → 停放
        self.assertEqual(it["I"], LEECH.park_gap)
        self.assertEqual(it["parked"], 1)
        self.assertEqual(it["fails"], 0)
        self.assertEqual(it["lapses"], 3)

    def test_leech_parking_off_by_default(self):
        self.assertEqual(Params().leech_fails, 0)
        it = apply_grade(blank_item(), "again", None, NOJ, "k")
        for _ in range(6):                                          # 连续 Again 很多次也不停放
            it = apply_grade(it, "again", 2, NOJ, "k")
            self.assertEqual(it["I"], NOJ.relearn_gap)
        self.assertEqual(it["parked"], 0)
        self.assertEqual(it["lapses"], 7)

    def test_jitter_is_deterministic_and_bounded(self):
        p = Params()
        a = apply_grade(blank_item(), "hard", None, p, "anime:1")["I"]
        b = apply_grade(blank_item(), "hard", None, p, "anime:1")["I"]
        self.assertEqual(a, b)
        self.assertTrue(p.relearn_gap * 0.85 - 1e-9 <= a <= p.relearn_gap * 1.15 + 1e-9)

    def test_bad_grade(self):
        with self.assertRaises(ValueError):
            apply_grade(blank_item(), "meh", None, NOJ, "k")


class RegradeTests(unittest.TestCase):
    def _pair(self):
        a = Scheduler.new(keys(6), params=Params())
        b = Scheduler.new(keys(6), params=Params())
        return a, b

    def test_regrade_after_next_game_already_picked_equals_direct(self):
        a, b = self._pair()
        play(a, ["hard", "hard", "good"])
        play(b, ["hard", "hard", "good"])
        # 第 4 局：a 先按 good 记，下一局开始后改成 again；b 直接记 again
        ka = a.start_next(1000); a.finish("good", 1060)
        kb = b.start_next(1000); b.finish("again", 1060)
        self.assertEqual(ka, kb)
        nxt = a.start_next(1065)          # 下一局已经按旧评分选好
        a.regrade(ka, "again")            # 在下一局进行中改评分
        ia, ib = a.state["items"][ka], b.state["items"][kb]
        for f in ("seen", "I", "last", "F", "fails", "proven", "lapses", "parked"):
            self.assertEqual(ia[f], ib[f], f)
        self.assertEqual(ia["rev"]["grade"], "again")
        # 下一局照常结束，计数不乱
        a.finish("hard", 1120)
        self.assertEqual(a.state["games"], 5)
        self.assertNotEqual(nxt, ka)

    def test_regrade_many_times_counts_once(self):
        a, _ = self._pair()
        play(a, ["hard", "hard"])
        k = a.start_next(500); a.finish("again", 560)
        lapses = a.state["items"][k]["lapses"]
        a.regrade(k, "good"); a.regrade(k, "again"); a.regrade(k, "again")
        self.assertEqual(a.state["items"][k]["lapses"], lapses)
        a.regrade(k, "hard")
        self.assertEqual(a.state["items"][k]["lapses"], lapses - 1)
        self.assertEqual(a.state["items"][k]["fails"], 0)

    def test_regrade_first_appearance(self):
        a, _ = self._pair()
        k = a.start_next(0); a.finish("hard", 60)
        a.start_next(65)
        a.regrade(k, "good")
        it = a.state["items"][k]
        self.assertEqual(it["seen"], 1)
        self.assertEqual(it["proven"], Params().known_gap)
        self.assertNotIn(k, a.state["new_queue"])
        a.regrade(k, "again")
        self.assertEqual(a.state["items"][k]["proven"], 0.0)
        self.assertEqual(a.state["since_new"], 0)

    def test_stale_regrade_rejected(self):
        a = Scheduler.new(["x", "y", "z"], params=Params(min_gap=1))
        kx = a.start_next(0); a.finish("hard", 60)
        old_vt = a.state["items"][kx]["rev"]["vt"]
        # 让 x 再出现一次
        t = 100
        while True:
            k = a.start_next(t); a.finish("good", t + 30); t += 40
            if k == kx:
                break
        with self.assertRaises(ValueError):
            a.regrade(kx, "again", vt=old_vt)

    def test_regrade_unknown(self):
        a, _ = self._pair()
        with self.assertRaises(KeyError):
            a.regrade("anime:0", "good")

    def test_regrade_progress_event(self):
        a, _ = self._pair()
        k = a.start_next(0); a.finish("hard", 60)
        a.regrade(k, "good")
        ev = {e["type"] for e in progress(a.state)["events"]}
        self.assertIn("regraded", ev)
        self.assertIn("known_on_sight", ev)

    def test_regrade_delta_vs_shown_state(self):
        # 改评分事件的 delta_total = 改后总进度 - 改前屏幕上的总进度
        a = Scheduler.new(keys(12), shuffle_seed=3)
        k0 = a.start_next(0); a.finish("again", 60)
        for i in range(1, 6):
            k = a.start_next(60 * i + 5)
            a.finish("good" if k == k0 else "hard", 60 * i + 60)
            if k == k0:
                break
        self.assertEqual(k, k0)
        shown = progress(a.state)["total"]
        a.start_next(10_000)              # 下一局已经开始
        a.regrade(k0, "again")
        pr = progress(a.state)
        ev = {e["type"]: e for e in pr["events"]}
        self.assertEqual(set(ev), {"regraded"})
        self.assertLess(ev["regraded"]["delta_total"], 0)
        self.assertAlmostEqual(shown + ev["regraded"]["delta_total"], pr["total"], places=1)


class SelectionTests(unittest.TestCase):
    def test_no_immediate_repeat(self):
        sch = Scheduler.new(keys(5))
        seq, _ = play(sch, ["again"] * 40)
        ks = [k for k, _ in seq]
        for i in range(2, len(ks)):
            self.assertNotIn(ks[i], ks[i - 2:i])

    def test_new_floor_under_many_failures(self):
        sch = Scheduler.new(keys(200), params=Params(leech_fails=0))
        seq, _ = play(sch, ["again"] * 60)
        firsts, seen = [], set()
        for i, (k, _) in enumerate(seq):
            if k not in seen:
                firsts.append(i)
                seen.add(k)
        gaps = [b - a for a, b in zip(firsts, firsts[1:])]
        self.assertLessEqual(max(gaps), Params().new_every)

    def test_due_beats_new_when_floor_not_reached(self):
        sch = Scheduler.new(keys(50), params=NOJ)
        play(sch, ["hard", "hard", "hard"])   # 0,1,2 号都在 I=2
        st = sch.state
        k, why = choose_next(st, st["vt"] + 1, sch.p)
        self.assertEqual(why, "due")

    def test_same_work_spacing(self):
        pool = [f"a{i}" for i in range(4)] + [f"b{i}" for i in range(4)] + [f"c{i}" for i in range(4)]
        groups = {k: [k[0]] for k in pool}
        sch = Scheduler.new(pool, groups, params=Params(work_gap=2))
        seq, _ = play(sch, ["good"] * 12)
        works = [k[0] for k, _ in seq]
        for i in range(1, len(works)):
            self.assertNotIn(works[i], works[max(0, i - 2):i])

    def test_same_work_relaxes_when_impossible(self):
        pool = [f"a{i}" for i in range(5)]
        sch = Scheduler.new(pool, {k: ["a"] for k in pool})
        seq, _ = play(sch, ["good"] * 8)
        self.assertEqual(len(seq), 8)

    def test_tiny_pools(self):
        for n in (1, 2, 3):
            sch = Scheduler.new(keys(n))
            seq, _ = play(sch, ["hard", "good", "again", "good", "easy"])
            self.assertEqual(len(seq), 5)
        self.assertIsNone(Scheduler.new([]).start_next(0))

    def test_small_pool_goes_early_and_saturates(self):
        sch = Scheduler.new(keys(9))
        _, t = play(sch, ["good"] * 40)
        pr = progress(sch.state)
        self.assertTrue(pr["saturated"])
        self.assertEqual(pr["total"], 100.0)

    def test_pause_converts_to_games(self):
        sch = Scheduler.new(keys(30), params=NOJ)
        _, t = play(sch, ["hard"] * 3)
        vt0 = sch.state["vt"]
        sch.start_next(t + 86400)
        self.assertAlmostEqual(sch.state["vt"] - vt0, 1 + (86400 + 5) / 60.0, places=3)
        # 短空闲不折算
        sch.finish("hard", t + 86460)
        vt1 = sch.state["vt"]
        sch.start_next(t + 86460 + 100)
        self.assertEqual(sch.state["vt"] - vt1, 1.0)

    def test_after_a_day_old_items_are_due_first(self):
        sch = Scheduler.new(keys(100))
        _, t = play(sch, ["hard"] * 10)
        k = sch.start_next(t + 86400)
        self.assertIn(k, sch.state["items"])          # 复习旧的，不是新角色
        self.assertEqual(sch.state["current"]["why"], "due")

    def test_unfinished_game_is_dropped(self):
        sch = Scheduler.new(keys(10))
        sch.start_next(0)
        k2 = sch.start_next(30)   # 上一局没结束就开了下一局
        sch.finish("good", 60)
        self.assertEqual(sch.state["games"], 1)
        self.assertIn(k2, sch.state["items"])


class PersistenceTests(unittest.TestCase):
    def test_json_round_trip_same_behaviour(self):
        a = Scheduler.new(keys(40), {k: [k[-1]] for k in keys(40)}, shuffle_seed=7)
        _, t = play(a, ["hard", "good", "again", "good", "hard", "easy"])
        b = Scheduler.from_json(a.to_json())
        json.loads(a.to_json())  # 必须是合法 JSON（没有 Infinity）
        for i in range(30):
            ga = ["good", "hard", "again"][i % 3]
            ka = a.start_next(t); a.finish(ga, t + 50)
            kb = b.start_next(t); b.finish(ga, t + 50)
            self.assertEqual(ka, kb)
            t += 55
        self.assertEqual(a.state, b.state)

    def test_set_pool_keeps_progress(self):
        sch = Scheduler.new(["a", "b", "c", "d"])
        play(sch, ["good"] * 4)
        sch.set_pool(["c", "d", "e", "f"])
        self.assertEqual(sch.state["new_queue"], ["e", "f"])
        self.assertIn("a", sch.state["items"])
        segs = {s["id"]: s["count"] for s in progress(sch.state)["segments"]}
        self.assertEqual(segs["unseen"], 2)

    def test_bad_version(self):
        with self.assertRaises(ValueError):
            Scheduler({"version": 999, "pool": []})


class ProgressTests(unittest.TestCase):
    def test_threshold_shrinks_for_small_pool(self):
        self.assertEqual(stable_threshold(9, Params()), 7.0)
        self.assertEqual(stable_threshold(200, Params()), 10.0)
        self.assertEqual(stable_threshold(2, Params()), 1.0)

    def test_new_character_is_not_a_penalty(self):
        sch = Scheduler.new(keys(20))
        play(sch, ["hard", "good"])
        before = progress(sch.state)["total"]
        k = sch.start_next(1000)
        self.assertNotIn(k, [x for x in sch.state["items"] if sch.state["items"][x]["seen"] > 0])
        sch.finish("hard", 1100)
        pr = progress(sch.state)
        self.assertEqual(pr["total"], before)
        self.assertEqual([e["type"] for e in pr["events"]], ["new_character"])

    def test_lapse_drops_total(self):
        sch = Scheduler.new(["a", "b", "c", "d", "e", "f"], params=NOJ)
        it = dict(blank_item(), seen=3, I=8.0, last=0.0, last_ts=0.0, proven=5.0)
        sch.state["items"]["a"] = it
        sch.state["new_queue"].remove("a")
        sch.state["vt"] = 20.0
        before = progress(sch.state)["total"]
        sch.state["current"] = {"key": "a", "vt": 21.0, "start_ts": 100.0, "why": "due"}
        sch.finish("again", 160)
        pr = progress(sch.state)
        self.assertLess(pr["total"], before)
        types = [e["type"] for e in pr["events"]]
        self.assertIn("lapse", types)
        self.assertLess(pr["events"][0]["delta_total"], 0)

    def test_events_level_up_stable_all_stable(self):
        sch = Scheduler.new(["a", "b", "c", "d", "e", "f"], params=NOJ)
        for k in "bcdef":
            sch.state["items"][k] = dict(blank_item(), seen=2, I=50.0, last=0.0, last_ts=0.0, proven=30.0)
            sch.state["new_queue"].remove(k)
        sch.state["items"]["a"] = dict(blank_item(), seen=2, I=4.0, last=0.0, last_ts=0.0, proven=2.0)
        sch.state["new_queue"].remove("a")
        sch.state["current"] = {"key": "a", "vt": 6.0, "start_ts": 10.0, "why": "due"}
        sch.finish("good", 40)
        types = [e["type"] for e in progress(sch.state)["events"]]
        self.assertEqual(types, ["level_up", "became_stable", "all_stable"])
        self.assertEqual(progress(sch.state)["total"], 100.0)

    def test_recalled_after_break(self):
        sch = Scheduler.new(keys(30))
        k = sch.start_next(0); sch.finish("hard", 60)
        # 一天后
        t = 86400.0
        while True:
            kk = sch.start_next(t); sch.finish("good", t + 30); t += 40
            if kk == k:
                break
        types = [e["type"] for e in progress(sch.state)["events"]]
        self.assertIn("recalled_after_break", types)
        self.assertIn("became_stable", types)

    def test_parked_event(self):
        sch = Scheduler.new(["a", "b", "c"], params=Params(min_gap=1, new_every=0, leech_fails=3))
        t = 0
        hits = 0
        while hits < 3:
            k = sch.start_next(t)
            sch.finish("again" if k == "a" else "good", t + 30)
            t += 40
            if k == "a":
                hits += 1
        types = [e["type"] for e in progress(sch.state)["events"]]
        self.assertIn("parked", types)

    def test_segments_sum_to_pool(self):
        sch = Scheduler.new(keys(50))
        play(sch, ["hard", "good", "again", "good", "hard", "good", "good"] * 3)
        pr = progress(sch.state)
        self.assertEqual(sum(s["count"] for s in pr["segments"]), 50)
        self.assertTrue(0 <= pr["total"] <= 100)


class ProgressPartsTests(unittest.TestCase):
    """parts = 每段角色的巩固度之和 ÷ 题库人数 × 100，未出现恒为 0。"""

    @staticmethod
    def _pct(pr):
        return {x["id"]: x["pct"] for x in pr["parts"]}

    def test_empty_progress_all_zero(self):
        pr = progress(Scheduler.new(keys(10)).state)
        self.assertEqual([x["id"] for x in pr["parts"]], ["stable", "consolidating", "learning", "unseen"])
        self.assertTrue(all(x["pct"] == 0.0 for x in pr["parts"]))
        self.assertEqual([x["label"] for x in pr["parts"]], [x["label"] for x in pr["segments"]])

    def test_empty_pool_does_not_divide_by_zero(self):
        pr = progress(Scheduler.new([]).state)
        self.assertEqual(pr["total"], 0.0)
        self.assertTrue(all(x["pct"] == 0.0 for x in pr["parts"]))

    def test_hand_computed_parts(self):
        # 题库 10 人 → 稳定线 = min(10, 10-2) = 8。
        # a 稳定（proven 30 → 1.0）；b、c 巩固中（proven 4 → 0.5，proven 2 → 0.25）；d 学习中（proven 0）；其余 6 人未出现
        sch = Scheduler.new(keys(10), params=NOJ)
        names = keys(10)
        for k, proven in zip(names[:4], (30.0, 4.0, 2.0, 0.0)):
            sch.state["items"][k] = dict(blank_item(), seen=2, I=5.0, last=0.0, last_ts=0.0, proven=proven)
            sch.state["new_queue"].remove(k)
        pr = progress(sch.state)
        self.assertEqual(pr["stable_gap"], 8.0)
        self.assertEqual({s["id"]: s["count"] for s in pr["segments"]},
                         {"stable": 1, "consolidating": 2, "learning": 1, "unseen": 6})
        pct = self._pct(pr)
        self.assertAlmostEqual(pct["stable"], 10.0, places=2)           # 1.0 / 10 * 100
        self.assertAlmostEqual(pct["consolidating"], 7.5, places=2)     # (0.5 + 0.25) / 10 * 100
        self.assertEqual(pct["learning"], 0.0)
        self.assertEqual(pct["unseen"], 0.0)
        self.assertAlmostEqual(pr["total"], 17.5, places=2)

    def test_parts_add_up_to_total(self):
        sch = Scheduler.new(keys(50), shuffle_seed=11)
        play(sch, ["hard", "good", "again", "good", "hard", "good", "easy", "good"] * 4)
        pr = progress(sch.state)
        self.assertAlmostEqual(sum(x["pct"] for x in pr["parts"]), pr["total"], delta=0.02)
        self.assertEqual(self._pct(pr)["unseen"], 0.0)
        self.assertTrue(all(x["pct"] >= 0 for x in pr["parts"]))

    def test_parts_json_serializable_and_keys_unchanged(self):
        pr = progress(Scheduler.new(keys(5)).state)
        json.dumps(pr)
        self.assertEqual(set(pr), {"total", "segments", "parts", "stable_gap", "saturated", "events"})


if __name__ == "__main__":
    unittest.main()
