# -*- coding: utf-8 -*-
"""claude 预热进程池 + 流式读取（给 /v2/ai/* 提速）。

为什么要预热：每次新开一个 `claude -p` 进程，光启动就要约 6 秒，模型答一句短话只要 1–2 秒。
做法：
- 每种用途（fill = 填工作台、ask = 问数据）最多提前开好 **一个** claude 进程。系统提示词在启动时就给定
  （--system-prompt-file），进程停在 stdin 上等（--input-format stream-json）。
- 请求来了：往它的 stdin 写一行 {"type":"user","message":{...}}，边读 stdout 的 stream-json 事件边把文字转出去。
- **一个进程只服务一次请求**：拿到结果就关掉 stdin、让它退出（对话不会越积越长），然后在后台补开下一个。
- 空闲 10 分钟（v2.ai.warm_idle_s）没人用就关掉；后端退出时全部关掉。
- 系统提示词变了（例：库重载后问数据的表结构 / 统计数字变了、日期变了、模型 / effort 配置变了）→ 预热的进程作废，换新的。

不留孤儿进程（Windows）：每个 claude 进程放进一个「作业对象」（Job Object，设了 KILL_ON_JOB_CLOSE）。
- 关一个进程 = TerminateJobObject（整棵进程树一起结束），拿不到作业对象时退回 `taskkill /T /F`；
- 后端进程不管怎么退出（包括被 taskkill /F 强杀），系统都会关掉它持有的作业句柄，里面的 claude 进程跟着结束。

计费：开进程之前必须先过订阅通道检查（由调用方传进来的 channel_check 做，见 ai.check_claude_channel）；
子进程环境清掉各种 API key（ai.child_env）。这个模块本身不决定用哪个通道。
"""
from __future__ import annotations

import collections
import hashlib
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

KINDS = ("fill", "ask")


class PoolError(Exception):
    """开进程 / 通道检查失败（message 是给人看的中文）。code 和 ai.AIError 的 code 对应。"""

    def __init__(self, message: str, code: str = "ai_error"):
        self.message = message
        self.code = code
        super().__init__(message)


class ProcDead(Exception):
    """预热的进程在给出结果之前就退出了。before_output=True 表示 AI 还一个字都没写（可以换个进程重来一次）。"""

    def __init__(self, message: str, before_output: bool):
        self.message = message
        self.before_output = before_output
        super().__init__(message)


class Cancelled(Exception):
    pass


class Timeout(Exception):
    pass


class Stalled(Exception):
    """发出请求之后连续 seconds 秒一个事件都没有（连「在想」的事件都没有）：多半是卡住了。"""

    def __init__(self, seconds: float):
        self.seconds = seconds
        super().__init__(f"{seconds:g}s")


# ================================================================ Windows 作业对象（整棵进程树一起结束）
_JOB_OK = False
if os.name == "nt":
    try:
        import ctypes
        from ctypes import wintypes

        _k32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class _IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                          "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class _BASIC_LIMIT(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class _EXT_LIMIT(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", _BASIC_LIMIT), ("IoInfo", _IO_COUNTERS),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        _k32.CreateJobObjectW.restype = wintypes.HANDLE
        _k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        _k32.SetInformationJobObject.restype = wintypes.BOOL
        _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        _k32.AssignProcessToJobObject.restype = wintypes.BOOL
        _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        _k32.TerminateJobObject.restype = wintypes.BOOL
        _k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        _k32.CloseHandle.restype = wintypes.BOOL
        _k32.CloseHandle.argtypes = [wintypes.HANDLE]
        _JOB_OK = True
    except Exception:  # noqa: BLE001
        _JOB_OK = False

_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9


