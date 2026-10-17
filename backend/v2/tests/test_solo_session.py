# -*- coding: utf-8 -*-
"""单人版对局（backend/v2/solo/session.py + session_router.py）：评级规则逐条测。

- 用 synth.py 的合成库（base.all_with() 的题库 = c1…c17 共 17 人）；
- 每个用例都用自己的临时 OUTSETTER_V2_DATA_DIR（进度文件、日志都落在里面），结束后恢复；
- 时钟可注入（Clock），时间由用例手动推进，不会真 sleep；
- 要固定答案时 patch 掉 Scheduler.start_next（forced），不靠随机。

合成库里的几个关键角色（动画模式，作品标签数 6、角色标签数 0）：
- 答案 c1：「答案的作品」= 101，作品里登场的有 c1 c2 c3 c12 c13–c17。
  不在 101 的人（猜错）：c4–c11。c9→c10 区分不了（第 1 次猜 c9，第 2 次猜 c10：每一格都和真实的表一样）；
  c7、c6、c8 互相能区分。
- 答案 c10：「答案的作品」= 201（只有 c10 自己）。c9→c12→c2 连续两次「区分不了」。
- 答案 c5：「答案的作品」= 102（c4 c5）；c8 和 c5 同在 103（联动 / 续作），不算猜中。
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import re
import shutil
import tempfile
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from . import base
from backend.v2.solo import session as S
from backend.v2.solo import session_router
from backend.v2.solo.scheduler import Params, Scheduler, apply_grade, blank_item
from backend.v2.solo.session import SOLO
from backend.v2.store import with_snapshot

app = FastAPI()
app.include_router(session_router.router)
client = TestClient(app)

SPEC_ALL = base.all_with()                                   # 17 人：c1…c17
SPEC_RANK2 = base.spec([base.one(base.rng(rank_to=2), id="r_t1")])   # 9 人：c1 c2 c4 c5 c13–c17（不含 c9 c10 c12）
URL = "/v2/solo"


class Clock:
    def __init__(self, t: float = 1_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, sec: float) -> float:
        self.t += sec
        return self.t


@contextlib.contextmanager
def forced(answer: int):
    """让调度器这一局的答案是 c<answer>（其余照常：vt、why、保存）。"""
    orig = Scheduler.start_next

    def fake(self, now):
        key = orig(self, now)
        if key is None:
            return key
        forced_key = f"char:{answer}"
        self.state["current"]["key"] = forced_key
        return forced_key

    with mock.patch.object(Scheduler, "start_next", fake):
        yield


def iv(a, b, sec, via="name", bonus=0):
    """结算块里 timing.intervals 的一项（猜测默认 via="name"、没有加时）。"""
    return {"from": a, "to": b, "sec": sec, "via": via, "bonus_sec": bonus}


def deep_keys(obj):
    """一个 JSON 结构里出现过的所有键（任意深度）。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from deep_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from deep_keys(v)


