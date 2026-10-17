# -*- coding: utf-8 -*-
"""ClickerService：对外的服务对象（FastAPI 路由只和它打交道）。

线程模型（为什么不直接用 uvicorn 的事件循环）：
  Playwright 要起一个 node 驱动子进程。Windows 上只有 ProactorEventLoop 支持子进程，
  而 uvicorn 开 --reload / 多 worker 时会把循环换成 SelectorEventLoop，Playwright 就起不来。
  所以点击器自己开一个后台线程跑一个 Proactor 循环（clicker-loop），所有 Playwright 操作都在里面，
  FastAPI 侧用 run_coroutine_threadsafe 投递任务、用 wrap_future 等结果。用的是 Playwright async API。
状态读写用一把 threading 锁保护；status() 只读快照，不会碰浏览器。

取消 / 关服：
  判断「任务是不是真的结束了」只看 _TaskCtl.done（协程 finally 里才 set），不看 concurrent Future 的 done()——
  对 run_coroutine_threadsafe 返回的 Future 调 cancel() 会让它立刻变成 done，而 clicker-loop 里的协程可能还在跑。
  取消时 busy 保持 true、state=cancelling，协程真正结束才落到 error（last_error=已取消）；
  宽限期（cancel_grace_s）内没停下 → state=stuck，并自动重置浏览器连接；上一个协程结束之前拒绝一切新任务。
  shutdown() 先停自动模式、再中止并等待单次任务、再断开浏览器、最后清理 loop 里剩下的 Task；被中止的任务落到 state=closed。
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

from ..v2.store import C_HEAT, C_NAME, S_HEAT, S_NAME, with_snapshot
from .bgm import BgmClient, BgmError, cn_name_of
from .browser import DISCONNECTED_MSG, PAGE_CLOSED_MSG, BrowserManager, FlowError, probe_cdp_http, url_matches
from .flows import Request, auto_loop, run_flow
from .locate import Planner, Target
from .models import (AutoInfo, ClickerStatus, DryRunPayload, LocateResult, LogEntry,
                     OncePayload, OnceResp, TargetView, dump)

DEFAULT_HOST_PATTERNS = [
    "anime-character-guessr.netlify.app/multiplayer/",
    "localhost:5173/multiplayer/",
    "127.0.0.1:5173/multiplayer/",
    "ccb.baka.website/multiplayer/",
    "ccbeta.baka.website/multiplayer/",
]

Provider = Callable[[], Tuple[Optional[int], str, Optional[str]]]

# 这些错误重试也没用（要等人 / 等局面变化），单次任务里不重试
_NO_RETRY_CODES = ("not_ready", "game_running", "other_setter", "search_disabled",
                   "cdp_unreachable", "no_page")


@dataclass
class _TaskCtl:
    """一次单次任务 / 验证的控制块：取消、关服都靠它判断「clicker-loop 里的协程是不是真的结束了」。"""
    task_id: str
    done: threading.Event = field(default_factory=threading.Event)   # 协程 finally 里才 set
    task: Optional["asyncio.Task[Any]"] = None      # clicker-loop 里的 Task（协程开始跑以后才有）
    abort: Optional[str] = None       # 被要求中止的原因（「已取消」「服务关闭，任务被中止」…）；None = 没人要求
    abort_at: float = 0.0
    stuck: bool = False               # 中止后超过宽限期还没停下
    aborted: bool = False             # 确实是按中止收尾的（不是在取消生效前自己跑完的）
    result: Optional[LocateResult] = None
    watchdog: Optional["asyncio.Task[Any]"] = None   # 盯着中止的看门狗（留个引用：事件循环只弱引用 Task）


async def _wait_event(ev: threading.Event, seconds: float) -> bool:
    """在事件循环里等一个 threading.Event（轮询，不占线程）。"""
    t0 = time.time()
    while not ev.is_set():
        if time.time() - t0 >= seconds:
            return False
        await asyncio.sleep(0.05)
    return True


@dataclass
class ClickerOptions:
    cdp_host: str = "127.0.0.1"
    cdp_port: int = 9223
    host_patterns: List[str] = field(default_factory=lambda: list(DEFAULT_HOST_PATTERNS))
    bgm_api_base: str = "https://api.bgm.tv"
    max_more_clicks: int = 40           # 「更多」最多点几次（40 次 = 翻到第 210 条）
    prefer_subject_after: int = 3       # 直接搜要点超过 3 次「更多」时，考虑「先搜作品」
    max_paths: int = 5                  # 一次最多尝试几条路径
    search_timeout_s: float = 12.0
    subject_timeout_s: float = 25.0
    confirm_timeout_s: float = 25.0
    # 空闲多久断开 CDP；0 = 一直连着（默认）。一直连着的好处：游戏弹的 alert 会被接住、记日志、自动点确定；
    # 断开期间弹的 alert 没人点，会把那个标签页卡死，下次连接直接超时。
    idle_disconnect_s: float = 0.0
    bring_to_front: bool = True
    retries: int = 2                    # 单次任务遇到可恢复错误时的总尝试次数
    cancel_grace_s: float = 5.0         # 取消后等多久；还没停下就进入 stuck 并自动重置浏览器连接

    @classmethod
    def from_cfg(cls, ac: Dict[str, Any]) -> "ClickerOptions":
        o = cls()
        ac = ac or {}
        o.cdp_host = str(ac.get("cdp_host") or o.cdp_host)
        try:
            o.cdp_port = int(ac.get("cdp_port") or o.cdp_port)
        except Exception:
            pass
        pats = list(ac.get("url_patterns") or [])
        single = ac.get("url_pattern")          # 单条房间页规则（写法同 url_patterns），排在最前面
        if isinstance(single, str) and single.strip():
            pats.insert(0, single.strip())
        host = []
        for pp in pats + DEFAULT_HOST_PATTERNS:
            if pp and pp not in host:
                host.append(pp)
        o.host_patterns = host
        for k in ("bgm_api_base",):
            if ac.get(k):
                setattr(o, k, str(ac[k]))
        for k in ("max_more_clicks", "prefer_subject_after", "max_paths", "retries"):
            if ac.get(k) is not None:
                try:
                    setattr(o, k, int(ac[k]))
                except Exception:
                    pass
        for k in ("search_timeout_s", "subject_timeout_s", "confirm_timeout_s",
                  "idle_disconnect_s", "cancel_grace_s"):
            if ac.get(k) is not None:
                try:
                    setattr(o, k, float(ac[k]))
                except Exception:
                    pass
        if ac.get("bring_to_front") is not None:
            o.bring_to_front = bool(ac["bring_to_front"])
        return o


class _LoopThread:
    def __init__(self) -> None:
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._ready = threading.Event()
        self.thread = threading.Thread(target=self._run, name="clicker-loop", daemon=True)
        self.thread.start()
        self._ready.wait(5)

    def _run(self) -> None:
        loop = asyncio.ProactorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()  # type: ignore[attr-defined]
        asyncio.set_event_loop(loop)
        self.loop = loop
        self._ready.set()
        loop.run_forever()

    def submit(self, coro: Any) -> "concurrent.futures.Future":
        assert self.loop is not None
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def call(self, fn: Callable, *args: Any) -> None:
        assert self.loop is not None
        self.loop.call_soon_threadsafe(fn, *args)

    def stop(self, drain_timeout: float = 3.0) -> int:
        """停 loop：先取消里面还没结束的所有 Task 并等它们收尾（最多 drain_timeout 秒），再停。
        返回到最后还没结束的 Task 个数（-1 = 没能在 loop 里执行清理）。"""
        loop = self.loop
        if loop is None or not self.thread.is_alive():
            return 0

        async def _drain() -> int:
            me = asyncio.current_task()
            pending = [t for t in asyncio.all_tasks() if t is not me and not t.done()]
            for t in pending:
                t.cancel()
            if not pending:
                return 0
            _done, still = await asyncio.wait(pending, timeout=drain_timeout)
            return len(still)

        try:
            left = asyncio.run_coroutine_threadsafe(_drain(), loop).result(timeout=drain_timeout + 2.0)
        except Exception:
            left = -1
        loop.call_soon_threadsafe(loop.stop)
        self.thread.join(timeout=3.0)
        return left


class ClickerService:
    def __init__(self, cfg: Dict[str, Any]):
        self.cfg = cfg or {}
        ac = dict(self.cfg.get("autoclick") or {})
        self.opts = ClickerOptions.from_cfg(ac)
        self._lock = threading.RLock()
        self._logs: Deque[LogEntry] = deque(maxlen=200)
        self._st: Dict[str, Any] = {
            "state": "idle", "busy": False, "task_id": None, "target": None, "strategy_used": None,
            "attempts": 0, "last_error": None, "last_result": None, "page_url": None, "page_role": None,
            "updated_at": time.time(),
        }
        self._auto = AutoInfo()
        self._cdp_cache: Tuple[float, Dict[str, Any]] = (0.0, {"ok": False})
        self.bgm = BgmClient(base=self.opts.bgm_api_base)
        self.planner = Planner(self.bgm, self.log, max_more=self.opts.max_more_clicks,
                               prefer_subject_after=self.opts.prefer_subject_after)
        self.browser = BrowserManager(self.opts.cdp_host, self.opts.cdp_port,
                                      {"host": self.opts.host_patterns}, self.log)
        self._runner = _LoopThread()
        self._op_lock: Optional[asyncio.Lock] = None      # 在 clicker-loop 里懒创建：页面操作互斥
        self._auto_stop: Optional[asyncio.Event] = None
        self._auto_future: Optional[concurrent.futures.Future] = None
        self._auto_task: Optional["asyncio.Task[Any]"] = None
        self._task_future: Optional[concurrent.futures.Future] = None
        self._ctl: Optional[_TaskCtl] = None               # 当前（或最近一次）单次任务 / 验证
        self._closing = False                              # shutdown() 开始后为 True：拒绝一切新任务
        self._provider: Optional[Provider] = None
        self._provider_name = "default"
        self._idle_timer: Optional[asyncio.TimerHandle] = None
        self.log("info", f"点击器就绪：CDP {self.opts.cdp_host}:{self.opts.cdp_port}，"
                         f"房间页匹配 {len(self.opts.host_patterns)} 条规则")

    # ------------------------------------------------------------------ 日志 / 状态
    def log(self, level: str, msg: str) -> None:
        e = LogEntry(ts=time.time(), level=level if level in ("debug", "info", "warn", "error") else "info", msg=str(msg))
        with self._lock:
            self._logs.append(e)
            self._st["updated_at"] = e.ts
        try:
            print(f"[CLICKER][{e.level}] {e.msg}", flush=True)
        except Exception:
            pass

    def set_state(self, state: str, **kw: Any) -> None:
        with self._lock:
            self._st["state"] = state
            self._st.update(kw)
            self._st["updated_at"] = time.time()

    def set_target(self, t: Target) -> None:
        with self._lock:
            self._st["target"] = TargetView(char_id=t.char_id, name=t.name, name_cn=t.name_cn or t.ds_name,
                                            work_hint=t.work_hint)

    def set_page(self, url: Optional[str], role: Optional[str]) -> None:
        with self._lock:
            self._st["page_url"] = url
            self._st["page_role"] = role

    def set_strategy(self, s: str) -> None:
        with self._lock:
            self._st["strategy_used"] = s

    def bump_attempts(self) -> None:
        with self._lock:
            self._st["attempts"] = int(self._st.get("attempts") or 0) + 1

    def auto_wait(self, msg: Optional[str]) -> None:
        with self._lock:
            changed = self._auto.waiting_for != msg
            self._auto.waiting_for = msg
        if changed and msg:
            self.log("info", f"自动模式：{msg}")

    # ------------------------------------------------------------------ 本地数据（出题器数据库）
    def _ds_info_sync(self, cid: int) -> Dict[str, Any]:
        """从出题器数据库取角色的中文名 / 原名 / 登场作品名（热度高的在前）。没库或库里没有 → 空，流程退回 Bangumi 在线查。"""
        def run(snap: Any) -> Dict[str, Any]:
            c = snap.C.get(cid)
            if c is None:
                return {}
            conn = snap.connect()
            try:
                row = conn.execute("SELECT name FROM character WHERE id=?", (cid,)).fetchone()
            finally:
                conn.close()
            works = sorted(((int(snap.S[sid][S_HEAT] or 0), str(snap.S[sid][S_NAME]))
                            for sid, _rel in snap.c_apps.get(cid, []) if sid in snap.S), reverse=True)
            return {"name": c[C_NAME], "name_jp": (row[0] if row and row[0] else None), "heat": c[C_HEAT],
                    "work_names": [n for _, n in works]}
        try:
            return with_snapshot(run)
        except Exception as e:
            self.log("debug", f"读本地库失败（{type(e).__name__}: {e}），只用 Bangumi 在线查")
            return {}

    def _ids_by_name_sync(self, name: str) -> List[int]:
        """出题器数据库里名字（display_name / name / name_cn）完全一致的角色，按热度降序。"""
        try:
            return list(with_snapshot(lambda snap: snap.find_chars_by_name(name)))
        except Exception as e:
            self.log("debug", f"读本地库失败（{type(e).__name__}: {e}），只用 Bangumi 在线查")
            return []

    async def ds_info(self, cid: int) -> Dict[str, Any]:
        return await asyncio.to_thread(self._ds_info_sync, int(cid))

    async def resolve_char_id(self, char_id: Optional[int], char_name: Optional[str],
                              work_hint: Optional[str]) -> Tuple[int, Optional[str]]:
        if char_id is not None:
            return int(char_id), work_hint
        name = (char_name or "").strip()
        if not name:
            raise FlowError("没给角色：char_id 和 char_name 至少要有一个", code="no_target")
        ids = await asyncio.to_thread(self._ids_by_name_sync, name)     # 已按热度降序
        if work_hint and len(ids) > 1:
            info = [(cid, await self.ds_info(cid)) for cid in ids]
            f = [cid for cid, i in info if any(work_hint in n for n in i.get("work_names") or [])]
            if f:
                ids = f
        if len(ids) == 1:
            return int(ids[0]), work_hint
        if len(ids) > 1:
            self.log("warn", f"名字「{name}」在本地库对应 {len(ids)} 个角色 {ids[:6]}，已选热度最高的 id={ids[0]}；"
                             f"建议前端直接传 char_id")
            return int(ids[0]), work_hint
        # 本地库没有：去 Bangumi 搜，只接受名字完全一致且唯一的
        try:
            d = await self.bgm.search_characters(name, 20, 0)
            exact = [c for c in d.get("data") or [] if c.get("name") == name or cn_name_of(c) == name]
        except BgmError:
            exact = []
        if len(exact) == 1:
            self.log("warn", f"本地库没有「{name}」，按 Bangumi 唯一同名结果 id={exact[0]['id']} 处理")
            return int(exact[0]["id"]), work_hint
        raise FlowError(f"没法把名字「{name}」对应到唯一角色（本地库 0 个，Bangumi 同名 {len(exact)} 个），请传 char_id",
                        code="name_unresolved")

    # ------------------------------------------------------------------ 抽题（auto）
    def set_provider(self, fn: Optional[Provider], name: str = "engine") -> None:
        self._provider = fn
        self._provider_name = name if fn else "default"

    async def draw(self, exclude: Optional[set] = None) -> Optional[Tuple[int, str, Optional[str]]]:
        prov = self._provider
        if prov is None:
            return None             # 没有方案就不出题（自动模式从 /v2/autoclick/auto/start 或 /autoclick/auto/start 启动，每轮按方案抽题）
        for _ in range(6):
            try:
                q = await asyncio.to_thread(prov)
            except Exception as e:
                self.log("warn", f"按方案抽题失败：{e}")
                return None
            if not q or q[0] is None:
                continue
            cid, name, hint = int(q[0]), q[1], q[2]
            if exclude and cid in exclude:
                continue
            return cid, name, hint
        return None

    # ------------------------------------------------------------------ 任务执行（在 clicker-loop 里）
    def _ensure_loop_objs(self) -> None:
        if self._op_lock is None:
            self._op_lock = asyncio.Lock()

    async def _exec(self, req: Request, ctl: Optional[_TaskCtl] = None) -> LocateResult:
        """带重试的一次完整流程；统一处理状态与错误。"""
        self._ensure_loop_objs()
        assert self._op_lock is not None
        async with self._op_lock:
            t_exec = time.time()
            self._cancel_idle()
            with self._lock:
                self._st.update({"attempts": 0, "last_error": None, "strategy_used": None})
            res: Optional[LocateResult] = None
            last_exc: Optional[BaseException] = None
            for attempt in range(max(1, self.opts.retries)):
                if ctl is not None and ctl.abort:
                    # 中止请求在两次尝试之间到达（或被下层的清理代码吞掉了）：不再重试，按取消收尾
                    raise asyncio.CancelledError()
                try:
                    res = await run_flow(self, req)
                    last_exc = None
                    break
                except FlowError as e:
                    last_exc = e
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    # Playwright 抛的异常：按异常类型 + 连接状态判断是不是断线（不只看异常文字）；
                    # 断线时 recover() 已经走 browser.reset() 清掉旧连接，重试会重新连
                    kind = await self.browser.recover(e, "操作页面时")
                    if kind == "disconnected":
                        last_exc = FlowError(DISCONNECTED_MSG, code="browser_disconnected", recoverable=True)
                    elif kind == "page_closed":
                        last_exc = FlowError(PAGE_CLOSED_MSG, code="page_closed", recoverable=True)
                    else:
                        last_exc = e
                        break                                  # 其他异常：不重试
                assert isinstance(last_exc, FlowError)
                if last_exc.recoverable and attempt + 1 < self.opts.retries and \
                        last_exc.code not in _NO_RETRY_CODES:
                    self.log("warn", f"第 {attempt + 1} 次尝试失败：{last_exc}；重试")
                    await asyncio.sleep(0.4)
                    continue
                break
            if last_exc is not None or res is None:
                code = getattr(last_exc, "code", "exception")
                msg = str(last_exc) if isinstance(last_exc, FlowError) else \
                    f"{type(last_exc).__name__}: {str(last_exc).splitlines()[0][:200] if str(last_exc) else ''}"
                res =LocateResult(ok=False, dry_run=req.dry_run, mode=req.mode, char_id=req.char_id,  # type: ignore[arg-type]
                                   clicked=req.clicked, error=msg, summary=f"失败：{msg}",
                                   elapsed_ms=int((time.time() - t_exec) * 1000))
                self.log("error", f"失败（{code}）：{msg}")
                self.set_state("error", last_error=msg, last_result=res)
            else:
                if res.ok:
                    self.log("info", ("验证完成：" if req.dry_run else "完成：") + (res.summary or ""))
                    self.set_state("done", last_result=res)
                else:
                    self.log("error", f"失败：{res.error}")
                    self.set_state("error", last_error=res.error, last_result=res)
            self._schedule_idle()
            return res

    async def _task(self, ctl: _TaskCtl, req: Request) -> LocateResult:
        """单次任务 / 验证的协程。busy 只在这里（协程真正结束时）变回 False。"""
        ctl.task = asyncio.current_task()
        res: Optional[LocateResult] = None
        try:
            if ctl.abort:                         # 刚提交就被取消了（协程还没开始跑）
                raise asyncio.CancelledError()
            res = await self._exec(req, ctl)
            return res
        except asyncio.CancelledError:
            # 被 /autoclick/cancel、请求方断开或关服中止：落到明确的最终状态
            # （不然 state 会停在 typing / selecting 这类中间步骤）
            res = self._aborted_result(ctl, req)
            return res
        finally:
            with self._lock:
                ctl.result = res
                if self._ctl is ctl:
                    self._st["busy"] = False
                    if not ctl.aborted and self._st.get("state") in ("cancelling", "stuck"):
                        # 取消请求到得太晚：任务已经自己跑完了，状态按真实结果落地
                        self._st["state"] = "done" if (res is not None and res.ok) else "error"
                    self._st["updated_at"] = time.time()
                ctl.done.set()

    def _aborted_result(self, ctl: _TaskCtl, req: Request) -> LocateResult:
        reason = ctl.abort or "任务被中止"
        if ctl.stuck:
            reason += "（取消后卡住了一段时间，已重置浏览器连接）"
        res =LocateResult(ok=False, dry_run=req.dry_run, mode=req.mode, char_id=req.char_id,  # type: ignore[arg-type]
                           clicked=req.clicked, error=reason, summary=f"失败：{reason}")
        ctl.aborted = True
        self.log("warn", f"任务 {ctl.task_id} 已停下：{reason}")
        self.set_state("closed" if self._closing else "error", last_error=reason, last_result=res)
        if not self._closing:
            self._schedule_idle()
        return res

    async def run_auto_round(self, req: Request) -> LocateResult:
        """自动模式的一轮。返回这一轮的 LocateResult。"""
        try:
            res = await self._exec(req)
        except asyncio.CancelledError:
            # 自动模式被强制停止 / 关服：这一轮也落到明确的状态再往外抛（不让 state 停在中间步骤）
            reason = "服务关闭，自动模式被中止" if self._closing else "自动模式被强制停止（这一轮没做完）"
            res = LocateResult(ok=False, mode=req.mode, char_id=req.char_id, clicked=req.clicked,  # type: ignore[arg-type]
                               error=reason, summary=f"失败：{reason}")
            self.set_state("closed" if self._closing else "error", last_error=reason, last_result=res)
            raise
        with self._lock:
            if res.ok and not res.dry_run:
                self._auto.round += 1
                self._auto.last_round_at = time.time()
                self._auto.last_char_id = res.char_id
                tv = self._st.get("target")
                self._auto.last_char_name = (tv.name_cn or tv.name) if tv else None
            else:
                self._auto.failed += 1
        return res

    # ------------------------------------------------------------------ 空闲断开
    def _cancel_idle(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _schedule_idle(self) -> None:
        if self.opts.idle_disconnect_s <= 0 or self._auto.running:
            return
        loop = self._runner.loop
        assert loop is not None
        self._cancel_idle()
        self._idle_timer = loop.call_later(self.opts.idle_disconnect_s, self._idle_fire)

    def _idle_fire(self) -> None:
        self._idle_timer = None
        with self._lock:
            busy = bool(self._st.get("busy"))
        if busy or self._auto.running:
            return
        asyncio.ensure_future(self.browser.disconnect(f"空闲 {self.opts.idle_disconnect_s:.0f}s"))

    # ------------------------------------------------------------------ 对外 API
    def _busy_message_locked(self) -> str:
        st = self._st.get("state")
        if st == "cancelling":
            return "上一个任务正在取消，等它真正停下再发（通常不到 1 秒）"
        if st == "stuck":
            return ("上一个任务取消后卡住了：后端已自动重置浏览器连接，等它停下再发"
                    "（可以再调一次取消，会再重置一次；还不行就重启后端）")
        return "上一个任务还没结束"

    def once(self, payload: OncePayload) -> OnceResp:
        with self._lock:
            if self._closing:
                return OnceResp(task_id="", accepted=False, message="点击器已关闭（后端正在退出）",
                                state=self._st.get("state"))
            if self._st.get("busy"):
                return OnceResp(task_id=str(self._st.get("task_id")), accepted=False,
                                message=self._busy_message_locked(), state=self._st.get("state"))
            if self._auto.running:
                return OnceResp(task_id="", accepted=False, message="自动模式正在运行，先停止自动模式再单次发送",
                                state=self._st.get("state"))
            task_id = f"task-{int(time.time() * 1000)}"
            ctl = _TaskCtl(task_id=task_id)
            self._ctl = ctl
            self._st.update({"busy": True, "task_id": task_id, "state": "locating", "target": None,
                             "last_error": None})
        req = Request(mode=payload.mode, char_id=payload.char_id, char_name=payload.char_name,
                      work_hint=payload.work_name_hint, dry_run=payload.dry_run, confirm=payload.confirm,
                      open_popup=payload.open_popup)
        self.log("info", f"收到任务 {task_id}：出题"
                         f"{'（仅验证）' if payload.dry_run else ''} char_id={payload.char_id} name={payload.char_name}")
        self._task_future = self._runner.submit(self._task(ctl, req))
        return OnceResp(task_id=task_id, accepted=True, state="locating")

    async def dry_run(self, payload: DryRunPayload) -> LocateResult:
        with self._lock:
            if self._closing:
                return LocateResult(ok=False, dry_run=True, mode=payload.mode, char_id=payload.char_id,
                                    error="点击器已关闭（后端正在退出）")
            if self._st.get("busy"):
                return LocateResult(ok=False, dry_run=True, mode=payload.mode, char_id=payload.char_id,
                                    error=self._busy_message_locked() + "，稍后再验证")
            task_id = f"dry-{int(time.time() * 1000)}"
            ctl = _TaskCtl(task_id=task_id)
            self._ctl = ctl                  # 让 /autoclick/cancel 也能取消验证
            self._st.update({"busy": True, "task_id": task_id, "state": "locating", "target": None})
        req = Request(mode=payload.mode, char_id=payload.char_id, char_name=payload.char_name,
                      work_hint=payload.work_name_hint, dry_run=True, in_page=payload.in_page)
        fut = self._runner.submit(self._task(ctl, req))
        self._task_future = fut
        try:
            # shield：请求方断开时不要顺着 Future 链去 cancel（那会让 Future 提前变成 done），改走下面的正式中止
            return await asyncio.shield(asyncio.wrap_future(fut))
        except (concurrent.futures.CancelledError, asyncio.CancelledError):
            # Python 3.10 里这两个 CancelledError 不是同一个类。协程被中止时会正常返回「已取消」的结果，
            # Future 本身只有在关服清理（协程还没开始就被取消）时才会是 cancelled
            if fut.cancelled():
                return LocateResult(ok=False, dry_run=True, mode=payload.mode, char_id=payload.char_id,
                                    error=ctl.abort or "已取消")
            # 请求方断开了：把验证也停掉（别让它继续在页面里打字），然后照常抛出
            self._request_abort(ctl, "请求方已断开，验证被中止")
            raise

    def _request_abort(self, ctl: _TaskCtl, reason: str) -> bool:
        """请求中止一个单次任务 / 验证（任何线程都能调）。不改 busy：busy 要等协程真正结束才变回 False。
        返回 True = 这是第一次请求（已经发出取消、起了看门狗）。"""
        with self._lock:
            if ctl.done.is_set() or ctl.abort is not None:
                return False
            ctl.abort = reason
            ctl.abort_at = time.time()
            if self._ctl is ctl and self._st.get("busy") and not self._closing:
                self._st.update({"state": "cancelling", "updated_at": time.time()})
        self.log("warn", f"正在中止任务 {ctl.task_id}（{reason}），等它真正停下…")
        self._runner.call(self._abort_in_loop, ctl)
        return True

    def _abort_in_loop(self, ctl: _TaskCtl) -> None:
        """（在 clicker-loop 里）取消协程，并起一个看门狗盯着它真正结束。
        协程还没开始跑的话，它一开始就会看到 ctl.abort 并直接收尾。"""
        t = ctl.task
        if t is not None and not t.done():
            t.cancel()
        ctl.watchdog = asyncio.ensure_future(self._abort_watchdog(ctl))

    async def _abort_watchdog(self, ctl: _TaskCtl) -> None:
        """宽限期内停下就结束；超时进入 stuck，自动重置浏览器连接（断开 CDP、重启 Playwright 驱动）：
        卡在 Playwright 调用里的旧协程会因此立刻收到「连接已关闭」而结束。"""
        grace = max(0.2, float(self.opts.cancel_grace_s))
        if await _wait_event(ctl.done, grace):
            return
        with self._lock:
            if ctl.done.is_set():
                return
            ctl.stuck = True
            if self._ctl is ctl and not self._closing:
                self._st.update({"state": "stuck", "updated_at": time.time(),
                                 "last_error": f"取消后 {grace:.0f} 秒任务还没停下（多半卡在没响应的页面上），正在重置浏览器连接"})
        self.log("error", f"任务 {ctl.task_id} 中止后 {grace:.0f} 秒还没停下：重置浏览器连接，让它卡住的调用立刻失败")
        try:
            await self.browser.reset(f"任务 {ctl.task_id} 取消后卡住", hard=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.log("warn", f"重置浏览器连接时出错：{type(e).__name__}: {e}")
        if await _wait_event(ctl.done, grace):
            self.log("info", f"卡住的任务 {ctl.task_id} 已停下")
            return
        with self._lock:
            if not ctl.done.is_set() and self._ctl is ctl and not self._closing:
                self._st["last_error"] = ("取消后任务卡住，重置浏览器连接后仍没停下：在它停下之前不接新任务；"
                                         "可以再调一次取消（会再重置一次连接），还不行就重启后端")
        self.log("error", f"任务 {ctl.task_id} 重置连接后仍没停下；在它停下之前拒绝新任务")

    def cancel(self) -> str:
        """请求取消当前的单次任务 / 验证（不阻塞）。返回：
          no_task    —— 没有在跑的任务
          cancelling —— 已发出取消，任务还没真正停下（busy 仍是 true，state=cancelling）
          stuck      —— 取消后超过宽限期还没停下（已自动重置浏览器连接；再调一次会再重置一次）
        不能立刻把 busy 改成 false：clicker-loop 里的协程可能还在跑，下一个任务会和它交叉。"""
        with self._lock:
            ctl = self._ctl
            if ctl is None or ctl.done.is_set() or not self._st.get("busy"):
                return "no_task"
        if self._request_abort(ctl, "已取消"):
            return "cancelling"
        if ctl.done.is_set():
            return "no_task"
        if ctl.stuck:
            self.log("warn", f"任务 {ctl.task_id} 仍卡着：再重置一次浏览器连接")
            self._runner.submit(self.browser.reset(f"再次取消卡住的任务 {ctl.task_id}", hard=True))
            return "stuck"
        return "cancelling"

    async def cancel_async(self, wait_s: float = 2.0) -> str:
        """/autoclick/cancel 用：发出取消后最多等 wait_s 秒看它停没停（异步等，不卡 FastAPI 的事件循环）。
        cancelled = 任务已经按取消收尾（state=error，last_error=已取消）；其余取值同 cancel()。"""
        r = self.cancel()
        ctl = self._ctl
        if r == "no_task" or ctl is None:
            return "no_task"
        await _wait_event(ctl.done, wait_s)
        if ctl.done.is_set():
            return "cancelled" if ctl.aborted else "no_task"    # no_task：取消生效前任务已经自己跑完了
        return "stuck" if ctl.stuck else "cancelling"

    def start_auto(self, mode: str = "host", provider: Optional[Provider] = None,
                   provider_name: str = "engine") -> str:
        mode = (mode or "host").lower()
        if mode != "host":
            raise ValueError(f"mode 只能是 host（房主出题），收到 {mode}")
        if self._auto_future is not None and not self._auto_future.done():
            return "auto_already_running"
        with self._lock:
            if self._closing:
                raise RuntimeError("点击器已关闭（后端正在退出）")
            if self._st.get("busy"):
                st = self._st.get("state")
                raise RuntimeError(self._busy_message_locked() if st in ("cancelling", "stuck")
                                   else "单次任务还没结束，稍后再启动自动模式")
        if provider is not None:
            self.set_provider(provider, provider_name)
        with self._lock:
            self._auto = AutoInfo(running=True, mode=mode, started_at=time.time(),  # type: ignore[arg-type]
                                  provider=self._provider_name)
        # 停止标志在这里建（不在协程里建）：stop_auto 在协程开始跑之前调用也不会丢
        stop_ev = asyncio.Event()
        self._auto_stop = stop_ev

        async def _run() -> None:
            self._auto_task = asyncio.current_task()
            self._ensure_loop_objs()
            self._cancel_idle()
            try:
                await auto_loop(self, mode, stop_ev)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                self.log("error", f"自动模式异常退出：{type(e).__name__}: {e}")
                with self._lock:
                    self._auto.stop_reason = f"异常：{e}"
            finally:
                with self._lock:
                    self._auto.running = False
                    self._auto.waiting_for = None
                    if not self._auto.stop_reason:
                        self._auto.stop_reason = "手动停止"
                self._schedule_idle()

        self._auto_future = self._runner.submit(_run())
        return "auto_started"

    def stop_auto(self, wait_s: float = 8.0) -> str:
        f = self._auto_future
        if f is None or f.done():
            return "auto_not_running"
        if self._auto_stop is not None:
            self._runner.call(self._auto_stop.set)
        try:
            f.result(timeout=wait_s)
        except concurrent.futures.TimeoutError:
            # 当前这一轮没在时限内收尾：在 clicker-loop 里直接取消协程，再等它真正结束
            # （不 cancel Future 本身：那样 Future 会立刻变成 done，看起来停了其实协程还在跑）
            self._runner.call(self._cancel_auto_in_loop)
            try:
                f.result(timeout=5.0)
            except Exception:
                pass
            self.log("warn", "自动模式没在时限内停下，已强制取消" + ("" if f.done() else "（5 秒后协程仍在收尾）"))
        except Exception:
            pass
        return "auto_stopped"

    def _cancel_auto_in_loop(self) -> None:
        t = self._auto_task
        if t is not None and not t.done():
            t.cancel()

    async def stop_auto_async(self) -> str:
        return await asyncio.to_thread(self.stop_auto)

    async def probe_async(self) -> Dict[str, Any]:
        info = await asyncio.to_thread(probe_cdp_http, self.opts.cdp_host, self.opts.cdp_port)
        self._cdp_cache = (time.time(), info)
        pats = self.opts.host_patterns
        info["matched_pages"] = [p for p in info.get("pages") or [] if url_matches(p.get("url") or "", pats)]
        info["connected"] = self.browser.connected
        info["cdp"] = f"{self.opts.cdp_host}:{self.opts.cdp_port}"
        return info

    def status(self) -> Dict[str, Any]:
        with self._lock:
            logs = list(self._logs)
            st = dict(self._st)
            auto = self._auto.model_copy()
        cdp_ok = bool(self._cdp_cache[1].get("ok"))
        auto_running = bool(self._auto_future is not None and not self._auto_future.done())
        auto.running = auto_running
        s = ClickerStatus(
            connected=self.browser.connected, browser_ok=cdp_ok or self.browser.connected,
            cdp_port=self.opts.cdp_port, page_url=st.get("page_url"), page_role=st.get("page_role"),
            state=st.get("state") or "idle", busy=bool(st.get("busy")), task_id=st.get("task_id"),
            target=st.get("target"), strategy_used=st.get("strategy_used"), attempts=int(st.get("attempts") or 0),
            last_error=st.get("last_error"), last_result=st.get("last_result"), logs=logs, auto=auto,
            updated_at=float(st.get("updated_at") or 0),
            running=bool(st.get("busy")), manual_running=bool(st.get("busy")), auto_running=auto_running,
            log_lines=[f"{time.strftime('%H:%M:%S', time.localtime(e.ts))} [{e.level}] {e.msg}" for e in logs],
        )
        return dump(s)

    async def status_async(self) -> Dict[str, Any]:
        if time.time() - self._cdp_cache[0] > 2.0:
            info = await asyncio.to_thread(probe_cdp_http, self.opts.cdp_host, self.opts.cdp_port, 0.8)
            self._cdp_cache = (time.time(), info)
        return self.status()

    def shutdown(self) -> None:
        """关服（uvicorn 退出时由 app.py 的 shutdown 钩子在工作线程里调用）。顺序：
          1. 标记关闭：之后的 once / dry_run / auto 一律拒绝；
          2. 停自动模式（先设停止标志等 3 秒，没停再取消协程，并等它真正结束）；
          3. 中止单次任务 / 验证，并等协程真正结束（超过宽限期看门狗会重置浏览器连接）；
          4. 断开 Chrome、停 Playwright 驱动；
          5. 取消 clicker-loop 里剩下的所有 Task 并等它们收尾，最后停 loop。
        被中止的任务统一落到 state=closed，last_error / last_result.error =「服务关闭，任务被中止」。"""
        with self._lock:
            if self._closing:
                return
            self._closing = True
            auto_running = self._auto_future is not None and not self._auto_future.done()
            if auto_running:
                self._auto.stop_reason = "服务关闭"
        self.log("info", "点击器正在关闭…")
        if auto_running:
            try:
                self.stop_auto(wait_s=3.0)
            except Exception as e:
                self.log("warn", f"关闭时停自动模式出错：{type(e).__name__}: {e}")
        ctl = self._ctl
        if ctl is not None and not ctl.done.is_set():
            self._request_abort(ctl, "服务关闭，任务被中止")
            if not ctl.done.wait(timeout=max(0.2, float(self.opts.cancel_grace_s)) + 5.0):
                self.log("error", f"任务 {ctl.task_id} 在关闭时没能停下，继续关闭（浏览器连接会被强制断开）")
        try:
            self._runner.submit(self.browser.shutdown()).result(timeout=10)
        except Exception as e:
            self.log("warn", f"断开 Chrome / 停 Playwright 驱动时出错：{type(e).__name__}: {e}")
        left = self._runner.stop(drain_timeout=3.0)
        with self._lock:
            self._st.update({"state": "closed", "busy": False, "updated_at": time.time()})
            if ctl is not None and not ctl.done.is_set():
                self._st["last_error"] = "服务关闭，任务被中止（协程没来得及收尾）"
        extra = "" if left == 0 else (f"（{left} 个后台任务到最后也没停下）" if left > 0 else "（没能清理 loop 里剩下的任务）")
        self.log("info", "点击器已关闭" + extra)