class _Job:
    """一个 Windows 作业对象，装一个进程（和它以后开的子进程）。"""

    def __init__(self, handle: int):
        self.handle = handle
        self._lock = threading.Lock()

    @classmethod
    def for_process(cls, proc: subprocess.Popen) -> Optional["_Job"]:
        if not _JOB_OK:
            return None
        try:
            h = _k32.CreateJobObjectW(None, None)
            if not h:
                return None
            info = _EXT_LIMIT()
            info.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE
            if not _k32.SetInformationJobObject(h, _JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
                _k32.CloseHandle(h)
                return None
            if not _k32.AssignProcessToJobObject(h, int(proc._handle)):   # noqa: SLF001  Popen 在 Windows 上的进程句柄
                _k32.CloseHandle(h)
                return None
            return cls(h)
        except Exception:  # noqa: BLE001
            return None

    def terminate(self) -> bool:
        with self._lock:
            if not self.handle:
                return False
            ok = bool(_k32.TerminateJobObject(self.handle, 1))
            _k32.CloseHandle(self.handle)            # KILL_ON_JOB_CLOSE：关句柄也会结束里面剩下的进程
            self.handle = 0
            return ok

    def close(self) -> None:
        with self._lock:
            if self.handle:
                _k32.CloseHandle(self.handle)
                self.handle = 0


def kill_tree(proc: subprocess.Popen, job: Optional[_Job] = None) -> None:
    """结束整棵进程树：优先作业对象，退回 taskkill /T /F，再退回 proc.kill()。"""
    if proc.poll() is not None and job is None:
        return
    try:
        if job is not None and job.terminate():
            return
    except Exception:  # noqa: BLE001
        pass
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            proc.kill()
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


# ================================================================ 一个预热的 claude 进程
class WarmProc:
    """一个开好的 `claude -p --input-format stream-json` 进程。只服务一次请求。"""

    def __init__(self, kind: str, key: str, cmd: List[str], system: str, model: str, effort: Optional[str],
                 env: Dict[str, str], creationflags: int = 0, extra_args: Optional[List[str]] = None):
        self.kind = kind
        self.key = key
        self.born = time.monotonic()
        self.used = False
        self.dir = tempfile.mkdtemp(prefix="ccb_ai_")      # 空目录：读不到任何 CLAUDE.md
        sp = os.path.join(self.dir, "system.txt")
        st = os.path.join(self.dir, "settings.json")
        with open(sp, "w", encoding="utf-8") as f:
            f.write(system)
        with open(st, "w", encoding="utf-8") as f:
            json.dump({"disableAllHooks": True}, f)
        args = cmd + ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                      "--include-partial-messages", "--no-session-persistence", "--tools", "",
                      "--model", model, "--settings", st, "--system-prompt-file", sp, "--strict-mcp-config", "--safe-mode"]
        if effort:
            args += ["--effort", effort]
        args += list(extra_args or [])
        self.args = args
        self.q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self.err_tail: "collections.deque[str]" = collections.deque(maxlen=30)
        self._killed = False
        self._lock = threading.Lock()
        try:
            self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         cwd=self.dir, env=env, creationflags=creationflags)
        except OSError as e:
            shutil.rmtree(self.dir, ignore_errors=True)
            raise PoolError(f"开 claude 进程失败：{e}")
        self.job = _Job.for_process(self.proc)
        threading.Thread(target=self._read_stdout, name=f"ai-{kind}-out", daemon=True).start()
        threading.Thread(target=self._read_stderr, name=f"ai-{kind}-err", daemon=True).start()

    # ---------------------------------------------------------- 读输出
    def _read_stdout(self) -> None:
        try:
            for raw in self.proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    self.err_tail.append(line[:300])
                    continue
                if isinstance(obj, dict):
                    self.q.put(obj)
        except Exception:  # noqa: BLE001
            pass
        finally:
            self.q.put(None)                  # None = 进程的输出结束了

    def _read_stderr(self) -> None:
        try:
            for raw in self.proc.stderr:
                s = raw.decode("utf-8", "replace").rstrip()
                if s:
                    self.err_tail.append(s[:300])
        except Exception:  # noqa: BLE001
            pass

    # ---------------------------------------------------------- 状态
    @property
    def pid(self) -> int:
        return self.proc.pid

    def alive(self) -> bool:
        return not self._killed and self.proc.poll() is None

    def age_s(self) -> float:
        return time.monotonic() - self.born

    def stderr_tail(self) -> str:
        return " | ".join(list(self.err_tail)[-4:])[-400:]

    # ---------------------------------------------------------- 跑一次请求
    def run(self, user: str, timeout: float, cancelled: threading.Event, on_text: Callable[[str], None],
            on_thinking: Optional[Callable[[], None]] = None, stall_s: Optional[float] = None) -> Dict[str, Any]:
        """写入用户消息，读到 result 事件为止；返回 result 事件（里面的 result 字段就是完整回答）。
        stall_s：连续这么多秒一个事件都没有 → Stalled（claude -p 偶尔会一直没有输出，直到超时）。
        写 stdin 放在单独的线程里：消息比管道缓冲（约 4 KB）大、而 claude 还没开始读时，写会卡住——
        这时取消 / 超时 / 卡住检测照样生效。"""
        self.used = True
        line = json.dumps({"type": "user", "message": {"role": "user", "content": user}}, ensure_ascii=False) + "\n"
        wstate: Dict[str, Any] = {"done": False, "error": None}

        def write() -> None:
            try:
                self.proc.stdin.write(line.encode("utf-8"))
                self.proc.stdin.flush()
            except (OSError, ValueError) as e:       # 进程已经退出 / 管道被关（取消时会这样）
                wstate["error"] = e
            finally:
                wstate["done"] = True
        threading.Thread(target=write, name=f"ai-{self.kind}-in", daemon=True).start()
        deadline = time.monotonic() + timeout
        last_event = time.monotonic()
        started = False          # 收到过任何 stream 事件（在想 / 在写）= AI 已经开始处理这次请求
        while True:
            if cancelled.is_set():
                raise Cancelled()
            if wstate["error"] is not None and self.q.empty():
                raise ProcDead(f"claude 进程已经退出（{wstate['error']}）{self.stderr_tail()}", before_output=True)
            now = time.monotonic()
            left = deadline - now
            if left <= 0:
                raise Timeout()
            if stall_s and now - last_event > stall_s:
                raise Stalled(stall_s)
            try:
                ev = self.q.get(timeout=min(0.2, left))
            except queue.Empty:
                continue
            last_event = time.monotonic()
            if ev is None:
                if cancelled.is_set():
                    raise Cancelled()
                raise ProcDead(f"claude 进程提前退出了（退出码 {self.proc.poll()}）{self.stderr_tail()}", before_output=not started)
            typ = ev.get("type")
            if typ == "stream_event":
                started = True
                e = ev.get("event") or {}
                if e.get("type") == "content_block_delta":
                    d = e.get("delta") or {}
                    if d.get("type") == "text_delta" and d.get("text"):
                        on_text(str(d["text"]))
                    elif d.get("type") == "thinking_delta" and on_thinking is not None:
                        on_thinking()
            elif typ == "result":
                return ev

    # ---------------------------------------------------------- 结束
    def finish(self, grace_s: float = 3.0) -> None:
        """用完了：关 stdin 让它自己退出；grace_s 秒还没退就整棵杀掉；最后删临时目录。（阻塞，放后台线程里调）"""
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.wait(timeout=grace_s)
        except subprocess.TimeoutExpired:
            pass
        self.kill()

    def kill(self) -> None:
        with self._lock:
            first = not self._killed
            self._killed = True
        kill_tree(self.proc, self.job)
        if self.job is not None:
            self.job.close()
        if first:
            try:
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            for s in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    if s:
                        s.close()
                except Exception:  # noqa: BLE001
                    pass
            shutil.rmtree(self.dir, ignore_errors=True)