class SoloCase(unittest.TestCase):
    """每个用例：新的临时数据目录 + 假时钟 + 清空内存里的会话。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="solo_test_")
        self._old_env = os.environ.get("OUTSETTER_V2_DATA_DIR")
        os.environ["OUTSETTER_V2_DATA_DIR"] = self.tmp
        self.clock = Clock()
        self._old_clock = SOLO.clock
        SOLO.clock = self.clock
        SOLO.reset()
        self.addCleanup(self._restore)

    def _restore(self):
        SOLO.clock = self._old_clock
        SOLO.reset()
        if self._old_env is None:
            os.environ.pop("OUTSETTER_V2_DATA_DIR", None)
        else:
            os.environ["OUTSETTER_V2_DATA_DIR"] = self._old_env
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 请求小工具
    def post(self, path, **body):
        return client.post(URL + path, json=body)

    def ok(self, r):
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def err(self, r, status, code):
        self.assertEqual(r.status_code, status, r.text)
        d = r.json()
        self.assertFalse(d["ok"])
        self.assertEqual(d["error"], code)
        self.assertTrue(d["message"])
        return d

    def new_session(self, practice="work", spec=None, **kw):
        return self.ok(self.post("/session", spec=spec or SPEC_ALL, practice=practice, **kw))

    def start(self, sid, answer, **kw):
        with forced(answer):
            return self.ok(self.post("/round/start", session_id=sid, **kw))

    def guess(self, sid, rid, gid, dt=0.0, via=None):
        """via=None：请求里不带 via 这个字段（要发 null 就直接 self.post）。"""
        self.clock.advance(dt)
        extra = {} if via is None else {"via": via}
        return self.post("/round/guess", session_id=sid, round_id=rid, guess_id=gid, **extra)

    def timeout(self, sid, rid, dt=0.0):
        self.clock.advance(dt)
        return self.post("/round/timeout", session_id=sid, round_id=rid)

    def surrender(self, sid, rid):
        return self.ok(self.post("/round/surrender", session_id=sid, round_id=rid))

    def regrade(self, sid, rid, grade):
        return self.post("/round/regrade", session_id=sid, round_id=rid, grade=grade)

    def play(self, answer, steps, practice="work", session=None, **start_kw):
        """开一局，按 steps 依次操作：(等多少秒, 猜的角色 id 或 "timeout"[, via])。返回 (会话, 开局响应, 每步响应, 结束块)。"""
        sess = session or self.new_session(practice=practice)
        sid = sess["session_id"]
        st = self.start(sid, answer, **start_kw)
        results, end = [], None
        for step in steps:
            dt, act = step[0], step[1]
            via = step[2] if len(step) > 2 else None
            r = (self.timeout(sid, st["round_id"], dt) if act == "timeout"
                 else self.guess(sid, st["round_id"], act, dt, via))
            d = self.ok(r)
            results.append(d)
            if d.get("end"):
                end = d["end"]
        return sess, st, results, end

    # ---- 读盘小工具
    def sched_file(self, mode="anime", practice="work"):
        return os.path.join(self.tmp, "solo_v2", f"sched_{mode}_{practice}.json")

    def log_file(self, mode="anime", practice="work"):
        return os.path.join(self.tmp, "solo_v2", f"log_{mode}_{practice}.jsonl")

    def saved(self, mode="anime", practice="work"):
        with open(self.sched_file(mode, practice), encoding="utf-8") as f:
            return json.load(f)

    def log_lines(self, mode="anime", practice="work"):
        path = self.log_file(mode, practice)
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as f:
            return [json.loads(x) for x in f if x.strip()]

    def indistinguishable(self, answer, earlier, g, n=6, ctn=0):
        """用例前提检查：假设 g 是答案，对 earlier 里每次猜测重算反馈，是否每一格都和真实的表一样。"""
        def run(snap):
            return all(S.strip_feedback(S.solo_feedback(snap, "anime", p, g, n, ctn))
                       == S.strip_feedback(S.solo_feedback(snap, "anime", p, answer, n, ctn)) for p in earlier)
        return with_snapshot(run)


# ================================================================ 纯函数
class TestPureRules(unittest.TestCase):
    def test_validators(self):
        self.assertEqual(S.check_practice("work"), "work")
        self.assertEqual(S.check_practice("char"), "char")
        for bad in ("nope", None, 1):
            with self.assertRaises(S.SoloError) as cm:
                S.check_practice(bad)
            self.assertEqual((cm.exception.status, cm.exception.code), (422, "bad_practice"))
        self.assertIsNone(S.check_new_every(None))
        self.assertEqual((S.check_new_every(0), S.check_new_every(20)), (0, 20))
        for bad in (-1, 21, 1.5, "4", True):
            with self.assertRaises(S.SoloError) as cm:
                S.check_new_every(bad)
            self.assertEqual(cm.exception.code, "bad_new_every")
        self.assertEqual(S.check_good_sec(None), 10)
        self.assertEqual((S.check_good_sec(1), S.check_good_sec(120), S.check_good_sec(7.5)), (1, 120, 7.5))
        for bad in (0, 0.5, 121, "10", True, float("nan")):
            with self.assertRaises(S.SoloError) as cm:
                S.check_good_sec(bad)
            self.assertEqual(cm.exception.code, "bad_good_sec")
        self.assertIsNone(S.check_time_limit(None))
        self.assertEqual((S.check_time_limit(1), S.check_time_limit(60)), (1, 60))
        for bad in (0, 61, "5", False):
            with self.assertRaises(S.SoloError) as cm:
                S.check_time_limit(bad)
            self.assertEqual(cm.exception.code, "bad_time_limit")

    def test_strip_feedback_drops_answer_and_correct(self):
        fb = {"guess_id": 3, "answer_id": 1, "correct": False, "gender": {"feedback": "yes"}}
        self.assertEqual(S.strip_feedback(fb), {"guess_id": 3, "gender": {"feedback": "yes"}})

    def test_intervals_start_from_row_two(self):
        # 第 1 行 t=0，第 2 行 t=3，第 3 行 t=8，第 4 行 t=20：计时从第 2 行开始 → 2→3 = 5，3→4 = 12
        times = [0, 3, 8, 20]
        self.assertEqual(S.interval_secs(times), [(2, 3, 5), (3, 4, 12)])
        self.assertEqual(S.interval_secs(times, last=3), [(2, 3, 5)])
        self.assertEqual(S.interval_secs([0, 3]), [])
        tb = S.timing_block(times, 10)
        # 每个间隔还带 via / bonus_sec（没给 vias 时 via 是 None = 来源不明，bonus_sec 是 0）
        self.assertEqual(tb["intervals"], [{"from": 2, "to": 3, "sec": 5, "via": None, "bonus_sec": 0},
                                           {"from": 3, "to": 4, "sec": 12, "via": None, "bonus_sec": 0}])
        self.assertEqual((tb["avg_sec"], tb["good_sec"], tb["work_bonus_sec"], tb["threshold_sec"]), (8.5, 10, 0, 10))
        self.assertIsNone(S.timing_block([0, 3], 10)["avg_sec"])

    def test_auto_grade_rules(self):
        # 第 1、2 行猜中：不计时，永远 good
        self.assertEqual(S.auto_grade(1, [0], 10, False), "good")
        self.assertEqual(S.auto_grade(2, [0, 500], 10, False), "good")
        # 第 3 行：2→3 间隔 ≤ good_sec → good（含等于），> → hard
        self.assertEqual(S.auto_grade(3, [0, 5, 15], 10, False), "good")          # 10.0
        self.assertEqual(S.auto_grade(3, [0, 5, 15.5], 10, False), "hard")        # 10.5
        self.assertEqual(S.auto_grade(3, [0, 5, 15.5], 11, False), "good")        # good_sec 可调
        # 第 4、5 行：取各间隔平均（最后一个间隔 12 > 10，但平均 9 ≤ 10 → good）
        self.assertEqual(S.auto_grade(4, [0, 2, 8, 20], 10, False), "good")
        self.assertEqual(S.auto_grade(4, [0, 2, 8, 30], 10, False), "hard")       # (6+22)/2 = 14
        self.assertEqual(S.auto_grade(5, [0, 2, 8, 16, 28], 10, False), "good")   # (6+8+12)/3 ≈ 8.67
        self.assertEqual(S.auto_grade(5, [0, 2, 8, 16, 48], 10, False), "hard")   # (6+8+32)/3 ≈ 15.3
        # 只算到猜中那一行：后面多出来的时间戳不参与
        self.assertEqual(S.auto_grade(3, [0, 5, 15, 999], 10, False), "good")
        # Again 锁定：不管多快都是 again
        self.assertEqual(S.auto_grade(2, [0, 1], 10, True), "again")
        self.assertEqual(S.auto_grade(4, [0, 1, 2, 3], 10, True), "again")

    def test_auto_grade_never_easy(self):
        seen = set()
        for seq in range(1, 8):
            for gap in (0.1, 5, 9.9, 10, 10.1, 60):
                for locked in (False, True):
                    times = [i * gap for i in range(seq)]
                    seen.add(S.auto_grade(seq, times, 10, locked))
        self.assertEqual(seen, {"good", "hard", "again"})

    def test_via_and_work_bonus_validators(self):
        self.assertEqual((S.check_via(None), S.check_via("name"), S.check_via("work")), ("name", "name", "work"))
        for bad in ("", "Work", "both", 1, 0, True, False, ["work"], {"a": 1}):
            with self.assertRaises(S.SoloError) as cm:
                S.check_via(bad)
            self.assertEqual((cm.exception.status, cm.exception.code), (422, "bad_via"))
        self.assertEqual(S.check_work_bonus_sec(None), 2)
        self.assertEqual((S.check_work_bonus_sec(0), S.check_work_bonus_sec(10), S.check_work_bonus_sec(1.5)), (0, 10, 1.5))
        for bad in (-0.1, 10.1, 11, "2", True, False, [2], float("nan"), float("inf")):
            with self.assertRaises(S.SoloError) as cm:
                S.check_work_bonus_sec(bad)
            self.assertEqual((cm.exception.status, cm.exception.code), (422, "bad_work_bonus_sec"))

    def test_auto_grade_work_bonus_formula(self):
        # k = 3：只有一个间隔（2→3），结束行是第 3 行
        t3 = [0, 5, 16]                                                      # 2→3 = 11
        self.assertEqual(S.auto_grade(3, t3, 10, False), "hard")             # 不给 vias：没有作品加时，分界线就是 good_sec
        self.assertEqual(S.auto_grade(3, t3, 10, False, ["name", "name", "name"], 2), "hard")
        self.assertEqual(S.auto_grade(3, t3, 10, False, ["name", "name", "work"], 2), "good")   # 分界线 12
        self.assertEqual(S.auto_grade(3, t3, 10, False, ["work", "work", "name"], 2), "hard")   # 只看结束行
        self.assertEqual(S.auto_grade(3, [0, 5, 17.5], 10, False, [None, None, "work"], 2), "hard")  # 12.5 > 12
        self.assertEqual(S.auto_grade(3, [0, 5, 17], 10, False, [None, None, "work"], 2), "good")    # 恰好 12
        self.assertEqual(S.auto_grade(3, t3, 10, False, ["name", "name", "work"], 0), "hard")        # 加时 0 = 关掉
        # k = 4：间隔 2→3（结束行 3）、3→4（结束行 4），分界线 = 10 + 2 × 其中 work 的个数 / 2
        t4 = [0, 2, 10, 24]                                                  # 8, 14，平均 11
        self.assertEqual(S.auto_grade(4, t4, 10, False, ["name"] * 4, 2), "hard")
        self.assertEqual(S.auto_grade(4, t4, 10, False, ["name", "name", "name", "work"], 2), "good")   # 11 ≤ 11
        self.assertEqual(S.auto_grade(4, t4, 10, False, ["name", "name", "work", "name"], 2), "good")
        self.assertEqual(S.auto_grade(4, [0, 2, 10, 24.5], 10, False, ["name", "name", "name", "work"], 2), "hard")
        self.assertEqual(S.auto_grade(4, [0, 2, 10, 24.5], 10, False, ["name", "name", "work", "work"], 2), "good")
        # 第 1、2 行猜中、Again 锁定：不受影响
        self.assertEqual(S.auto_grade(2, [0, 500], 10, False, ["work", "work"], 2), "good")
        self.assertEqual(S.auto_grade(4, [0, 1, 2, 3], 10, True, ["work"] * 4, 10), "again")
        # 结束行是超时行（vias 里 None）：没有加时
        self.assertEqual(S.auto_grade(4, t4, 10, False, ["name", "name", None, "name"], 2), "hard")

    def test_timing_block_with_work_bonus(self):
        tb = S.timing_block([0, 2, 10, 24], 10, vias=["name", "name", None, "work"], work_bonus_sec=2)
        self.assertEqual(tb["intervals"], [iv(2, 3, 8, None, 0), iv(3, 4, 14, "work", 2)])
        self.assertEqual((tb["avg_sec"], tb["good_sec"], tb["work_bonus_sec"], tb["threshold_sec"]), (11, 10, 2, 11))
        tb = S.timing_block([0, 2], 10, vias=["name", "work"], work_bonus_sec=2)       # 没有间隔：分界线就是 good_sec
        self.assertEqual((tb["intervals"], tb["avg_sec"], tb["threshold_sec"]), ([], None, 10))

    def test_is_forgiven_six_conditions(self):
        yes = lambda: True
        no = lambda: False
        self.assertTrue(S.is_forgiven(True, True, 1, 0, False, yes))              # 基准：六条全满足
        self.assertTrue(S.is_forgiven(True, True, 3, 1, False, yes))              # 已宽免 1 次，还能再宽免
        self.assertFalse(S.is_forgiven(False, True, 1, 0, False, yes))            # 1 超时行不宽免
        self.assertFalse(S.is_forgiven(True, False, 1, 0, False, yes))            # 2 不在题库里不宽免
        self.assertFalse(S.is_forgiven(True, True, 0, 0, False, yes))             # 3 第一次猜测不宽免
        self.assertFalse(S.is_forgiven(True, True, 2, 2, False, yes))             # 4 最多 2 次
        self.assertFalse(S.is_forgiven(True, True, 2, 0, True, yes))              # 5 已判 Again 之后不再宽免
        self.assertFalse(S.is_forgiven(True, True, 1, 0, False, no))              # 6 区分得开不宽免

    def test_is_forgiven_checks_cheap_conditions_first(self):
        calls = []

        def probe():
            calls.append(1)
            return True

        S.is_forgiven(True, True, 0, 0, False, probe)       # 第一次猜测：不该去算反馈表
        S.is_forgiven(True, False, 3, 0, False, probe)
        S.is_forgiven(True, True, 3, 2, False, probe)
        self.assertEqual(calls, [])
        self.assertTrue(S.is_forgiven(True, True, 3, 0, False, probe))
        self.assertEqual(calls, [1])

    def test_round_status_and_limit(self):
        r = S.Round(id="r", no=1, answer_id=1, key="char:1", bound=101, work_members=frozenset({1}), subject_tag_num=6,
                    character_tag_num=0, good_sec=10, time_limit_sec=None, start_ts=0, vt=0, why="new", gap_rounds=None,
                    gap_sec=None, prev_grade=None)
        self.assertEqual(r.status(), {"rows": 0, "misses": 0, "forgiven": 0, "counted": 0, "again_locked": False, "limit": 3})
        r.count_miss(False)
        r.count_miss(True)
        self.assertEqual((r.misses, r.forgiven, r.counted, r.again_locked), (2, 1, 1, False))
        self.assertEqual(r.status()["limit"], 4)
        r.count_miss(False)
        r.count_miss(False)
        self.assertEqual((r.counted, r.again_locked), (3, True))          # 4 次 miss − 1 次宽免 = 3 → 锁定
        self.assertEqual(r.status()["limit"], 4)


# ================================================================ 建会话
class TestSession(SoloCase):
    def test_create_session_shape(self):
        d = self.new_session()
        self.assertEqual((d["mode"], d["practice"], d["plan_name"]), ("anime", "work", None))
        self.assertEqual(d["pool_total"], 17)
        self.assertEqual(d["pool_ids"], list(range(1, 18)))
        self.assertEqual(d["default_subject_tag_num"], 6)
        self.assertEqual(d["errors"], [])
        self.assertEqual(len(d["warnings"]), 1)                        # 求值的提示：c7 c9 在动画模式下没有登场作品（格子为空）
        self.assertIn("游戏格子为空", d["warnings"][0])
        self.assertEqual(d["new_every"], 4)
        self.assertTrue(re.fullmatch(r"[0-9a-f]{32}", d["session_id"]))
        pr = d["progress"]
        self.assertEqual(pr["total"], 0)
        self.assertEqual(pr["session_delta"], 0)
        self.assertEqual([p["id"] for p in pr["parts"]], ["stable", "consolidating", "learning", "unseen"])
        self.assertEqual(sum(s["count"] for s in pr["segments"]), 17)
        self.assertEqual(pr["events"], [])

    def test_plan_name_and_practice_echo(self):
        d = self.new_session(practice="char", plan_name="我的方案")
        self.assertEqual((d["practice"], d["plan_name"]), ("char", "我的方案"))

    def test_default_tag_num_follows_spec(self):
        d = self.new_session(spec=base.all_with(n=4))
        self.assertEqual(d["default_subject_tag_num"], 4)

    def test_empty_pool_422(self):
        self.err(self.post("/session", spec=base.spec([])), 422, "empty_pool")

    def test_bad_inputs_422(self):
        self.err(self.post("/session", spec=SPEC_ALL, practice="nope"), 422, "bad_practice")
        self.err(self.post("/session", spec=SPEC_ALL, new_every=21), 422, "bad_new_every")
        self.err(self.post("/session", spec=SPEC_ALL, new_every="4"), 422, "bad_new_every")
        self.err(self.post("/session", spec={"game": {"tag_count": 11}}), 422, "bad_spec")
        self.err(self.post("/session", spec=SPEC_ALL, plan_name=5), 422, "bad_field")

    def test_practice_missing_or_null_means_work_anything_else_must_be_valid(self):
        d = self.ok(self.post("/session", spec=SPEC_ALL))                       # 不传
        self.assertEqual(d["practice"], "work")
        d = self.ok(self.post("/session", spec=SPEC_ALL, practice=None))        # null
        self.assertEqual(d["practice"], "work")
        self.assertEqual(self.ok(self.post("/session", spec=SPEC_ALL, practice="char"))["practice"], "char")
        # 传了就得是 work / char：空串、0、false、数组、大小写不对……全部 422，不悄悄当成 work
        for bad in ("", 0, False, [], {}, 1, "Work", "WORK", " work", "nope"):
            self.err(self.post("/session", spec=SPEC_ALL, practice=bad), 422, "bad_practice")

    def test_unexpected_exception_does_not_leak_its_message(self):
        # 意料之外的异常（比如库换过之后答案找不到了：KeyError(<答案 id>)）：前端只看到异常类型，详细信息只进后端日志
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        with mock.patch.object(SOLO, "guess", side_effect=KeyError(424242)), contextlib.redirect_stderr(io.StringIO()):
            d = self.err(self.guess(sid, st["round_id"], 7), 500, "internal")
        self.assertIn("KeyError", d["message"])
        self.assertNotIn("424242", json.dumps(d, ensure_ascii=False))
        with mock.patch.object(SOLO, "start_round", side_effect=RuntimeError("答案是 424242")), \
                contextlib.redirect_stderr(io.StringIO()):
            d = self.err(self.post("/round/start", session_id=sid), 500, "internal")
        self.assertNotIn("424242", json.dumps(d, ensure_ascii=False))

    def test_known_errors_still_have_their_own_translation(self):
        from backend.v2.store import NoDatabase
        with mock.patch.object(session_router, "with_snapshot", side_effect=NoDatabase(["x.sqlite"])):
            d = self.err(self.post("/session", spec=SPEC_ALL), 503, "no_db")
        self.assertIn("x.sqlite", d["message"])
        self.err(self.post("/session", spec={"game": {"tag_count": 11}}), 422, "bad_spec")      # SpecError 仍是 422

    def test_new_every_override_saved_and_kept(self):
        d = self.new_session(new_every=0)
        self.assertEqual(d["new_every"], 0)
        self.assertEqual(self.saved()["scheduler"]["params"]["new_every"], 0)
        d2 = self.new_session()                              # 不传 → 沿用已存的
        self.assertEqual(d2["new_every"], 0)
        d3 = self.new_session(new_every=7)
        self.assertEqual((d3["new_every"], self.saved()["scheduler"]["params"]["new_every"]), (7, 7))

    def test_leech_parking_off_by_default(self):
        self.new_session()
        self.assertEqual(self.saved()["scheduler"]["params"]["leech_fails"], 0)

    def test_session_ids_differ_and_lru_evicts_oldest(self):
        ids = [self.new_session()["session_id"] for _ in range(S.MAX_SESSIONS + 1)]
        self.assertEqual(len(set(ids)), len(ids))
        self.err(self.post("/round/start", session_id=ids[0]), 404, "session_not_found")     # 最旧的被丢了
        for sid in ids[1:]:
            self.assertEqual(self.post("/round/start", session_id=sid).status_code, 200)

    def test_using_a_session_keeps_it_alive(self):
        first = self.new_session()["session_id"]
        for _ in range(S.MAX_SESSIONS - 1):
            self.new_session()
        self.ok(self.post("/round/start", session_id=first))          # 用一下 → 变成最新
        self.new_session()                                            # 再挤进一个：被丢的是第二旧的
        self.assertEqual(self.post("/round/start", session_id=first).status_code, 200)

    def test_lost_session_404_on_every_endpoint(self):
        sid = self.new_session()["session_id"]
        st = self.start(sid, 1)
        SOLO.reset()                                                  # 等于后端重启
        for path, body in (("/round/start", {}),
                           ("/round/guess", {"round_id": st["round_id"], "guess_id": 2}),
                           ("/round/timeout", {"round_id": st["round_id"]}),
                           ("/round/surrender", {"round_id": st["round_id"]}),
                           ("/round/regrade", {"round_id": st["round_id"], "grade": "good"})):
            d = self.err(self.post(path, session_id=sid, **body), 404, "session_not_found")
            self.assertIn("重新开始", d["message"])
        self.err(self.post("/round/start", session_id="nope"), 404, "session_not_found")

    def test_missing_ids_422(self):
        self.err(self.post("/round/start"), 422, "bad_field")
        sid = self.new_session()["session_id"]
        self.err(self.post("/round/guess", session_id=sid, guess_id=1), 422, "bad_field")
        self.err(self.post("/round/guess", session_id=sid, round_id="x"), 422, "bad_field")


# ================================================================ 开局
class TestStartRound(SoloCase):
    def test_start_response_and_no_answer_leak(self):
        sess = self.new_session()
        st = self.start(sess["session_id"], 1)
        self.assertTrue(st["round_id"])
        self.assertEqual((st["round_no"], st["subject_tag_num"], st["character_tag_num"]), (1, 6, 0))
        self.assertEqual((st["good_sec"], st["time_limit_sec"]), (10, None))
        self.assertEqual(st["status"], {"rows": 0, "misses": 0, "forgiven": 0, "counted": 0, "again_locked": False,
                                        "limit": 3})
        self.assertEqual(st["progress"]["events"], [])
        for k in ("answer_id", "answer_name", "card", "correct"):
            self.assertNotIn(k, set(deep_keys(st)))
        self.assertNotIn("角色一", json.dumps(st, ensure_ascii=False))

    def test_start_params_validated_and_echoed(self):
        sid = self.new_session()["session_id"]
        st = self.start(sid, 1, subject_tag_num=3, character_tag_num=2, good_sec=15, time_limit_sec=20)
        self.assertEqual((st["subject_tag_num"], st["character_tag_num"], st["good_sec"], st["time_limit_sec"]),
                         (3, 2, 15, 20))
        self.err(self.post("/round/start", session_id=sid, subject_tag_num=11), 422, "bad_tag_num")
        self.err(self.post("/round/start", session_id=sid, character_tag_num=-1), 422, "bad_tag_num")
        self.err(self.post("/round/start", session_id=sid, good_sec=0), 422, "bad_good_sec")
        self.err(self.post("/round/start", session_id=sid, time_limit_sec=61), 422, "bad_time_limit")

    def test_tag_numbers_reach_feedback(self):
        sid = self.new_session()["session_id"]
        st = self.start(sid, 1, subject_tag_num=2, character_tag_num=1)
        row = self.ok(self.guess(sid, st["round_id"], 7))["row"]
        self.assertEqual((row["feedback"]["subject_tag_num"], row["feedback"]["character_tag_num"]), (2, 1))

    def test_round_no_counts_real_games(self):
        sess = self.new_session()
        sid = sess["session_id"]
        a = self.start(sid, 1)
        self.surrender(sid, a["round_id"])
        b = self.start(sid, 7)
        self.assertEqual((a["round_no"], b["round_no"]), (1, 2))

    def test_unfinished_round_is_voided_with_log_and_no_rating(self):
        sess = self.new_session()
        sid = sess["session_id"]
        a = self.start(sid, 1)
        self.ok(self.guess(sid, a["round_id"], 7))
        b = self.start(sid, 6)                                         # 上一局没打完就开下一局
        voids = [x for x in self.log_lines() if x["kind"] == "void"]
        self.assertEqual(len(voids), 1)
        self.assertEqual((voids[0]["char_id"], voids[0]["round_id"], voids[0]["rows"]), (1, a["round_id"], 1))
        self.assertIn("ts", voids[0])
        self.err(self.guess(sid, a["round_id"], 8), 409, "round_not_active")      # 旧局不能再猜
        self.assertEqual(self.guess(sid, b["round_id"], 8).status_code, 200)
        st = self.saved()["scheduler"]
        self.assertEqual(st["games"], 0)                               # 作废的不记一局
        self.assertNotIn("char:1", st["items"])                        # 也不记评级
        self.assertEqual(b["round_no"], 1)

    def test_orphan_current_from_previous_process_is_voided(self):
        sess = self.new_session()
        a = self.start(sess["session_id"], 1)
        self.assertIsNotNone(self.saved()["scheduler"]["current"])
        SOLO.reset()                                                   # 后端重启：current 还在盘上
        sess2 = self.new_session()
        self.assertIsNotNone(self.saved()["scheduler"]["current"])     # 题库里还有 c1，所以保留
        self.start(sess2["session_id"], 6)
        voids = [x for x in self.log_lines() if x["kind"] == "void"]
        self.assertEqual(len(voids), 1)
        self.assertEqual((voids[0]["char_id"], voids[0]["round_id"]), (1, a["round_id"]))
        self.assertIsNone(voids[0]["rows"])                            # 这个进程不知道它猜了几行

    def test_progress_delta_is_per_session(self):
        s1 = self.new_session()
        self.start(s1["session_id"], 1)
        d1 = self.ok(self.post("/round/surrender", session_id=s1["session_id"],
                               round_id=self.saved()["scheduler"]["current"]["round_id"]))["end"]
        self.assertEqual(d1["progress"]["session_delta"], round(d1["progress"]["total"] - 0, 2))
        s2 = self.new_session()                                        # 新会话：起点是当前总进度
        self.assertEqual(s2["progress"]["session_delta"], 0)
        self.assertEqual(s2["progress"]["total"], d1["progress"]["total"])

    def test_two_sessions_share_one_scheduler_per_mode_and_practice(self):
        s1 = self.new_session()
        a = self.start(s1["session_id"], 1)
        self.surrender(s1["session_id"], a["round_id"])
        s2 = self.new_session()                                        # 同 (anime, work)
        b = self.start(s2["session_id"], 7)
        self.assertEqual(b["round_no"], 2)                             # 接着数
        s3 = self.new_session(practice="char")                         # 另一个练法：从头
        c = self.start(s3["session_id"], 1)
        self.assertEqual(c["round_no"], 1)
        self.assertTrue(os.path.exists(self.sched_file("anime", "char")))

    def test_second_session_with_other_pool_invalidates_first_round(self):
        # 会话 A 的题库是 17 人；会话 B 的题库是 9 人（不含 c10）。A 正在猜 c10 时 B 建会话：c10 不在新题库里，A 的这局作废
        s1 = self.new_session()
        a = self.start(s1["session_id"], 10)
        self.new_session(spec=SPEC_RANK2)
        voids = [x for x in self.log_lines() if x["kind"] == "void"]
        self.assertEqual([v["char_id"] for v in voids], [10])
        self.err(self.guess(s1["session_id"], a["round_id"], 7), 409, "round_not_active")
        b = self.start(s1["session_id"], 7)                            # A 再开一局：题库换回 A 自己的
        self.assertEqual(self.guess(s1["session_id"], b["round_id"], 6).status_code, 200)


# ================================================================ 猜测、猜中
class TestGuessing(SoloCase):
    def test_miss_row_shape(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        d = self.ok(self.guess(sid, st["round_id"], 7, dt=4))
        row = d["row"]
        self.assertEqual((row["seq"], row["kind"], row["guess_id"], row["name"]), (1, "guess", 7, "角色七"))
        self.assertEqual((row["hit"], row["exact"], row["forgiven"]), (False, False, False))
        self.assertEqual(row["t_offset"], 4)
        self.assertIsNone(d["end"])
        self.assertEqual(d["status"], {"rows": 1, "misses": 1, "forgiven": 0, "counted": 1, "again_locked": False,
                                       "limit": 3})
        fb = row["feedback"]
        for k in ("gender", "popularity", "rating", "shared_appearances", "appearancesCount", "metaTags",
                  "latestAppearance", "earliestAppearance", "display"):
            self.assertIn(k, fb)

    def test_answer_never_in_any_response_before_end(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        seen = [sess, st]
        for gid in (7, 6):
            seen.append(self.ok(self.guess(sid, st["round_id"], gid, dt=2)))
        seen.append(self.ok(self.timeout(sid, st["round_id"], dt=10)))
        for d in seen:
            self.assertNotIn("answer_id", set(deep_keys(d)))
            self.assertNotIn("correct", set(deep_keys(d)))
            self.assertNotIn("answer_name", set(deep_keys(d)))
            self.assertNotIn("card", set(deep_keys(d)))
            self.assertNotIn("角色一", json.dumps(d, ensure_ascii=False))
        # 猜中之后才出现
        end = self.ok(self.guess(sid, st["round_id"], 1, dt=1))["end"]
        self.assertEqual((end["answer_id"], end["answer_name"]), (1, "角色一"))

    def test_hit_by_exact_answer(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        d = self.ok(self.guess(sid, st["round_id"], 1, dt=3))
        self.assertEqual((d["row"]["hit"], d["row"]["exact"], d["row"]["forgiven"]), (True, True, False))
        self.assertEqual(d["end"]["ended_by"], "exact")
        self.assertEqual((d["end"]["hit_seq"], d["end"]["rows"]), (1, 1))

    def test_hit_by_same_work_when_practice_is_work(self):
        # 答案 c1，答案的作品 101；c2 也在 101 里登场 → 猜中，但不是答案本人
        sess = self.new_session(practice="work")
        sid = sess["session_id"]
        st = self.start(sid, 1)
        d = self.ok(self.guess(sid, st["round_id"], 2))
        self.assertEqual((d["row"]["hit"], d["row"]["exact"]), (True, False))
        self.assertEqual(d["end"]["ended_by"], "work")
        self.assertEqual(d["end"]["answer_id"], 1)                     # 结算才告诉你答案是谁

    def test_work_hit_does_not_count_when_practice_is_char(self):
        sess = self.new_session(practice="char")
        sid = sess["session_id"]
        st = self.start(sid, 1)
        d = self.ok(self.guess(sid, st["round_id"], 2))
        self.assertEqual((d["row"]["hit"], d["row"]["exact"]), (False, False))
        self.assertIsNone(d["end"])
        self.assertEqual(d["status"]["misses"], 1)
        d = self.ok(self.guess(sid, st["round_id"], 1))                # 必须猜中本人
        self.assertEqual((d["row"]["hit"], d["row"]["exact"], d["end"]["ended_by"]), (True, True, "exact"))

    def test_linked_work_does_not_count(self):
        # 答案 c5 的作品是 102（c4 c5）；c8 只是和 c5 同在 103（联动 / 续作）→ 不算猜中
        sess = self.new_session(practice="work")
        sid = sess["session_id"]
        st = self.start(sid, 5)
        d = self.ok(self.guess(sid, st["round_id"], 8))
        self.assertEqual(d["row"]["hit"], False)
        d = self.ok(self.guess(sid, st["round_id"], 4))                # c4 在 102 → 猜中
        self.assertEqual((d["row"]["hit"], d["end"]["ended_by"]), (True, "work"))

    def test_repeat_guess_is_an_ordinary_miss_row(self):
        # 不拦重复猜。同一个错角色连猜 3 次 = 3 行、3 个 miss、计入 3 次 → 本局记 Again
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        ds = [self.ok(self.guess(sid, st["round_id"], 7, dt=1)) for _ in range(3)]
        self.assertEqual([d["row"]["seq"] for d in ds], [1, 2, 3])
        self.assertEqual([d["row"]["guess_id"] for d in ds], [7, 7, 7])
        self.assertEqual([d["row"]["forgiven"] for d in ds], [False, False, False])
        self.assertEqual([d["status"]["misses"] for d in ds], [1, 2, 3])
        self.assertEqual([d["status"]["counted"] for d in ds], [1, 2, 3])
        self.assertEqual([d["status"]["again_locked"] for d in ds], [False, False, True])
        self.assertEqual(ds[2]["status"], {"rows": 3, "misses": 3, "forgiven": 0, "counted": 3, "again_locked": True,
                                           "limit": 3})
        end = self.ok(self.guess(sid, st["round_id"], 1, dt=1))["end"]      # 之后猜中也还是 Again
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["rows"], end["misses"]), ("again", 4, 4, 3))

    def test_repeat_guess_counts_as_a_row_for_timing(self):
        # 重复猜也是一行，也是计时点：第 1 行 7，第 2 行 7，第 3 行猜中，2→3 间隔 4 秒
        _, _, res, end = self.play(1, [(2, 7), (3, 7), (4, 2)])
        self.assertEqual([r["row"]["seq"] for r in res], [1, 2, 3])
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["misses"]), ("good", 3, 2))
        self.assertEqual(end["timing"]["intervals"], [iv(2, 3, 4)])

    def test_repeat_guess_is_not_forgiven(self):
        # 重复猜的人在自己那一行上的反馈全是「对」，和答案的不全一样 → 过不了「区分不了」，所以不宽免
        self.assertFalse(self.indistinguishable(1, [7], 7))
        self.assertFalse(self.indistinguishable(1, [9], 9))
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        flags = [self.ok(self.guess(sid, st["round_id"], g, dt=1))["row"]["forgiven"] for g in (7, 7)]
        self.assertEqual(flags, [False, False])                        # 第 1 次是第一次猜测不宽免；重复那次也不宽免
        # 隔着别的猜测再重复，也一样：先猜 c9，再猜 c10（区分不了，宽免），再回头猜 c9 / c10
        self.assertTrue(self.indistinguishable(1, [9], 10))
        self.assertFalse(self.indistinguishable(1, [9, 10], 9))
        self.assertFalse(self.indistinguishable(1, [9, 10, 9], 10))
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        flags = [self.ok(self.guess(sid, st["round_id"], g, dt=1))["row"]["forgiven"] for g in (9, 10, 9)]
        self.assertEqual(flags, [False, True, False])
        d = self.ok(self.guess(sid, st["round_id"], 10, dt=1))
        self.assertEqual(d["row"]["forgiven"], False)
        self.assertEqual((d["status"]["misses"], d["status"]["forgiven"], d["status"]["counted"]), (4, 1, 3))
        self.assertEqual(d["status"]["again_locked"], True)

    def test_repeat_of_the_hit_cannot_happen_because_the_round_ends(self):
        # 猜中就结束，没有“重复猜中”这回事：结束后再猜是 409 round_not_active
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 1))
        self.err(self.guess(sid, st["round_id"], 1), 409, "round_not_active")

    def test_unknown_character_404(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        d = self.err(self.guess(sid, st["round_id"], 999999), 404, "not_found")
        self.assertNotIn("999999", d["message"])                       # 信息里不带 id
        self.assertEqual(self.ok(self.guess(sid, st["round_id"], 7))["row"]["seq"], 1)

    def test_row_and_end_carry_original_and_cn_names(self):
        # 名字两行：name_original = character.name（日文原名），name_cn = character.name_cn（可能 null）；name 仍是显示名
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 7)
        r7 = self.ok(self.guess(sid, st["round_id"], 8, dt=1))["row"]         # c8：有原名，没有中文名
        self.assertEqual((r7["name"], r7["name_original"], r7["name_cn"]), ("角色八", "エイト", None))
        r1 = self.ok(self.guess(sid, st["round_id"], 1, dt=1))["row"]         # c1：原名 = 中文名 = 显示名（合成库的默认）
        self.assertEqual((r1["name"], r1["name_original"], r1["name_cn"]), ("角色一", "角色一", "角色一"))
        end = self.ok(self.guess(sid, st["round_id"], 7, dt=1))
        self.assertEqual((end["row"]["name"], end["row"]["name_original"], end["row"]["name_cn"]),
                         ("角色七", "セブン", "七号角色"))
        e = end["end"]
        self.assertEqual((e["answer_name"], e["name_original"], e["name_cn"]), ("角色七", "セブン", "七号角色"))

    def test_end_block_names_when_answer_has_no_cn_name(self):
        _, _, _, end = self.play(8, [(1, 8)])
        self.assertEqual((end["answer_name"], end["name_original"], end["name_cn"]), ("角色八", "エイト", None))
        # 投降的结算块也有
        sess = self.new_session()
        st = self.start(sess["session_id"], 7)
        e = self.surrender(sess["session_id"], st["round_id"])["end"]
        self.assertEqual((e["answer_name"], e["name_original"], e["name_cn"]), ("角色七", "セブン", "七号角色"))

    def test_timeout_row_has_no_names(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        row = self.ok(self.timeout(sid, st["round_id"], dt=10))["row"]
        self.assertNotIn("name", row)
        self.assertNotIn("name_original", row)
        self.assertNotIn("name_cn", row)

    def test_guess_character_outside_pool_is_allowed(self):
        # 搜索是全库：猜的角色可以不在题库里（只是不会被宽免）
        sess = self.new_session(spec=SPEC_RANK2)
        sid = sess["session_id"]
        st = self.start(sid, 1)
        d = self.ok(self.guess(sid, st["round_id"], 10))               # c10 不在这个 9 人题库里
        self.assertEqual(d["row"]["hit"], False)

    def test_round_not_active_cases(self):
        sess = self.new_session()
        sid = sess["session_id"]
        self.err(self.post("/round/guess", session_id=sid, round_id="nothing", guess_id=7), 409, "round_not_active")
        st = self.start(sid, 1)
        self.err(self.post("/round/guess", session_id=sid, round_id="other", guess_id=7), 409, "round_not_active")
        self.ok(self.guess(sid, st["round_id"], 1))                    # 猜中，结束
        self.err(self.guess(sid, st["round_id"], 7), 409, "round_not_active")
        self.err(self.post("/round/surrender", session_id=sid, round_id=st["round_id"]), 409, "round_not_active")
        self.err(self.post("/round/timeout", session_id=sid, round_id=st["round_id"]), 409, "round_not_active")


# ================================================================ 宽免
class TestForgiveness(SoloCase):
    def test_second_guess_indistinguishable_is_forgiven(self):
        # 答案 c1：先猜 c9，再猜 c10。前提：假设 c10 是答案，c9 的那一行反馈表和真实的一模一样
        self.assertTrue(self.indistinguishable(1, [9], 10))
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        r1 = self.ok(self.guess(sid, st["round_id"], 9, dt=2))
        self.assertEqual(r1["row"]["forgiven"], False)                 # 第一次猜测不宽免
        r2 = self.ok(self.guess(sid, st["round_id"], 10, dt=2))
        self.assertEqual((r2["row"]["hit"], r2["row"]["forgiven"]), (False, True))
        self.assertEqual(r2["status"], {"rows": 2, "misses": 2, "forgiven": 1, "counted": 1, "again_locked": False,
                                        "limit": 4})

    def test_first_guess_never_forgiven_even_if_indistinguishable(self):
        # 第一次猜之前表上什么都没有，任何人都「区分不了」——不加这条每局白送 2 次
        sid = self.new_session()["session_id"]
        for first in (7, 9, 10):
            st = self.start(sid, 1)                                    # 上一局没打完会被作废，不影响这里
            d = self.ok(self.guess(sid, st["round_id"], first))
            self.assertEqual(d["row"]["forgiven"], False, first)
            self.assertEqual(d["status"]["counted"], 1)

    def test_distinguishable_miss_is_counted(self):
        self.assertFalse(self.indistinguishable(1, [7], 6))
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 7))
        d = self.ok(self.guess(sid, st["round_id"], 6))
        self.assertEqual((d["row"]["forgiven"], d["status"]["forgiven"], d["status"]["counted"]), (False, 0, 2))

    def test_guess_not_in_pool_not_forgiven(self):
        # 同一个序列 [c7, c10]（c10 对 c7 那一行区分不了）：c10 在题库里 → 宽免；不在题库里 → 不宽免
        self.assertTrue(self.indistinguishable(1, [7], 10))
        in_pool = self.new_session(spec=SPEC_ALL)
        st = self.start(in_pool["session_id"], 1)
        self.ok(self.guess(in_pool["session_id"], st["round_id"], 7))
        self.assertTrue(self.ok(self.guess(in_pool["session_id"], st["round_id"], 10))["row"]["forgiven"])
        out_pool = self.new_session(spec=SPEC_RANK2)
        self.assertNotIn(10, out_pool["pool_ids"])
        st = self.start(out_pool["session_id"], 1)
        self.ok(self.guess(out_pool["session_id"], st["round_id"], 7))
        d = self.ok(self.guess(out_pool["session_id"], st["round_id"], 10))
        self.assertEqual((d["row"]["forgiven"], d["status"]["forgiven"]), (False, 0))

    def test_two_forgiven_real_data_then_counted(self):
        # 答案 c10（答案的作品只有它自己）：c9（第 1 次，不宽免）→ c12（区分不了，宽免）→ c2（区分不了，宽免）
        self.assertTrue(self.indistinguishable(10, [9], 12))
        self.assertTrue(self.indistinguishable(10, [9, 12], 2))
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 10)
        flags = [self.ok(self.guess(sid, st["round_id"], g, dt=1))["row"]["forgiven"] for g in (9, 12, 2)]
        self.assertEqual(flags, [False, True, True])
        d = self.ok(self.guess(sid, st["round_id"], 3, dt=1))          # 已宽免 2 次，不再宽免
        self.assertEqual(d["row"]["forgiven"], False)
        self.assertEqual(d["status"], {"rows": 4, "misses": 4, "forgiven": 2, "counted": 2, "again_locked": False,
                                       "limit": 5})

    def test_forgiven_max_two_with_stubbed_feedback(self):
        # 把反馈表换成「每个人都区分不了」：除了第 1 次猜测，其余都满足前 5 条以外的条件，只有「最多 2 次」在拦
        def stub(snap, mode, g, a, n, ctn, mp=None):
            return {"guess_id": g, "answer_id": a, "correct": g == a, "same": 1}

        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        with mock.patch.object(S, "solo_feedback", stub):
            ds = [self.ok(self.guess(sid, st["round_id"], g, dt=1)) for g in (4, 5, 6, 7, 8)]
        self.assertEqual([d["row"]["forgiven"] for d in ds], [False, True, True, False, False])
        self.assertEqual([d["status"]["counted"] for d in ds], [1, 1, 1, 2, 3])
        self.assertEqual([d["status"]["limit"] for d in ds], [3, 4, 5, 5, 5])
        self.assertEqual([d["status"]["again_locked"] for d in ds], [False, False, False, False, True])

    def test_no_forgiveness_after_again_is_locked(self):
        # 先用 3 次真正区分得开的 miss 锁定 Again（宽免 0 次，离上限 2 次还远）；
        # 然后把反馈表换成「每个人都区分不了」：第 4 次猜错也不宽免，因为本局已判 Again
        def stub(snap, mode, g, a, n, ctn, mp=None):
            return {"guess_id": g, "answer_id": a, "correct": g == a, "same": 1}

        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        for g in (7, 6, 8):
            d = self.ok(self.guess(sid, st["round_id"], g, dt=1))
        self.assertEqual((d["status"]["again_locked"], d["status"]["forgiven"]), (True, 0))
        with mock.patch.object(S, "solo_feedback", stub):
            d = self.ok(self.guess(sid, st["round_id"], 4, dt=1))
        self.assertEqual(d["row"]["forgiven"], False)
        self.assertEqual((d["status"]["misses"], d["status"]["forgiven"], d["status"]["counted"]), (4, 0, 4))

    def test_timeout_row_is_not_forgiven_and_does_not_make_first_guess_forgivable(self):
        def stub(snap, mode, g, a, n, ctn, mp=None):
            return {"guess_id": g, "answer_id": a, "correct": g == a, "same": 1}

        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        with mock.patch.object(S, "solo_feedback", stub):
            t = self.ok(self.timeout(sid, st["round_id"], dt=10))
            self.assertEqual((t["row"]["kind"], t["row"]["forgiven"]), ("timeout", False))
            first = self.ok(self.guess(sid, st["round_id"], 4, dt=1))   # 超时行不算「之前的猜测」：这仍是第一次猜测
            self.assertEqual(first["row"]["forgiven"], False)
            second = self.ok(self.guess(sid, st["round_id"], 5, dt=1))
            self.assertEqual(second["row"]["forgiven"], True)
        self.assertEqual(second["status"], {"rows": 3, "misses": 3, "forgiven": 1, "counted": 2, "again_locked": False,
                                            "limit": 4})


# ================================================================ 评级
class TestRating(SoloCase):
    def test_good_when_hit_on_first_guess(self):
        _, _, res, end = self.play(1, [(60, 1)])                        # 再慢也是 good：还没开始计时
        self.assertEqual((end["grade_auto"], end["grade"], end["hit_seq"], end["again_locked"]), ("good", "good", 1, False))
        self.assertEqual(end["timing"]["intervals"], [])
        self.assertIsNone(end["timing"]["avg_sec"])

    def test_good_when_hit_on_second_guess(self):
        _, _, res, end = self.play(1, [(2, 7), (300, 2)])               # 第 2 行猜中（c2 同作品），300 秒也是 good
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["ended_by"]), ("good", 2, "work"))

    def test_third_guess_interval_equal_good_sec_is_good(self):
        # 第 1 行 +2，第 2 行 +5，第 3 行 +15：2→3 间隔恰好 10.0 → good（≤）
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (10, 2)])
        self.assertEqual((end["grade_auto"], end["hit_seq"]), ("good", 3))
        self.assertEqual(end["timing"]["intervals"], [iv(2, 3, 10.0)])
        self.assertEqual((end["timing"]["avg_sec"], end["timing"]["good_sec"]), (10.0, 10))

    def test_third_guess_interval_over_good_sec_is_hard(self):
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (10.5, 2)])
        self.assertEqual((end["grade_auto"], end["hit_seq"]), ("hard", 3))
        self.assertEqual(end["timing"]["avg_sec"], 10.5)

    def test_good_sec_is_adjustable_per_round(self):
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (15, 2)], good_sec=20)
        self.assertEqual((end["grade_auto"], end["timing"]["good_sec"]), ("good", 20))
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (15, 2)], good_sec=12)
        self.assertEqual(end["grade_auto"], "hard")

    def test_timing_starts_at_row_two_not_at_round_start(self):
        # 第 1 行很晚（开局后 100 秒），但 2→3 只隔 4 秒 → good
        _, _, _, end = self.play(1, [(100, 7), (5, 6), (4, 2)])
        self.assertEqual(end["grade_auto"], "good")
        self.assertEqual(end["timing"]["intervals"], [iv(2, 3, 4)])

    def test_fourth_guess_with_one_forgiven_uses_average(self):
        # c9 / c10（宽免）/ c11 / 猜中 c2：计入 2 次，没锁 Again。2→3 = 6，3→4 = 12，平均 9 ≤ 10 → good（最后一个间隔 12 > 10）
        self.assertTrue(self.indistinguishable(1, [9], 10))
        self.assertFalse(self.indistinguishable(1, [9, 10], 11))
        _, _, res, end = self.play(1, [(2, 9), (3, 10), (6, 11), (12, 2)])
        self.assertEqual([r["row"]["forgiven"] for r in res[:3]], [False, True, False])
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["misses"], end["forgiven"], end["again_locked"]),
                         ("good", 4, 3, 1, False))
        self.assertEqual([i["sec"] for i in end["timing"]["intervals"]], [6, 12])
        self.assertEqual(end["timing"]["avg_sec"], 9)

    def test_fourth_guess_with_one_forgiven_slow_is_hard(self):
        _, _, _, end = self.play(1, [(2, 9), (3, 10), (6, 11), (22, 2)])
        self.assertEqual((end["grade_auto"], end["timing"]["avg_sec"]), ("hard", 14))

    def test_fifth_guess_with_two_forgiven_uses_average(self):
        # 答案 c10：c9 / c12（宽免）/ c2（宽免）/ c3 / 猜中 c10。间隔 2→3 = 6，3→4 = 8，4→5 = 12，平均 ≈ 8.67 → good
        _, _, res, end = self.play(10, [(2, 9), (3, 12), (6, 2), (8, 3), (12, 10)])
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["misses"], end["forgiven"], end["ended_by"]),
                         ("good", 5, 4, 2, "exact"))
        self.assertEqual([i["sec"] for i in end["timing"]["intervals"]], [6, 8, 12])
        self.assertAlmostEqual(end["timing"]["avg_sec"], 26 / 3, places=3)

    def test_fifth_guess_with_two_forgiven_slow_is_hard(self):
        _, _, _, end = self.play(10, [(2, 9), (3, 12), (6, 2), (8, 3), (32, 10)])
        self.assertEqual(end["grade_auto"], "hard")

    def test_three_counted_misses_lock_again_and_hit_after_is_still_again(self):
        self.assertFalse(self.indistinguishable(1, [7], 6))
        self.assertFalse(self.indistinguishable(1, [7, 6], 8))
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        ds = [self.ok(self.guess(sid, st["round_id"], g, dt=1)) for g in (7, 6, 8)]
        self.assertEqual([d["status"]["again_locked"] for d in ds], [False, False, True])
        self.assertEqual(ds[2]["status"], {"rows": 3, "misses": 3, "forgiven": 0, "counted": 3, "again_locked": True,
                                           "limit": 3})
        self.assertIsNone(ds[2]["end"])                                # Again 之后这一局继续
        end = self.ok(self.guess(sid, st["round_id"], 2, dt=1))["end"]  # 很快猜中，也还是 again
        self.assertEqual((end["grade_auto"], end["grade"], end["again_locked"], end["hit_seq"]), ("again", "again", True, 4))
        self.assertEqual(end["ended_by"], "work")

    def test_one_forgiven_allows_four_guesses_before_again(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        ds = [self.ok(self.guess(sid, st["round_id"], g, dt=1)) for g in (9, 10, 11, 6)]   # 第 2 次宽免
        self.assertEqual([d["status"]["counted"] for d in ds], [1, 1, 2, 3])
        self.assertEqual([d["status"]["again_locked"] for d in ds], [False, False, False, True])
        end = self.ok(self.guess(sid, st["round_id"], 1, dt=1))["end"]
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["forgiven"]), ("again", 5, 1))

    def test_again_lock_by_timeouts(self):
        # 超时算 miss、不宽免：1 次猜错 + 2 次超时 = 3 → 锁定
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.ok(self.guess(sid, st["round_id"], 7, dt=3))
        t1 = self.ok(self.timeout(sid, st["round_id"], dt=10))
        t2 = self.ok(self.timeout(sid, st["round_id"], dt=10))
        self.assertEqual(t1["status"]["again_locked"], False)
        self.assertEqual(t2["status"], {"rows": 3, "misses": 3, "forgiven": 0, "counted": 3, "again_locked": True,
                                        "limit": 3})
        end = self.ok(self.guess(sid, st["round_id"], 1, dt=1))["end"]
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["misses"]), ("again", 4, 3))
        self.assertEqual(self.log_lines()[-1]["timeouts"], 2)

    def test_surrender_is_again(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 7))
        end = self.surrender(sid, st["round_id"])["end"]
        self.assertEqual((end["grade_auto"], end["grade"], end["ended_by"], end["hit_seq"]), ("again", "again", "surrender", None))
        self.assertEqual((end["answer_id"], end["rows"], end["misses"]), (1, 1, 1))
        self.assertEqual(self.saved()["scheduler"]["items"]["char:1"]["rev"]["grade"], "again")

    def test_surrender_without_any_guess(self):
        sess = self.new_session()
        st = self.start(sess["session_id"], 7)
        end = self.surrender(sess["session_id"], st["round_id"])["end"]
        self.assertEqual((end["rows"], end["grade"], end["answer_id"]), (0, "again", 7))

    def test_auto_grade_never_easy_through_the_api(self):
        grades = set()
        for steps in ([(1, 1)], [(1, 7), (1, 2)], [(1, 7), (1, 6), (5, 2)], [(1, 7), (1, 6), (50, 2)],
                      [(1, 7), (1, 6), (1, 8), (1, 2)]):
            _, _, _, end = self.play(1, steps)
            grades.add(end["grade_auto"])
        self.assertEqual(grades, {"good", "hard", "again"})


# ================================================================ 作品加时（via / work_bonus_sec）
class TestWorkBonus(SoloCase):
    """答案 c1，c7 / c6 猜错，c2 同作品（猜中）。c9→c10 区分不了（c10 被宽免）。"""

    def test_k3_work_with_11s_interval_is_good_but_name_is_hard(self):
        _, st, res, end = self.play(1, [(2, 7), (3, 6), (11, 2, "work")])
        self.assertEqual((end["grade_auto"], end["hit_seq"]), ("good", 3))
        self.assertEqual(end["timing"]["intervals"], [iv(2, 3, 11, "work", 2)])
        self.assertEqual((end["timing"]["avg_sec"], end["timing"]["good_sec"], end["timing"]["work_bonus_sec"],
                          end["timing"]["threshold_sec"]), (11, 10, 2, 12))
        self.assertEqual(st["work_bonus_sec"], 2)                                  # 开局响应回显（默认 2）
        self.assertEqual(res[2]["row"]["via"], "work")
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (11, 2, "name")])
        self.assertEqual(end["grade_auto"], "hard")
        self.assertEqual(end["timing"]["intervals"], [iv(2, 3, 11, "name", 0)])
        self.assertEqual((end["timing"]["work_bonus_sec"], end["timing"]["threshold_sec"]), (2, 10))
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (11, 2)])                     # 不传 via = name
        self.assertEqual(end["grade_auto"], "hard")

    def test_k3_only_the_ending_row_counts(self):
        # 第 2 行是搜作品选的、第 3 行是按名字搜的：2→3 的结束行是第 3 行 → 没有加时
        _, _, _, end = self.play(1, [(2, 7), (3, 6, "work"), (11, 2, "name")])
        self.assertEqual(end["grade_auto"], "hard")
        # 第 3 行是 work，但间隔 12.5 > 12 → 还是 hard；恰好 12 → good
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (12.5, 2, "work")])
        self.assertEqual(end["grade_auto"], "hard")
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (12, 2, "work")])
        self.assertEqual(end["grade_auto"], "good")

    def test_k4_average_formula_with_one_work_and_one_name_interval(self):
        # c9 / c10（宽免）/ c11 / 猜中 c2。间隔 2→3 = 8（结束行 c11），3→4 = 14（结束行 c2）：平均 11
        # 一个 work：分界线 = 10 + 2 × 1/2 = 11 → 11 ≤ 11 → good；不是「只要有 work 就整体 +2」（那样 12.5 也会 good）
        for vias, grade, thr in ((("name", "work"), "good", 11), (("work", "name"), "good", 11),
                                 (("name", "name"), "hard", 10), (("work", "work"), "good", 12)):
            _, _, res, end = self.play(1, [(2, 9), (3, 10), (8, 11, vias[0]), (14, 2, vias[1])])
            self.assertEqual([r["row"]["forgiven"] for r in res[:3]], [False, True, False])
            self.assertEqual((end["hit_seq"], end["again_locked"]), (4, False))
            self.assertEqual(end["grade_auto"], grade, vias)
            self.assertEqual(end["timing"]["threshold_sec"], thr)
            self.assertEqual([i["via"] for i in end["timing"]["intervals"]], list(vias))
            self.assertEqual([i["bonus_sec"] for i in end["timing"]["intervals"]], [2 if v == "work" else 0 for v in vias])
        # 平均 11.25 > 11（一个 work）→ hard
        _, _, _, end = self.play(1, [(2, 9), (3, 10), (8, 11, "name"), (14.5, 2, "work")])
        self.assertEqual((end["grade_auto"], end["timing"]["avg_sec"], end["timing"]["threshold_sec"]), ("hard", 11.25, 11))

    def test_work_bonus_sec_is_adjustable_and_zero_turns_it_off(self):
        steps = [(2, 7), (3, 6), (11, 2, "work")]
        _, st, _, end = self.play(1, steps, work_bonus_sec=0)
        self.assertEqual((st["work_bonus_sec"], end["grade_auto"], end["timing"]["work_bonus_sec"]), (0, "hard", 0))
        _, st, _, end = self.play(1, steps, work_bonus_sec=1)                       # 分界线 11 → 恰好 good
        self.assertEqual((st["work_bonus_sec"], end["grade_auto"], end["timing"]["threshold_sec"]), (1, "good", 11))
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (19.5, 2, "work")], work_bonus_sec=10)
        self.assertEqual((end["grade_auto"], end["timing"]["intervals"][0]["bonus_sec"]), ("good", 10))

    def test_timeout_row_gets_no_bonus(self):
        # c9 / c10（宽免）/ 超时（第 3 行）/ 猜中 c2（work）。2→3 的结束行是超时行：via None、没加时
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.ok(self.guess(sid, st["round_id"], 9, dt=2))
        self.ok(self.guess(sid, st["round_id"], 10, dt=3, via="work"))
        t = self.ok(self.timeout(sid, st["round_id"], dt=10))
        self.assertEqual((t["row"]["kind"], t["row"]["via"]), ("timeout", None))
        end = self.ok(self.guess(sid, st["round_id"], 2, dt=12.5, via="work"))["end"]
        # 间隔 10（超时行，0）和 12.5（work，+2）：平均 11.25，分界线 11；如果超时行也有加时就是 12 → good
        self.assertEqual(end["timing"]["intervals"], [iv(2, 3, 10, None, 0), iv(3, 4, 12.5, "work", 2)])
        self.assertEqual((end["grade_auto"], end["timing"]["avg_sec"], end["timing"]["threshold_sec"]), ("hard", 11.25, 11))
        self.assertEqual(self.log_lines()[-1]["vias"], ["name", "work", None, "work"])

    def test_timeout_endpoint_ignores_via(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.clock.advance(10)
        t = self.ok(self.post("/round/timeout", session_id=sid, round_id=st["round_id"], via="work"))
        self.assertIsNone(t["row"]["via"])

    def test_bad_via_is_422_and_adds_no_row(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        for bad in ("foo", "", "Name", 1, 0, True, ["work"]):
            d = self.err(self.post("/round/guess", session_id=sid, round_id=st["round_id"], guess_id=7, via=bad),
                         422, "bad_via")
            self.assertIn("via", d["message"])
        d = self.ok(self.guess(sid, st["round_id"], 7))                              # 一行都没被加
        self.assertEqual((d["row"]["seq"], d["status"]["misses"]), (1, 1))

    def test_via_null_or_absent_means_name(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        a = self.ok(self.post("/round/guess", session_id=sid, round_id=st["round_id"], guess_id=7, via=None))
        b = self.ok(self.guess(sid, st["round_id"], 6))
        c = self.ok(self.guess(sid, st["round_id"], 8, via="name"))
        self.assertEqual([x["row"]["via"] for x in (a, b, c)], ["name", "name", "name"])

    def test_bad_work_bonus_sec_is_422(self):
        sid = self.new_session()["session_id"]
        for bad in (-1, 10.5, 11, "2", True, [2]):
            self.err(self.post("/round/start", session_id=sid, work_bonus_sec=bad), 422, "bad_work_bonus_sec")
        st = self.start(sid, 1, work_bonus_sec=None)                                 # null = 默认 2
        self.assertEqual(st["work_bonus_sec"], 2)
        st = self.start(sid, 1, work_bonus_sec=10)
        self.assertEqual(st["work_bonus_sec"], 10)

    def test_fields_absent_means_no_work_bonus(self):
        # 不传 via / work_bonus_sec：全部按 name，没有作品加时，分界线就是 good_sec
        _, st, res, end = self.play(1, [(2, 9), (3, 10), (6, 11), (12, 2)])
        self.assertEqual([r["row"]["via"] for r in res], ["name"] * 4)
        self.assertEqual((end["grade_auto"], end["timing"]["avg_sec"], end["timing"]["threshold_sec"]), ("good", 9, 10))
        _, _, _, end = self.play(1, [(2, 7), (3, 6), (10.5, 2)])
        self.assertEqual((end["grade_auto"], end["timing"]["avg_sec"], end["timing"]["threshold_sec"]), ("hard", 10.5, 10))
        # 第 1、2 行猜中、投降：没有间隔，分界线就是 good_sec
        _, _, _, end = self.play(1, [(2, 7), (3, 2, "work")])
        self.assertEqual((end["grade_auto"], end["timing"]["intervals"], end["timing"]["threshold_sec"]), ("good", [], 10))

    def test_surrender_after_work_rows_is_still_again(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 7, dt=1, via="work"))
        self.ok(self.guess(sid, st["round_id"], 6, dt=1, via="work"))
        self.ok(self.guess(sid, st["round_id"], 8, dt=1, via="work"))               # 3 次 miss：Again 锁定
        end = self.ok(self.guess(sid, st["round_id"], 2, dt=1, via="work"))["end"]
        self.assertEqual((end["grade_auto"], end["again_locked"]), ("again", True))
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 7, dt=1, via="work"))
        end = self.surrender(sid, st["round_id"])["end"]
        self.assertEqual((end["grade_auto"], end["ended_by"]), ("again", "surrender"))
        self.assertEqual(self.log_lines()[-1]["vias"], ["work"])

    def test_log_line_has_vias_bonus_and_threshold(self):
        _, st, _, end = self.play(1, [(2, 7), (3, 6, "work"), (11, 2, "work")], work_bonus_sec=3)
        ln = self.log_lines()[0]
        self.assertEqual(ln["vias"], ["name", "work", "work"])
        self.assertEqual((ln["work_bonus_sec"], ln["threshold_sec"]), (3, 13))
        self.assertEqual((ln["intervals"], ln["avg_sec"], ln["good_sec"], ln["grade_auto"]), ([11.0], 11.0, 10, "good"))
        # 不传 via / work_bonus_sec：日志里 vias 全是 name，加时是默认 2，分界线 = good_sec
        self.play(1, [(2, 7), (3, 2)])
        ln = self.log_lines()[1]
        self.assertEqual((ln["vias"], ln["work_bonus_sec"], ln["threshold_sec"]), (["name", "name"], 2, 10))

    def test_regrade_ignores_via(self):
        sess, st, _, end = self.play(1, [(2, 7), (3, 6), (11, 2, "work")])
        self.assertEqual(end["grade_auto"], "good")
        sid = sess["session_id"]
        d = self.ok(self.regrade(sid, st["round_id"], "hard"))
        self.assertEqual((d["grade"], d["grade_auto"]), ("hard", "good"))
        d = self.ok(self.regrade(sid, st["round_id"], "easy"))
        self.assertEqual((d["grade"], d["grade_auto"]), ("easy", "good"))
        self.assertEqual(self.saved()["scheduler"]["items"]["char:1"]["rev"]["grade"], "easy")

    def test_via_only_changes_timing_not_hit_feedback_or_forgiveness(self):
        _, _, a, end_a = self.play(1, [(1, 9, "work"), (1, 10, "work"), (1, 2, "work")])
        _, _, b, end_b = self.play(1, [(1, 9), (1, 10), (1, 2)])
        for x, y in zip(a, b):
            self.assertEqual((x["row"]["via"], y["row"]["via"]), ("work", "name"))
            strip = lambda r: {k: v for k, v in r.items() if k not in ("via", "t_offset")}
            self.assertEqual(strip(x["row"]), strip(y["row"]))
            self.assertEqual(x["status"], y["status"])
        self.assertEqual((end_a["ended_by"], end_a["forgiven"], end_a["grade_auto"]),
                         (end_b["ended_by"], end_b["forgiven"], end_b["grade_auto"]))


# ================================================================ 超时
class TestTimeout(SoloCase):
    def test_timeout_row_is_a_miss_and_a_timing_point(self):
        # 开局 → +3 猜错 c7（第 1 行）→ +10 超时（第 2 行，倒计时重新开始）→ +7 猜中 c2（第 3 行）
        # 2→3 = 7 ≤ 10 → good；如果超时行不算计时点（从第 1 行算起）就是 17 → hard
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.ok(self.guess(sid, st["round_id"], 7, dt=3))
        t = self.ok(self.timeout(sid, st["round_id"], dt=10))
        self.assertEqual(t["row"], {"seq": 2, "kind": "timeout", "t_offset": 13, "hit": False, "forgiven": False,
                                    "via": None})
        self.assertEqual(t["status"], {"rows": 2, "misses": 2, "forgiven": 0, "counted": 2, "again_locked": False,
                                       "limit": 3})
        self.assertIsNone(t["end"])
        end = self.ok(self.guess(sid, st["round_id"], 2, dt=7))["end"]
        self.assertEqual((end["grade_auto"], end["hit_seq"]), ("good", 3))
        self.assertEqual(end["timing"]["intervals"], [iv(2, 3, 7)])
        self.assertEqual((end["rows"], end["misses"]), (3, 2))

    def test_timeout_as_first_row_counts_as_row_one(self):
        # 开局 +10 超时（第 1 行）→ +2 猜错（第 2 行）→ +5 猜中（第 3 行）：2→3 = 5 → good
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        t = self.ok(self.timeout(sid, st["round_id"], dt=10))
        self.assertEqual(t["row"]["seq"], 1)
        self.ok(self.guess(sid, st["round_id"], 7, dt=2))
        end = self.ok(self.guess(sid, st["round_id"], 2, dt=5))["end"]
        self.assertEqual((end["grade_auto"], end["hit_seq"], end["timing"]["avg_sec"]), ("good", 3, 5))

    def test_timeouts_alone_never_forgiven_and_lock_again(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=5)
        ds = [self.ok(self.timeout(sid, st["round_id"], dt=5)) for _ in range(3)]
        self.assertEqual([d["status"]["forgiven"] for d in ds], [0, 0, 0])
        self.assertEqual([d["status"]["again_locked"] for d in ds], [False, False, True])

    def test_timeout_without_time_limit_409(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        d = self.err(self.timeout(sid, st["round_id"], dt=100), 409, "no_time_limit")
        self.assertIn("时间限制", d["message"])

    def test_timeout_too_early_409_and_boundary(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.err(self.timeout(sid, st["round_id"], dt=5), 409, "too_early")         # 才 5 秒
        self.err(self.timeout(sid, st["round_id"], dt=3.4), 409, "too_early")       # 8.4 < 10 − 1.5
        t = self.ok(self.timeout(sid, st["round_id"], dt=0.1))                      # 8.5 秒：放行（前端计时可能略快）
        self.assertEqual(t["row"]["seq"], 1)

    def test_countdown_restarts_after_each_row(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.ok(self.guess(sid, st["round_id"], 7, dt=9))
        self.err(self.timeout(sid, st["round_id"], dt=5), 409, "too_early")         # 距上一行才 5 秒
        self.ok(self.timeout(sid, st["round_id"], dt=4))                            # 距上一行 9 秒
        self.err(self.timeout(sid, st["round_id"], dt=4), 409, "too_early")         # 距上一个超时行才 4 秒
        self.ok(self.timeout(sid, st["round_id"], dt=5))

    def test_failed_timeout_does_not_add_row(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.err(self.timeout(sid, st["round_id"], dt=1), 409, "too_early")
        d = self.ok(self.guess(sid, st["round_id"], 7, dt=1))
        self.assertEqual((d["row"]["seq"], d["status"]["misses"]), (1, 1))


# ================================================================ 结算块、日志、调度器
class TestEndBlockAndLog(SoloCase):
    def test_end_block_fields(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 7, dt=1))
        end = self.ok(self.guess(sid, st["round_id"], 2, dt=2))["end"]
        for k in ("round_id", "answer_id", "answer_name", "card", "grade_auto", "grade", "ended_by", "again_locked",
                  "hit_seq", "rows", "misses", "forgiven", "timing", "why", "why_label", "gap_rounds", "gap_sec",
                  "prev_grade", "next_gap", "progress"):
            self.assertIn(k, end)
        self.assertEqual(end["round_id"], st["round_id"])
        self.assertEqual((end["card"]["char_id"], end["card"]["character"]["name"]), (1, "角色一"))
        self.assertIn("has_anime", end["card"])
        self.assertIn(end["why"], ("new", "new_floor"))
        self.assertIn(end["why_label"], ("新角色", "新角色保底"))
        self.assertEqual((end["gap_rounds"], end["gap_sec"], end["prev_grade"]), (None, None, None))
        self.assertGreater(end["next_gap"], 0)
        self.assertIn("events", end["progress"])
        self.assertTrue(any(e["type"] == "new_character" for e in end["progress"]["events"]))

    # ---- 导图联动：结算块里的作品 id 和猜错的人
    def test_end_block_maplink_fields_bound_work_first_then_all_apps(self):
        # c12：绑定作品 101（客串），动画模式下的登场作品只有 301 → [101, 301]，绑定作品在前
        sid = self.new_session()["session_id"]
        end = self.surrender(sid, self.start(sid, 12)["round_id"])["end"]
        self.assertEqual((end["bound_work_id"], end["answer_work_ids"]), (101, [101, 301]))
        self.assertEqual(end["card"]["bound_work"]["id"], 101)
        # c5：绑定作品 102（被方案绑到的那部），另外登场在 103
        end = self.surrender(sid, self.start(sid, 5)["round_id"])["end"]
        self.assertEqual((end["bound_work_id"], end["answer_work_ids"]), (102, [102, 103]))
        # 绑定作品和登场作品重复时去重
        end = self.surrender(sid, self.start(sid, 1)["round_id"])["end"]
        self.assertEqual(end["answer_work_ids"], [101])
        # 没有登场作品（只有绑定作品）：c7 在动画模式下没有画像登场，绑定作品是 105
        end = self.surrender(sid, self.start(sid, 7)["round_id"])["end"]
        self.assertEqual((end["bound_work_id"], end["answer_work_ids"]), (105, [105]))

    def test_end_block_maplink_fields_on_hit_and_surrender(self):
        sid = self.new_session()["session_id"]
        st = self.start(sid, 5)
        self.ok(self.guess(sid, st["round_id"], 7, dt=1))
        end = self.ok(self.guess(sid, st["round_id"], 5, dt=2))["end"]
        self.assertEqual(end["ended_by"], "exact")
        self.assertEqual(end["answer_work_ids"], [102, 103])
        self.assertEqual(end["wrong_guesses"], [{"char_id": 7, "name": "角色七", "work_ids": []}])
        # 猜中同作品的另一个角色（c4 和 c5 同在 102）：结束，不算猜错
        st = self.start(sid, 5)
        end = self.ok(self.guess(sid, st["round_id"], 4, dt=1))["end"]
        self.assertEqual((end["ended_by"], end["wrong_guesses"]), ("work", []))
        # 投降：之前猜错的都在
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 6, dt=1))
        end = self.surrender(sid, st["round_id"])["end"]
        self.assertEqual(end["ended_by"], "surrender")
        self.assertEqual([(w["char_id"], w["work_ids"]) for w in end["wrong_guesses"]], [(6, [104])])

    def test_wrong_guesses_dedupe_by_character_and_skip_timeouts(self):
        sid = self.new_session()["session_id"]
        st = self.start(sid, 1, time_limit_sec=10)
        self.ok(self.guess(sid, st["round_id"], 5, dt=1))                      # c5：登场在 102、103
        self.ok(self.timeout(sid, st["round_id"], dt=10))                     # 超时行不算猜测
        self.ok(self.guess(sid, st["round_id"], 4, dt=1))
        self.ok(self.guess(sid, st["round_id"], 5, dt=1))                      # c5 再猜一次：按角色去重
        end = self.ok(self.guess(sid, st["round_id"], 1, dt=1))["end"]
        wrong = end["wrong_guesses"]
        self.assertEqual([w["char_id"] for w in wrong], [5, 4])                # 首次出现的顺序
        self.assertEqual(wrong[0], {"char_id": 5, "name": "角色五", "work_ids": [102, 103]})
        self.assertEqual(wrong[1], {"char_id": 4, "name": "角色四", "work_ids": [102]})
        self.assertEqual(end["rows"], 5)

    def test_wrong_guess_outside_pool_is_included_and_work_ids_capped(self):
        sid = self.new_session(spec=SPEC_RANK2)["session_id"]                  # 题库里没有 c9 c10 c12
        st = self.start(sid, 1)
        self.ok(self.guess(sid, st["round_id"], 10, dt=1))                     # 题库外的角色也能猜
        end = self.surrender(sid, st["round_id"])["end"]
        self.assertEqual([(w["char_id"], w["work_ids"]) for w in end["wrong_guesses"]], [(10, [201])])
        # 登场作品太多时只带前 N 个（正式值 50；这里压到 1，c5 登场在 102、103）
        self.assertEqual(S.WRONG_WORKS_MAX, 50)
        sid = self.new_session()["session_id"]
        st = self.start(sid, 1)
        with mock.patch.object(S, "WRONG_WORKS_MAX", 1):
            self.ok(self.guess(sid, st["round_id"], 5, dt=1))
            end = self.surrender(sid, st["round_id"])["end"]
        self.assertEqual(end["wrong_guesses"][0]["work_ids"], [102])

    def test_pool_with_works_is_the_same_grouping_the_scheduler_uses(self):
        from backend.v2.spec import parse_spec
        ev, pool, bound, works = with_snapshot(lambda snap: S.pool_with_works(snap, parse_spec(SPEC_ALL)))
        self.assertEqual(pool, list(range(1, 18)))
        self.assertEqual((bound[12], works[12]), (101, [101, 301]))
        sess = self.new_session()
        sid = sess["session_id"]
        self.assertEqual(SOLO._sessions[sid].groups["char:12"], ["101", "301"])
        self.assertEqual(SOLO._sessions[sid].bound, bound)
        with self.assertRaises(S.SoloError) as caught:
            with_snapshot(lambda snap: S.pool_with_works(snap, parse_spec(base.spec([]))))
        self.assertEqual(caught.exception.code, "empty_pool")

    def test_second_appearance_reports_gap_and_previous_grade(self):
        sess = self.new_session()
        sid = sess["session_id"]
        a = self.start(sid, 1)
        self.surrender(sid, a["round_id"])
        self.clock.advance(30)
        b = self.start(sid, 1)                                          # 同一个角色再出一次
        self.surrender(sid, b["round_id"])
        lines = [x for x in self.log_lines() if x["kind"] == "round"]
        self.assertEqual(len(lines), 2)
        self.assertEqual((lines[1]["prev_grade"], lines[1]["gap_rounds"]), ("again", 0.0))
        self.assertEqual(lines[1]["gap_sec"], 30.0)

    def test_round_log_line(self):
        sess = self.new_session(plan_name="方案甲")
        sid = sess["session_id"]
        st = self.start(sid, 1, time_limit_sec=10, good_sec=8, subject_tag_num=4, character_tag_num=1)
        self.ok(self.guess(sid, st["round_id"], 7, dt=2))
        self.ok(self.timeout(sid, st["round_id"], dt=10))
        end = self.ok(self.guess(sid, st["round_id"], 2, dt=6))["end"]
        lines = self.log_lines()
        self.assertEqual(len(lines), 1)
        ln = lines[0]
        self.assertEqual((ln["kind"], ln["round_id"], ln["plan"], ln["mode"], ln["practice"]),
                         ("round", st["round_id"], "方案甲", "anime", "work"))
        self.assertEqual((ln["char_id"], ln["name"], ln["why"]), (1, "角色一", end["why"]))
        self.assertEqual((ln["grade_auto"], ln["grade"], ln["ended_by"]), ("good", "good", "work"))
        self.assertEqual((ln["rows"], ln["misses"], ln["forgiven"], ln["timeouts"], ln["hit_seq"]), (3, 2, 0, 1, 3))
        self.assertEqual((ln["intervals"], ln["avg_sec"], ln["good_sec"]), ([6.0], 6.0, 8))
        self.assertEqual((ln["subject_tag_num"], ln["character_tag_num"], ln["time_limit_sec"]), (4, 1, 10))
        self.assertEqual(ln["duration_sec"], 18.0)
        self.assertEqual(ln["next_gap"], end["next_gap"])
        for k in ("ts", "vt", "gap_rounds", "gap_sec", "prev_grade", "again_locked"):
            self.assertIn(k, ln)

    def test_surrender_log_line(self):
        sess = self.new_session()
        st = self.start(sess["session_id"], 1)
        self.surrender(sess["session_id"], st["round_id"])
        ln = self.log_lines()[0]
        self.assertEqual((ln["kind"], ln["ended_by"], ln["grade"], ln["hit_seq"]), ("round", "surrender", "again", None))

    def test_one_log_line_per_finished_round(self):
        sess = self.new_session()
        sid = sess["session_id"]
        for ans in (1, 7, 6):
            st = self.start(sid, ans)
            self.surrender(sid, st["round_id"])
        self.assertEqual([x["char_id"] for x in self.log_lines()], [1, 7, 6])
        self.assertEqual(self.log_lines("anime", "char"), [])           # 另一个练法的日志是另一个文件

    def test_scheduler_state_updated_on_finish(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        end = self.ok(self.guess(sid, st["round_id"], 1))["end"]
        state = self.saved()["scheduler"]
        self.assertEqual(state["games"], 1)
        it = state["items"]["char:1"]
        self.assertEqual((it["seen"], it["rev"]["grade"]), (1, "good"))
        self.assertAlmostEqual(it["I"], end["next_gap"], places=2)
        self.assertEqual(state["current"], None)
        self.assertEqual(end["progress"]["total"], self.ok(self.post("/session", spec=SPEC_ALL))["progress"]["total"])

    def test_hard_pull_back_and_no_parking_with_repeated_again(self):
        # 同一个角色连续 Again 很多次：默认不停放（难记的角色照常出现），间隔始终是 relearn_gap 左右
        sess = self.new_session()
        sid = sess["session_id"]
        for _ in range(6):
            st = self.start(sid, 1)
            self.surrender(sid, st["round_id"])
        it = self.saved()["scheduler"]["items"]["char:1"]
        self.assertEqual((it["parked"], it["lapses"], it["seen"]), (0, 6, 6))
        self.assertLess(it["I"], 4)


# ================================================================ 改评级
class TestRegrade(SoloCase):
    def end_round(self, sid, answer, steps=None):
        st = self.start(sid, answer)
        if steps is None:
            return st, self.surrender(sid, st["round_id"])["end"]
        for dt, g in steps:
            d = self.ok(self.guess(sid, st["round_id"], g, dt))
        return st, d["end"]

    def expected_item(self, key, grade):
        params = Params.from_dict(self.saved()["scheduler"]["params"])
        return apply_grade(blank_item(), grade, None, params, key)

    def test_regrade_equals_direct_grade(self):
        # 第一次出现的角色，评 good 后改成 x，调度器状态 = 一开始就评 x
        for target in ("easy", "hard", "again", "good"):
            with self.subTest(target=target):
                SOLO.reset()
                shutil.rmtree(os.path.join(self.tmp, "solo_v2"), ignore_errors=True)
                sess = self.new_session()
                sid = sess["session_id"]
                st, end = self.end_round(sid, 1, [(1, 1)])               # 自动评 good
                self.assertEqual(end["grade_auto"], "good")
                r = self.ok(self.regrade(sid, st["round_id"], target))
                self.assertEqual((r["round_id"], r["grade"], r["grade_auto"]), (st["round_id"], target, "good"))
                it = self.saved()["scheduler"]["items"]["char:1"]
                exp = self.expected_item("char:1", target)
                for f in ("seen", "I", "fails", "lapses", "proven", "F", "parked"):
                    self.assertEqual(it[f], exp[f], f)
                self.assertEqual(it["rev"]["grade"], target)
                self.assertAlmostEqual(r["next_gap"], it["I"], places=2)

    def test_regrade_surrender_to_good_equals_direct(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st, end = self.end_round(sid, 1)                                # 投降 → again
        self.ok(self.regrade(sid, st["round_id"], "good"))
        it = self.saved()["scheduler"]["items"]["char:1"]
        exp = self.expected_item("char:1", "good")
        for f in ("seen", "I", "fails", "lapses", "proven", "F", "parked"):
            self.assertEqual(it[f], exp[f], f)
        self.assertEqual(it["lapses"], 0)                               # 改过之后不会重复累计 lapses

    def test_regrade_many_times_counts_once(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st, _ = self.end_round(sid, 1)
        for g in ("good", "again", "hard", "again"):
            self.ok(self.regrade(sid, st["round_id"], g))
        it = self.saved()["scheduler"]["items"]["char:1"]
        self.assertEqual((it["lapses"], it["seen"], self.saved()["scheduler"]["games"]), (1, 1, 1))

    def test_only_latest_ended_round_can_be_regraded(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st1, _ = self.end_round(sid, 1)
        st2, _ = self.end_round(sid, 7)
        d = self.err(self.regrade(sid, st1["round_id"], "good"), 409, "not_last_round")
        self.assertIn("最近", d["message"])
        self.ok(self.regrade(sid, st2["round_id"], "good"))

    def test_cannot_regrade_unfinished_or_unknown_round(self):
        sess = self.new_session()
        sid = sess["session_id"]
        self.err(self.regrade(sid, "nothing", "good"), 409, "not_last_round")          # 还没结束过任何一局
        st = self.start(sid, 1)
        self.err(self.regrade(sid, st["round_id"], "good"), 409, "not_last_round")     # 正在进行的这局
        self.err(self.regrade(sid, "nothing", "good"), 409, "not_last_round")

    def test_regrade_works_after_next_round_started_and_leaves_it_alone(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st1, _ = self.end_round(sid, 1)
        st2 = self.start(sid, 7)                                        # 自动模式：下一局已经开了
        self.ok(self.guess(sid, st2["round_id"], 6))
        r = self.ok(self.regrade(sid, st1["round_id"], "good"))
        self.assertEqual(r["grade"], "good")
        d = self.ok(self.guess(sid, st2["round_id"], 7))                # 进行中的这局照常
        self.assertEqual(d["end"]["answer_id"], 7)
        self.assertEqual(self.saved()["scheduler"]["games"], 2)

    def test_regrade_after_later_round_ended_is_refused(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st1, _ = self.end_round(sid, 1)
        self.end_round(sid, 7)
        self.err(self.regrade(sid, st1["round_id"], "easy"), 409, "not_last_round")
        self.assertEqual(self.saved()["scheduler"]["items"]["char:1"]["rev"]["grade"], "again")

    def test_char_reappeared_409(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st, _ = self.end_round(sid, 1)
        SOLO._entries[("anime", "work")].sch.state["items"]["char:1"]["rev"]["vt"] += 5      # 模拟：这个角色之后又出现过
        self.err(self.regrade(sid, st["round_id"], "good"), 409, "char_reappeared")

    def test_bad_grade_422(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st, _ = self.end_round(sid, 1)
        for bad in ("meh", None, 3, ""):
            self.err(self.post("/round/regrade", session_id=sid, round_id=st["round_id"], grade=bad), 422, "bad_grade")

    def test_same_grade_is_noop(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st, end = self.end_round(sid, 1)                                # again
        before = self.saved()["scheduler"]["items"]["char:1"]
        n_lines = len(self.log_lines())
        r = self.ok(self.regrade(sid, st["round_id"], "again"))
        self.assertEqual((r["grade"], r["progress"]["events"]), ("again", []))
        self.assertEqual(self.saved()["scheduler"]["items"]["char:1"], before)
        self.assertEqual(len(self.log_lines()), n_lines)

    def test_regrade_log_line_and_event(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st, _ = self.end_round(sid, 1)                                  # again
        r = self.ok(self.regrade(sid, st["round_id"], "easy"))
        lines = self.log_lines()
        self.assertEqual([x["kind"] for x in lines], ["round", "regrade"])
        ln = lines[1]
        self.assertEqual((ln["char_id"], ln["round_id"], ln["old_grade"], ln["grade"]), (1, st["round_id"], "again", "easy"))
        self.assertEqual(ln["next_gap"], r["next_gap"])
        self.assertIn("ts", ln)
        self.assertTrue(any(e["type"] == "regraded" for e in r["progress"]["events"]))
        # 再改一次：old_grade 是上一次改的结果
        self.ok(self.regrade(sid, st["round_id"], "hard"))
        self.assertEqual((self.log_lines()[2]["old_grade"], self.log_lines()[2]["grade"]), ("easy", "hard"))

    def test_regrade_survives_restart_only_within_session(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st, _ = self.end_round(sid, 1)
        SOLO.reset()
        self.err(self.regrade(sid, st["round_id"], "good"), 404, "session_not_found")


# ================================================================ 落盘
class TestStorage(SoloCase):
    def test_state_file_layout(self):
        self.new_session()
        d = self.saved()
        self.assertEqual((d["version"], d["mode"], d["practice"]), (1, "anime", "work"))
        self.assertIsInstance(d["seed"], int)
        self.assertEqual(d["scheduler"]["version"], 1)
        self.assertEqual(sorted(d["scheduler"]["pool"]), sorted(f"char:{i}" for i in range(1, 18)))
        self.assertEqual(d["scheduler"]["groups"]["char:1"], ["101"])
        self.assertEqual(d["scheduler"]["groups"]["char:5"], ["102", "103"])
        self.assertEqual(os.listdir(os.path.join(self.tmp, "solo_v2")), ["sched_anime_work.json"])   # 没有残留的 .tmp

    def test_files_only_under_given_data_dir(self):
        self.new_session()
        self.assertTrue(self.sched_file().startswith(self.tmp))
        self.assertEqual(S.SoloService.root(), os.path.join(self.tmp, "solo_v2"))

    def test_reload_after_restart_keeps_progress_seed_and_items(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        end = self.ok(self.guess(sid, st["round_id"], 1))["end"]
        seed = self.saved()["seed"]
        SOLO.reset()                                                    # 后端重启
        sess2 = self.new_session()
        self.assertEqual(sess2["progress"]["total"], end["progress"]["total"])
        self.assertEqual(self.saved()["seed"], seed)                    # 种子不变 → 新角色出场顺序不变
        self.assertEqual(self.saved()["scheduler"]["items"]["char:1"]["seen"], 1)
        b = self.start(sess2["session_id"], 7)
        self.assertEqual(b["round_no"], 2)

    def test_new_character_order_is_stable_across_restarts(self):
        s1 = self.new_session()
        first = self.saved()["scheduler"]["new_queue"]
        SOLO.reset()
        self.new_session()
        self.assertEqual(self.saved()["scheduler"]["new_queue"], first)
        self.assertNotEqual(first, sorted(first, key=lambda k: int(k.split(":")[1])))   # 确实打乱过（17 人，撞上原顺序的概率可忽略）

    def test_corrupt_state_file_is_kept_aside_and_rebuilt(self):
        self.new_session()
        SOLO.reset()
        with open(self.sched_file(), "w", encoding="utf-8") as f:
            f.write("{这不是 json")
        d = self.new_session()
        self.assertTrue(any("进度文件读不出来" in w for w in d["warnings"]), d["warnings"])
        names = os.listdir(os.path.join(self.tmp, "solo_v2"))
        self.assertTrue(any(n.startswith("sched_anime_work.json.bad-") for n in names), names)
        self.assertEqual(self.saved()["version"], 1)                    # 已重建
        self.assertEqual(d["progress"]["total"], 0)
        d2 = self.new_session()                                         # 进度文件的提示只给一次
        self.assertFalse(any("进度文件" in w for w in d2["warnings"]))

    def test_state_file_with_wrong_shape_is_treated_as_corrupt(self):
        os.makedirs(os.path.join(self.tmp, "solo_v2"))
        with open(self.sched_file(), "w", encoding="utf-8") as f:
            json.dump({"version": 1}, f)
        d = self.new_session()
        self.assertTrue(any("进度文件读不出来" in w for w in d["warnings"]))

    def test_atomic_write_replaces_whole_file(self):
        path = os.path.join(self.tmp, "x", "a.json")
        S.atomic_write_json(path, {"a": 1})
        S.atomic_write_json(path, {"a": 2, "中": "文"})
        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"a": 2, "中": "文"})
        self.assertEqual(os.listdir(os.path.dirname(path)), ["a.json"])

    def test_atomic_write_failure_keeps_old_file(self):
        path = os.path.join(self.tmp, "a.json")
        S.atomic_write_json(path, {"a": 1})
        with mock.patch.object(S.json, "dump", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                S.atomic_write_json(path, {"a": 2})
        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"a": 1})
        self.assertEqual(os.listdir(self.tmp), ["a.json"])               # 半截的 tmp 也清掉了

    def test_atomic_write_retries_when_replace_is_blocked(self):
        path = os.path.join(self.tmp, "a.json")
        real = os.replace
        calls = []

        def flaky(src, dst):
            calls.append(1)
            if len(calls) < 3:
                raise PermissionError("被占用")
            return real(src, dst)

        with mock.patch.object(S.os, "replace", flaky), mock.patch.object(S.time, "sleep"):
            S.atomic_write_json(path, {"a": 3})
        self.assertEqual(len(calls), 3)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"a": 3})

    def test_atomic_write_gives_up_after_five_blocked_tries(self):
        path = os.path.join(self.tmp, "a.json")
        with mock.patch.object(S.os, "replace", side_effect=PermissionError("被占用")), mock.patch.object(S.time, "sleep"):
            with self.assertRaises(PermissionError):
                S.atomic_write_json(path, {"a": 3})
        self.assertEqual(os.listdir(self.tmp), [])

    def test_state_is_saved_after_every_change(self):
        sess = self.new_session()
        sid = sess["session_id"]
        st = self.start(sid, 1)
        cur = self.saved()["scheduler"]["current"]
        self.assertEqual((cur["key"], cur["round_id"]), ("char:1", st["round_id"]))
        self.surrender(sid, st["round_id"])
        self.assertIsNone(self.saved()["scheduler"]["current"])
        self.assertEqual(self.saved()["scheduler"]["games"], 1)


# ================================================================ Bangumi 在线搜索
class FakeBgm:
    def __init__(self, chars=None, subjects=None, exc=None, delay=0.0):
        self.chars, self.subjects, self.exc, self.delay = chars or [], subjects or [], exc, delay
        self.calls = []

    async def _wait(self):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc

    async def search_characters(self, keyword, limit=20, offset=0):
        self.calls.append(("character", keyword, limit))
        await self._wait()
        return {"data": self.chars, "total": len(self.chars)}

    async def search_subjects(self, keyword, types):
        self.calls.append(("subject", keyword, list(types)))
        await self._wait()
        return self.subjects


CHAR_RESULTS = [
    {"id": 1, "name": "Kakkou", "infobox": [{"key": "简体中文名", "value": "角色一"}]},
    {"id": 888888, "name": "Nobody"},
    {"id": "bad"},
]
SUBJECT_RESULTS = [
    {"id": 101, "name": "Yuri Daily", "name_cn": "百合日常番", "date": "2024-04-01"},
    {"id": 777777, "name": "Only Original", "name_cn": "", "date": ""},
]


class TestBgmSearch(SoloCase):
    def search(self, fake, **params):
        with mock.patch.object(session_router, "get_bgm_client", return_value=fake):
            return client.get(URL + "/bgm_search", params=params)

    def test_character_search(self):
        fake = FakeBgm(chars=CHAR_RESULTS)
        r = self.search(fake, kind="character", q="角色", limit=5)
        d = self.ok(r)
        self.assertEqual(fake.calls, [("character", "角色", 5)])
        self.assertEqual(len(d), 2)                                      # 没有数字 id 的那条被丢掉
        self.assertEqual(d[0], {"id": 1, "name": "Kakkou", "name_cn": "角色一", "in_library": True,
                                "label": "角色一（Kakkou）"})
        self.assertEqual(d[1], {"id": 888888, "name": "Nobody", "name_cn": None, "in_library": False,
                                "label": "Nobody"})

    def test_subject_search_types_follow_mode(self):
        for mode, types in (("anime", [2]), ("book", [1]), ("game", [4]), ("real", [6]), ("all", [1, 2, 4, 6])):
            fake = FakeBgm(subjects=SUBJECT_RESULTS)
            d = self.ok(self.search(fake, kind="subject", q="番", mode=mode))
            self.assertEqual(fake.calls, [("subject", "番", types)], mode)
        self.assertEqual(d[0], {"id": 101, "name": "Yuri Daily", "name_cn": "百合日常番", "in_library": True,
                                "label": "百合日常番（Yuri Daily）（2024）"})
        self.assertEqual(d[1], {"id": 777777, "name": "Only Original", "name_cn": None, "in_library": False,
                                "label": "Only Original"})

    def test_default_mode_is_anime_and_limit_applies(self):
        fake = FakeBgm(subjects=SUBJECT_RESULTS)
        d = self.ok(self.search(fake, kind="subject", q="番", limit=1))
        self.assertEqual(fake.calls[0][2], [2])
        self.assertEqual(len(d), 1)

    def test_empty_query_returns_empty_without_network(self):
        fake = FakeBgm(chars=CHAR_RESULTS)
        self.assertEqual(self.ok(self.search(fake, kind="character", q="  ")), [])
        self.assertEqual(self.ok(self.search(fake, kind="character")), [])
        self.assertEqual(fake.calls, [])

    def test_offline_502_bgm_unavailable(self):
        d = self.err(self.search(FakeBgm(exc=ConnectionError("断网")), kind="character", q="x"), 502, "bgm_unavailable")
        self.assertIn("Bangumi 连不上", d["message"])
        self.err(self.search(FakeBgm(exc=RuntimeError("HTTP 500")), kind="subject", q="x"), 502, "bgm_unavailable")

    def test_timeout_502_bgm_unavailable(self):
        with mock.patch.object(session_router, "BGM_TIMEOUT_SEC", 0.05):
            self.err(self.search(FakeBgm(chars=CHAR_RESULTS, delay=2.0), kind="character", q="x"), 502, "bgm_unavailable")

    def test_client_construction_failure_is_also_502(self):
        with mock.patch.object(session_router, "get_bgm_client", side_effect=ImportError("no httpx")):
            self.err(client.get(URL + "/bgm_search", params={"kind": "character", "q": "x"}), 502, "bgm_unavailable")

    def test_bad_kind_and_mode_422(self):
        fake = FakeBgm()
        self.err(self.search(fake, kind="person", q="x"), 422, "bad_kind")
        self.err(self.search(fake, kind="subject", q="x", mode="nope"), 422, "bad_mode")
        self.assertEqual(client.get(URL + "/bgm_search", params={"q": "x"}).status_code, 422)     # 缺 kind
        self.assertEqual(fake.calls, [])


# ================================================================ 挂载
class TestMounted(unittest.TestCase):
    def test_app_includes_session_router(self):
        path = os.path.join(os.path.dirname(__file__), "..", "..", "app.py")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertRegex(src, r"from \.v2\.solo\.session_router import router as v2_solo_session_router")
        self.assertRegex(src, r"app\.include_router\(v2_solo_session_router\)")

    def test_routes_registered(self):
        paths = {(r.path, tuple(sorted(r.methods))) for r in session_router.router.routes}
        for p in ("/v2/solo/session", "/v2/solo/round/start", "/v2/solo/round/guess", "/v2/solo/round/timeout",
                  "/v2/solo/round/surrender", "/v2/solo/round/regrade"):
            self.assertIn((p, ("POST",)), paths)
        self.assertIn(("/v2/solo/bgm_search", ("GET",)), paths)


if __name__ == "__main__":
    unittest.main()
