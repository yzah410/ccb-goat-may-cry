# -*- coding: utf-8 -*-
"""预热进程池（aipool.py）：一次一用、补开、空闲关闭、提示词变了换进程、取消、退出清理、通道检查。

两层测试：
- Pool 的调度逻辑：用假进程对象（不起任何子进程）。
- WarmProc 的真实子进程读写：用 tests/fake_claude.py 冒充 claude（stream-json 协议一样，不调真 AI），
  包括「整棵进程树一起结束」（Windows 作业对象）。
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import unittest

from . import base  # noqa: F401  （设置合成库环境变量）
from backend.v2 import aipool

FAKE = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_claude.py")]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def wait_until(cond, timeout=5.0, step=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(step)
    return cond()


def pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.restype = ctypes.c_void_p
        h = k.OpenProcess(0x1000, False, int(pid))            # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        k.GetExitCodeProcess(ctypes.c_void_p(h), ctypes.byref(code))
        k.CloseHandle(ctypes.c_void_p(h))
        return code.value == 259                              # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# ================================================================ 假进程（调度逻辑）
class FakeProc:
    n = 0

    def __init__(self, kind, key, system):
        FakeProc.n += 1
        self.pid = 10000 + FakeProc.n
        self.kind, self.key, self.system = kind, key, system
        self.used = False
        self.killed = False
        self.finished = False
        self.dead = False
        self.born = time.monotonic()

    def alive(self):
        return not (self.killed or self.finished or self.dead)

    def kill(self):
        self.killed = True

    def finish(self):
        self.finished = True

    def age_s(self):
        return time.monotonic() - self.born

    def stderr_tail(self):
        return "假进程"


class PoolHarness:
    def __init__(self, idle=600.0):
        self.spawned = []
        self.version = 1
        self.channel = (True, "ok")
        self.channel_calls = []
        self.enabled = True
        self.idle = idle
        self.pool = aipool.Pool(spawn=self._spawn, prompt_for=self._prompt, channel_check=self._check,
                                enabled=lambda: self.enabled, idle_s=lambda: self.idle, reap_every=3600)

    def _spawn(self, kind, key, system):
        p = FakeProc(kind, key, system)
        self.spawned.append(p)
        return p

    def _prompt(self, kind):
        s = f"系统提示词 {kind} v{self.version}"
        return s, aipool.Pool.key_for(s)

    def _check(self, full):
        self.channel_calls.append(full)
        return self.channel

    def key(self, kind):
        return self._prompt(kind)[1]

    def system(self, kind):
        return self._prompt(kind)[0]


class TestPoolScheduling(unittest.TestCase):
    def test_warm_spawns_one_per_kind(self):
        h = PoolHarness()
        h.pool.warm(["fill", "ask", "nope"])
        self.assertTrue(wait_until(lambda: len(h.spawned) == 2))
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready"))
        self.assertEqual(sorted(p.kind for p in h.spawned), ["ask", "fill"])
        h.pool.warm(["fill"])                              # 已经有了：不再开第二个
        time.sleep(0.2)
        self.assertEqual(len(h.spawned), 2)
        self.assertIn(True, h.channel_calls)               # 开进程之前做了完整通道检查（含 auth status）
        h.pool.shutdown()

    def test_refill_waits_for_old_process_to_exit(self):
        """同一种用途任何时刻最多一个进程：补开的新进程要等用过的那个退出之后才开。"""
        h = PoolHarness()
        seen = []
        orig = h._spawn

        def spawn(kind, key, system):
            seen.append([p.finished or p.killed for p in h.spawned])        # 开新进程时，之前的都已经结束了吗
            return orig(kind, key, system)
        h.pool._spawn = spawn
        h.pool.warm(["fill"])
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready"))
        wp, _ = h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        h.pool.release("fill", wp)
        self.assertTrue(wait_until(lambda: len(h.spawned) == 2))
        self.assertEqual(seen[1], [True])
        h.pool.shutdown()

    def test_no_second_process_of_same_kind_while_one_is_in_use(self):
        """连续提问（上一个的补开还没开出来）：请求自己现开一个，这期间不再补开同一种用途的第二个；用完再补开。"""
        h = PoolHarness()
        wp, warm = h.pool.acquire("fill", h.system("fill"), h.key("fill"))      # 池子空：现开（在用）
        self.assertFalse(warm)
        h.pool.warm(["fill"])                                                   # 页面又来预热
        h.pool._ensure("fill")
        time.sleep(0.2)
        self.assertEqual(len(h.spawned), 1)                                     # 在用的那个之外没有再开
        h.pool.release("fill", wp)
        self.assertTrue(wait_until(lambda: len(h.spawned) == 2))               # 用完才补开
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready"))
        h.pool.shutdown()

    def test_one_use_then_refill(self):
        h = PoolHarness()
        h.pool.warm(["fill"])
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready"))
        first = h.spawned[0]
        wp, warm = h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        self.assertIs(wp, first)
        self.assertTrue(warm)
        self.assertEqual(h.pool.status()["slots"]["fill"]["state"] != "ready", True)   # 被借走了
        self.assertEqual(h.pool.status()["active"], 1)
        h.pool.release("fill", wp)
        self.assertTrue(wait_until(lambda: first.finished))                 # 用完就结束（关 stdin 让它退出）
        self.assertTrue(wait_until(lambda: len(h.spawned) == 2))             # 后台补开下一个
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready"))
        self.assertIsNot(h.spawned[1], first)
        self.assertEqual(h.pool.status()["active"], 0)
        wp2, warm2 = h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        self.assertIs(wp2, h.spawned[1])                                     # 不会把用过的进程再借出去
        self.assertTrue(warm2)
        h.pool.shutdown()

    def test_cold_start_when_nothing_warm(self):
        h = PoolHarness()
        wp, warm = h.pool.acquire("ask", h.system("ask"), h.key("ask"))
        self.assertFalse(warm)
        self.assertEqual(len(h.spawned), 1)
        self.assertEqual(h.pool.stats["cold_starts"], 1)
        h.pool.shutdown()
        self.assertTrue(wp.killed)                                           # 退出时正在用的也关掉

    def test_prompt_changed_replaces_process(self):
        h = PoolHarness()
        h.pool.warm(["ask"])
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["ask"]["state"] == "ready"))
        old = h.spawned[0]
        h.version = 2                                                        # 例：库重载后表结构 / 统计数字变了
        wp, warm = h.pool.acquire("ask", h.system("ask"), h.key("ask"))
        self.assertFalse(warm)                                               # 旧提示词的进程不能用
        self.assertTrue(wait_until(lambda: old.killed))
        self.assertIn("v2", wp.system)
        h.pool.shutdown()

    def test_reaper_replaces_stale_prompt_in_background(self):
        h = PoolHarness()
        h.pool.warm(["ask"])
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["ask"]["state"] == "ready"))
        old = h.spawned[0]
        h.version = 3
        h.pool.reap_once()                                                   # 巡检：发现提示词变了 → 换
        self.assertTrue(wait_until(lambda: old.killed))
        self.assertTrue(wait_until(lambda: len(h.spawned) == 2 and "v3" in h.spawned[1].system))
        h.pool.shutdown()

    def test_idle_timeout_closes(self):
        h = PoolHarness(idle=600)
        h.pool.warm(["fill"])
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready"))
        p = h.spawned[0]
        h.pool.reap_once(now=time.monotonic() + 30)                          # 30 秒：还在
        self.assertFalse(p.killed)
        h.pool.reap_once(now=time.monotonic() + 601)                         # 10 分钟没人用：关掉，不补开
        self.assertTrue(wait_until(lambda: p.killed))
        time.sleep(0.2)
        self.assertEqual(len(h.spawned), 1)
        self.assertEqual(h.pool.status()["slots"]["fill"]["state"], "none")
        self.assertEqual(h.pool.stats["killed_idle"], 1)
        h.pool.shutdown()

    def test_no_refill_after_idle(self):
        h = PoolHarness(idle=0.05)
        h.pool.touch("fill")
        time.sleep(0.1)
        h.pool._ensure("fill")                                              # 很久没人用：不开
        self.assertEqual(h.spawned, [])
        h.pool.shutdown()

    def test_dead_warm_process_respawned_but_not_forever(self):
        h = PoolHarness()
        h.pool.warm(["fill"])
        self.assertTrue(wait_until(lambda: len(h.spawned) == 1))
        for i in range(5):
            wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready", timeout=1)
            h.spawned[-1].dead = True                                        # 预热的进程自己死了
            h.pool.reap_once()
        time.sleep(0.2)
        self.assertLessEqual(len(h.spawned), 4)                              # 连续 3 次刚开就死：不再重开
        self.assertIn("刚开就退出", h.pool.status()["slots"]["fill"]["last_error"] or "")
        n = len(h.spawned)
        h.pool.warm(["fill"])                                                # 用户又来了：清零再试
        self.assertTrue(wait_until(lambda: len(h.spawned) == n + 1))
        h.pool.shutdown()

    def test_channel_check_blocks_spawn(self):
        h = PoolHarness()
        h.channel = (False, "ANTHROPIC_BASE_URL 不是官方域名，拒绝调用")
        h.pool.warm(["fill"])
        time.sleep(0.3)
        self.assertEqual(h.spawned, [])
        self.assertIn("拒绝调用", h.pool.status()["slots"]["fill"]["last_error"])
        with self.assertRaises(aipool.PoolError) as cm:
            h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        self.assertEqual(cm.exception.code, "channel")
        self.assertEqual(h.spawned, [])
        h.pool.shutdown()

    def test_channel_rechecked_before_handing_out_warm_process(self):
        h = PoolHarness()
        h.pool.warm(["fill"])
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["fill"]["state"] == "ready"))
        p = h.spawned[0]
        h.channel = (False, "切到了按量计费通道")                             # 预热之后用户把命令行切到了按量计费的通道
        with self.assertRaises(aipool.PoolError):
            h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        self.assertTrue(wait_until(lambda: p.killed))
        self.assertIn(False, h.channel_calls)                                # 快速检查（不跑 auth status）
        h.pool.shutdown()

    def test_disabled_pool_does_not_warm(self):
        h = PoolHarness()
        h.enabled = False
        h.pool.warm(["fill", "ask"])
        time.sleep(0.2)
        self.assertEqual(h.spawned, [])
        h.pool.shutdown()

    def test_shutdown_kills_everything(self):
        h = PoolHarness()
        h.pool.warm(["fill", "ask"])
        self.assertTrue(wait_until(lambda: len(h.spawned) == 2))
        self.assertTrue(wait_until(lambda: h.pool.status()["slots"]["ask"]["state"] == "ready"))
        wp, _ = h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        h.pool.shutdown()
        self.assertTrue(all(p.killed for p in h.spawned))
        with self.assertRaises(aipool.PoolError):
            h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        h.pool.warm(["fill"])                                                # 退出之后不再开
        time.sleep(0.1)
        self.assertEqual(len(h.spawned), 2)

    def test_acquire_waits_for_spawn_in_progress(self):
        """后台正在开的那个马上就好：请求等它，而不是再开第二个。"""
        gate = threading.Event()
        h = PoolHarness()
        orig = h._spawn

        def slow_spawn(kind, key, system):
            gate.wait(1)
            return orig(kind, key, system)
        h.pool._spawn = slow_spawn
        h.pool.warm(["fill"])
        time.sleep(0.05)
        threading.Timer(0.2, gate.set).start()
        wp, warm = h.pool.acquire("fill", h.system("fill"), h.key("fill"))
        self.assertTrue(warm)
        self.assertEqual(len(h.spawned), 1)
        h.pool.shutdown()


# ================================================================ 真子进程（fake_claude.py 冒充 claude）
def make(system="MODE=normal", kind="fill"):
    return aipool.WarmProc(kind, "k", list(FAKE), system, model="sonnet", effort="low",
                           env=dict(os.environ, PYTHONIOENCODING="utf-8"), creationflags=NO_WINDOW)


class TestWarmProcReal(unittest.TestCase):
    def test_stream_and_one_use(self):
        wp = make()
        texts = []
        ev = wp.run("用户的问题：一加一等于几", 20, threading.Event(), texts.append)
        self.assertEqual(ev["type"], "result")
        self.assertEqual("".join(texts), ev["result"])
        self.assertTrue(ev["result"].startswith("好的："))
        self.assertGreater(len(texts), 1)                                    # 是一段一段来的
        self.assertTrue(wp.alive())                                          # 答完还在等 stdin（和真 claude 一样）
        d = wp.dir
        wp.finish(grace_s=5)                                                 # 关 stdin → 自己退出
        self.assertFalse(wp.alive())
        self.assertFalse(os.path.exists(d))                                  # 临时目录删掉了

    def test_args_have_required_flags(self):
        wp = make()
        try:
            a = wp.args
            for flag in ("-p", "--input-format", "stream-json", "--output-format", "--include-partial-messages",
                         "--no-session-persistence", "--tools", "--strict-mcp-config", "--safe-mode",
                         "--system-prompt-file", "--settings"):
                self.assertIn(flag, a)
            self.assertEqual(a[a.index("--tools") + 1], "")
            self.assertEqual(a[a.index("--effort") + 1], "low")
            with open(a[a.index("--settings") + 1], encoding="utf-8") as f:
                self.assertIn('"disableAllHooks": true', f.read())
        finally:
            wp.kill()

    def test_thinking_callback(self):
        wp = make("MODE=thinking")
        seen = []
        try:
            wp.run("x", 20, threading.Event(), lambda t: seen.append("text"), lambda: seen.append("think"))
            self.assertEqual(seen[0], "think")
            self.assertIn("text", seen)
        finally:
            wp.kill()

    def test_died_before_output(self):
        wp = make("MODE=die")
        with self.assertRaises(aipool.ProcDead) as cm:
            wp.run("x", 20, threading.Event(), lambda t: None)
        self.assertTrue(cm.exception.before_output)
        wp.kill()
        wp2 = make("MODE=die_after_read")
        with self.assertRaises(aipool.ProcDead) as cm:
            wp2.run("x", 20, threading.Event(), lambda t: None)
        self.assertTrue(cm.exception.before_output)
        wp2.kill()

    def test_big_message_while_not_reading_yet(self):
        """消息比管道缓冲（约 4 KB）大、claude 还没开始读 stdin 时，写会卡住——取消照样立刻生效，不卡死。"""
        big = "很长的问题" * 40000                                            # 约 600 KB
        wp = make("MODE=slowread")
        cancel = threading.Event()
        threading.Timer(0.5, cancel.set).start()
        t = time.monotonic()
        with self.assertRaises(aipool.Cancelled):
            wp.run(big, 20, cancel, lambda s: None)
        self.assertLess(time.monotonic() - t, 1.5)                          # 没有等到 fake 开始读（2 秒后）
        wp.kill()
        wp = make("MODE=slowread")                                          # 不取消：等它开始读之后照常答完
        try:
            ev = wp.run(big, 20, threading.Event(), lambda s: None)
            self.assertTrue(ev["result"].startswith("好的："))
        finally:
            wp.kill()

    def test_died_after_thinking_is_not_before_output(self):
        """已经开始想了（收到过 stream 事件）才退出：不当成「还没开始」，不会换进程重发一次。"""
        wp = make("MODE=think_then_die")
        with self.assertRaises(aipool.ProcDead) as cm:
            wp.run("x", 20, threading.Event(), lambda t: None, lambda: None)
        self.assertFalse(cm.exception.before_output)
        wp.kill()

    def test_stall_and_timeout(self):
        wp = make("MODE=stall")
        t = time.monotonic()
        with self.assertRaises(aipool.Stalled):
            wp.run("x", 20, threading.Event(), lambda t: None, stall_s=0.6)
        self.assertLess(time.monotonic() - t, 5)
        wp.kill()
        wp = make("MODE=stall")
        with self.assertRaises(aipool.Timeout):
            wp.run("x", 0.6, threading.Event(), lambda t: None)
        wp.kill()

    def test_cancel_kills_process(self):
        wp = make("MODE=slow")
        cancel = threading.Event()
        got = []

        def later():
            wait_until(lambda: len(got) >= 1, timeout=10)
            cancel.set()
            wp.kill()
        threading.Thread(target=later, daemon=True).start()
        with self.assertRaises(aipool.Cancelled):
            wp.run("一个比较长的问题，让它慢慢写", 20, cancel, got.append)
        self.assertTrue(wait_until(lambda: not wp.alive()))
        self.assertLess(len(got), 6)                                         # 没写完就停了

    def test_kill_takes_whole_tree(self):
        """退出清理：kill 要连孙子进程一起结束（Windows 作业对象 / taskkill /T）。"""
        wp = make("MODE=grandchild")
        self.assertTrue(wait_until(lambda: any("GRANDCHILD" in x for x in wp.err_tail), timeout=10))
        gpid = int([x for x in wp.err_tail if "GRANDCHILD" in x][0].split()[1])
        self.assertTrue(pid_alive(gpid))
        pid = wp.pid
        wp.kill()
        self.assertTrue(wait_until(lambda: not pid_alive(gpid), timeout=10))
        self.assertTrue(wait_until(lambda: not pid_alive(pid), timeout=10))

    def test_pool_shutdown_real_processes(self):
        """整套：池子里的真进程（含孙子进程）在 shutdown 后全部结束。"""
        made = []

        def spawn(kind, key, system):
            p = make("MODE=grandchild", kind)
            made.append(p)
            return p
        pool = aipool.Pool(spawn=spawn, prompt_for=lambda k: ("s", "k"), channel_check=lambda full: (True, "ok"),
                           enabled=lambda: True, idle_s=lambda: 600, reap_every=3600)
        pool.warm(["fill", "ask"])
        self.assertTrue(wait_until(lambda: len(made) == 2, timeout=10))
        self.assertTrue(wait_until(lambda: all(any("GRANDCHILD" in x for x in p.err_tail) for p in made), timeout=10))
        gpids = [int([x for x in p.err_tail if "GRANDCHILD" in x][0].split()[1]) for p in made]
        pids = [p.pid for p in made]
        pool.shutdown()
        for pid in gpids + pids:
            self.assertTrue(wait_until(lambda: not pid_alive(pid), timeout=10), pid)


if __name__ == "__main__":
    unittest.main()