# ================================================================ 进程池
class Pool:
    """fill / ask 各最多一个预热好的进程（slot）；借出去的（active）用完就结束。

    依赖由 ai.py 注入（方便测试换成假进程）：
    - spawn(kind, key, system) -> 进程对象（有 alive() / kill() / finish() / key / used / pid / age_s()）
    - prompt_for(kind) -> (system, key)：当前应该用的系统提示词和它的指纹（ask 的提示词依赖库快照）
    - channel_check(full: bool) -> (ok, note)：订阅通道检查；full=True 时连 `claude auth status` 一起查
    - enabled() -> bool：现在默认引擎是不是 claude、配置里有没有关掉预热
    """

    def __init__(self, spawn: Callable[[str, str, str], Any], prompt_for: Callable[[str], Tuple[str, str]],
                 channel_check: Callable[[bool], Tuple[bool, str]], enabled: Callable[[], bool],
                 idle_s: Callable[[], float], reap_every: float = 5.0, recheck_every: float = 30.0):
        self._spawn = spawn
        self._prompt_for = prompt_for
        self._channel_check = channel_check
        self._enabled = enabled
        self._idle_s = idle_s
        self._reap_every = reap_every
        self._recheck_every = recheck_every
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._slots: Dict[str, Any] = {}
        self._active: set = set()
        self._touched: Dict[str, float] = {}
        self._spawning: Dict[str, bool] = {}
        self._fails: Dict[str, int] = {}
        self._last_error: Dict[str, Optional[str]] = {}
        self._last_recheck = 0.0
        self._reaper: Optional[threading.Thread] = None
        self._closed = False
        self.stats = {"spawned": 0, "warm_hits": 0, "cold_starts": 0, "killed_idle": 0, "replaced_stale": 0}

    # ---------------------------------------------------------- 工具
    @staticmethod
    def key_for(*parts: Any) -> str:
        h = hashlib.sha1()
        for p in parts:
            h.update(repr(p).encode("utf-8"))
            h.update(b"\x00")
        return h.hexdigest()[:16]

    def _ensure_reaper(self) -> None:
        with self._lock:
            if self._reaper is not None and self._reaper.is_alive():
                return
            self._reaper = threading.Thread(target=self._reap_loop, name="ai-pool-reaper", daemon=True)
            self._reaper.start()

    def _kill_async(self, procs: List[Any], finish: bool = False) -> None:
        procs = [p for p in procs if p is not None]
        if not procs:
            return

        def go():
            for p in procs:
                try:
                    p.finish() if finish else p.kill()
                except Exception:  # noqa: BLE001
                    pass
        threading.Thread(target=go, name="ai-pool-kill", daemon=True).start()

    def touch(self, kind: str) -> None:
        with self._lock:
            self._touched[kind] = time.monotonic()

    # ---------------------------------------------------------- 预热
    def warm(self, kinds: List[str]) -> None:
        """前端打开工作台 / 问数据页时调：记一下「有人要用」，没有进程就在后台开一个（不阻塞）。"""
        if self._closed:
            return
        for k in kinds:
            if k not in KINDS:
                continue
            self.touch(k)
            with self._lock:
                self._fails[k] = 0          # 用户主动来了：之前连续失败的计数清零，再试一次
            threading.Thread(target=self._ensure, args=(k,), name=f"ai-warm-{k}", daemon=True).start()
        self._ensure_reaper()

    def _ensure(self, kind: str) -> None:
        """保证 slot 里有一个和当前提示词对得上的活进程（后台线程里跑；会阻塞：可能要等库加载、跑 claude auth status）。"""
        with self._lock:
            if self._closed or self._spawning.get(kind):
                return
            if time.monotonic() - self._touched.get(kind, 0.0) > self._idle_s():
                return                                  # 很久没人用了，不开
            if self._fails.get(kind, 0) >= 3:
                return                                  # 连续 3 次刚开就死：别一直重开，等下一次 warm / 请求
            if any(getattr(p, "kind", None) == kind for p in self._active):
                return                                  # 这种用途正有请求在用进程：等它用完（release 会补开），同一种用途不同时开两个
            self._spawning[kind] = True
        stale = None
        try:
            if not self._enabled():
                return
            system, key = self._prompt_for(kind)
            with self._lock:
                cur = self._slots.get(kind)
                if cur is not None and cur.alive() and cur.key == key:
                    return
                if cur is not None:
                    stale = cur
                    self._slots[kind] = None
                    if cur.alive():
                        self.stats["replaced_stale"] += 1
            ok, note = self._channel_check(True)       # 开进程之前：订阅通道检查
            if not ok:
                self._last_error[kind] = note
                return
            wp = self._spawn(kind, key, system)
            with self._lock:
                self.stats["spawned"] += 1
                self._last_error[kind] = None
                if self._closed or self._slots.get(kind) is not None:
                    extra = wp
                else:
                    self._slots[kind] = wp
                    extra = None
                self._cond.notify_all()
            if extra is not None:
                extra.kill()
        except Exception as e:  # noqa: BLE001
            self._last_error[kind] = getattr(e, "message", None) or f"{type(e).__name__}: {e}"
        finally:
            with self._lock:
                self._spawning[kind] = False
                self._cond.notify_all()
            if stale is not None:
                self._kill_async([stale])

    # ---------------------------------------------------------- 借 / 还
    def acquire(self, kind: str, system: str, key: str, wait_spawning_s: float = 3.0) -> Tuple[Any, bool]:
        """拿一个进程来用：有对得上的预热进程就用它（warm=True），否则现开一个（warm=False）。
        预热进程被拿走之前再做一次快速通道检查（不跑 auth status）。开新进程之前做完整检查。"""
        if self._closed:
            raise PoolError("后端正在退出", code="ai_error")
        self.touch(kind)
        self._ensure_reaper()
        stale = None
        with self._lock:
            end = time.monotonic() + wait_spawning_s
            # 正在后台开的那个马上就好（Popen 本身很快）：等一下它，别再开第二个
            while self._slots.get(kind) is None and self._spawning.get(kind) and time.monotonic() < end:
                self._cond.wait(timeout=max(0.0, end - time.monotonic()))
            wp = self._slots.get(kind)
            if wp is not None:
                self._slots[kind] = None
                if wp.alive() and wp.key == key:
                    self._active.add(wp)
                else:
                    stale, wp = wp, None
        if stale is not None:
            self.stats["replaced_stale"] += 1
            self._kill_async([stale])
        if wp is not None:
            ok, note = self._channel_check(False)
            if not ok:
                with self._lock:
                    self._active.discard(wp)
                self._kill_async([wp])
                raise PoolError(note, code="channel")
            self.stats["warm_hits"] += 1
            return wp, True
        ok, note = self._channel_check(True)
        if not ok:
            raise PoolError(note, code="channel")
        wp = self._spawn(kind, key, system)
        with self._lock:
            self.stats["spawned"] += 1
            self.stats["cold_starts"] += 1
            if self._closed:
                self._kill_async([wp])
                raise PoolError("后端正在退出", code="ai_error")
            self._active.add(wp)
        return wp, False

    def release(self, kind: str, wp: Any, refill: bool = True) -> None:
        """一个进程只服务一次：在后台结束它，**等它退出之后**再补开下一个
        （同一种用途同时最多一个进程：fill + ask 两个都开着时，任何时刻最多 2 个 claude 进程）。"""
        with self._lock:
            self._active.discard(wp)
        self.touch(kind)

        def go() -> None:
            try:
                wp.finish()
            except Exception:  # noqa: BLE001
                pass
            if refill and not self._closed:
                self._ensure(kind)
        threading.Thread(target=go, name=f"ai-release-{kind}", daemon=True).start()

    # ---------------------------------------------------------- 后台巡检
    def _reap_loop(self) -> None:
        while not self._closed:
            time.sleep(self._reap_every)
            try:
                self.reap_once()
            except Exception:  # noqa: BLE001
                pass

    def reap_once(self, now: Optional[float] = None) -> None:
        now = time.monotonic() if now is None else now
        idle = self._idle_s()
        dead, respawn = [], []
        with self._lock:
            for kind, wp in list(self._slots.items()):
                if wp is None:
                    continue
                if not wp.alive():                     # 自己死掉了（没用过）
                    self._slots[kind] = None
                    dead.append(wp)
                    if not wp.used and wp.age_s() < 60:
                        self._fails[kind] = self._fails.get(kind, 0) + 1
                        self._last_error[kind] = "预热的 claude 进程刚开就退出了：" + (getattr(wp, "stderr_tail", lambda: "")() or "没有输出")
                    respawn.append(kind)
                elif now - self._touched.get(kind, 0.0) > idle:
                    self._slots[kind] = None
                    dead.append(wp)
                    self.stats["killed_idle"] += 1
            recheck = now - self._last_recheck >= self._recheck_every
            if recheck:
                self._last_recheck = now
                live = [k for k, wp in self._slots.items() if wp is not None]
            else:
                live = []
        self._kill_async(dead)
        for k in respawn:
            self._ensure(k)
        for k in live:                                  # 提示词变了（库重载 / 日期 / 配置）→ 换新进程
            self._ensure(k)

    # ---------------------------------------------------------- 状态 / 退出
    def status(self) -> Dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            slots = {}
            for k in KINDS:
                wp = self._slots.get(k)
                slots[k] = {
                    "state": ("ready" if wp is not None and wp.alive() else "starting" if self._spawning.get(k) else "none"),
                    "pid": getattr(wp, "pid", None) if wp is not None else None,
                    "age_s": round(wp.age_s(), 1) if wp is not None else None,
                    "idle_s": round(now - self._touched[k], 1) if k in self._touched else None,
                    "last_error": self._last_error.get(k),
                }
            return {"slots": slots, "active": len(self._active), "idle_timeout_s": self._idle_s(), **self.stats}

    def pids(self) -> List[int]:
        with self._lock:
            procs = [p for p in list(self._slots.values()) + list(self._active) if p is not None]
        return [getattr(p, "pid", None) for p in procs]

    def shutdown(self) -> None:
        """后端退出：关掉所有预热的和正在用的进程（同步，整棵进程树）。"""
        with self._lock:
            self._closed = True
            procs = [p for p in list(self._slots.values()) + list(self._active) if p is not None]
            self._slots.clear()
            self._active.clear()
            self._cond.notify_all()
        for p in procs:
            try:
                p.kill()
            except Exception:  # noqa: BLE001
                pass
