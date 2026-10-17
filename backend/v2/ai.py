# -*- coding: utf-8 -*-
"""AI：一句话填工作台（/v2/ai/fill）、一句话问数据（/v2/ai/ask）。

AI 有两条路，请求里的 engine 选用哪条（不传就用 v2.ai.default_engine，默认 "api"）：

① API（engine = "api"，默认）：后端直接调用服务商的接口。接口地址、模型、API key 在 v2.ai.api，网页「设置 → AI」里填；
  按服务商的价格计费。请求和流式解析见 aiapi.py；没有预热，每次请求现连。
② 本机命令行（engine = "claude" / "codex"）：调用本机已登录订阅的 `claude` CLI / `codex` CLI。这条路只走订阅登录：
- **每次开 claude 进程之前**检查通道：进程环境变量和 ~/.claude/settings.json 的 env 里的 ANTHROPIC_BASE_URL 不是官方域名 → 拒绝；
  另外（更严格）：用了 Bedrock / Vertex / apiKeyHelper / settings 里配了 API key、或 `claude auth status` 显示不是 claude.ai 订阅登录 → 拒绝。
  预热好的进程被拿去用之前，再快速查一次（不跑 auth status）。
- 调用方式（claude）：`claude -p --input-format stream-json --output-format stream-json --tools "" --no-session-persistence
  --settings {"disableAllHooks": true} --strict-mcp-config --safe-mode --effort <v2.ai.claude_effort>`，在空临时目录里跑。
  进程提前开好、停在 stdin 上等（预热进程池，见 aipool.py）；一个进程只服务一次请求。codex 每次现开（没有预热）。

两条路共用的做法：
- 速度相关的做法：
  - 填工作台**只调一次 AI**：AI 输出对当前方案的 JSON Patch（只写要改的部分）；标签名不存在时后端自己换成库里的写法
    （唯一且足够接近才换），拿不准的返回 `tag_fixes` 让前端给替换按钮；人数为 0 / 太多时的建议只用后端模板句。
  - 问数据：AI 先写说明、再写 SQL（带标记的纯文本，方便边写边显示）；写完后端**立刻自动跑** SQL。
    SQL 报错时不自动让 AI 改：返回错误 + `fixable: true`，由用户点「让 AI 改」（/v2/ai/ask/fix）。
  - 流式接口 /v2/ai/fill/stream、/v2/ai/ask/stream、/v2/ai/ask/fix/stream（SSE）；对应的非流式接口 /v2/ai/fill、/v2/ai/ask、/v2/ai/ask/fix 也可用（内部同一套代码）。
- AI 的输出必须能解析成方案修改 / 一条 SQL，否则丢弃报错；人数由后端算。
- 测试时把 RUNNER 换成假函数（不调真 AI）。
"""
from __future__ import annotations

import asyncio
import atexit
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import unicodedata
import uuid
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

from pydantic import BaseModel

from . import aipool, engine, jsonpatch, schema_doc, settings, sqlsafe
from .sentence import describe_changes
from .spec import SpecError, SpecV2, default_spec, parse_spec, spec_to_dict
from .storage import LISTS
from .store import HUB, NoDatabase, with_snapshot

ENGINES = ("api", "claude", "codex")
CLI_LABELS = {"claude": "Claude（本机命令行）", "codex": "Codex（本机命令行）"}
WARM_READY_S = 6.0                     # claude 进程开出来大约要这么久才能开始干活（通常约 6 秒，取决于机器）
_SEM = threading.Semaphore(2)          # 同时最多跑 2 个 AI 请求（预热着、没在用的进程不算）
HUGE_TOTAL = 5000


class AIError(Exception):
    def __init__(self, message: str, code: str = "ai_error"):
        self.message = message
        self.code = code
        super().__init__(message)


# ================================================================ 通道检查
def _home() -> str:
    return os.path.expanduser("~")


def _claude_user_settings() -> Dict[str, Any]:
    p = os.path.join(_home(), ".claude", "settings.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _is_official(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "anthropic.com" or host.endswith(".anthropic.com")


def _truthy(v: Any) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


_AUTH_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def _claude_auth_status() -> Optional[Dict[str, Any]]:
    """`claude auth status`（缓存 5 分钟）。拿不到就返回 None。"""
    hit = _AUTH_CACHE.get("claude")
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    cmd = claude_cmd()
    if not cmd:
        return None
    try:
        p = subprocess.run(cmd + ["auth", "status"], capture_output=True, timeout=30, env=child_env(),
                           cwd=tempfile.gettempdir(), creationflags=_NO_WINDOW)
        d = json.loads(p.stdout.decode("utf-8", "replace"))
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    d = {k: d.get(k) for k in ("loggedIn", "authMethod", "apiProvider", "subscriptionType")}
    _AUTH_CACHE["claude"] = (time.time(), d)
    return d


def check_claude_channel(run_auth_status: bool = True) -> Tuple[bool, str]:
    user_settings = _claude_user_settings()
    senv = user_settings.get("env") or {}
    for where, env in (("进程环境变量", os.environ), ("~/.claude/settings.json 的 env", senv)):
        url = env.get("ANTHROPIC_BASE_URL")
        if url and not _is_official(url):
            return False, (f"{where}里的 ANTHROPIC_BASE_URL = {url}，不是 Anthropic 官方域名"
                           "（当前命令行似乎走了按量计费的通道，请换成订阅登录），拒绝调用。切回官方后再试。")
        for k in ("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"):
            if _truthy(env.get(k)):
                return False, f"{where}里设置了 {k}（第三方按量计费通道），拒绝调用。"
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        if senv.get(k):
            return False, f"~/.claude/settings.json 的 env 里配了 {k}（按量计费的 API key），拒绝调用。"
    if user_settings.get("apiKeyHelper"):
        return False, "~/.claude/settings.json 配了 apiKeyHelper（按量计费的 API key），拒绝调用。"
    if run_auth_status:
        st = _claude_auth_status()
        if st is not None:
            if not st.get("loggedIn"):
                return False, "claude CLI 没有登录（在终端里运行 claude 登录订阅账号）。"
            if st.get("authMethod") != "claude.ai":
                return False, f"claude CLI 的登录方式是 {st.get('authMethod')}，不是 claude.ai 订阅，拒绝调用。"
            return True, f"官方订阅（{st.get('subscriptionType') or 'claude.ai'}）"
        return True, "通道检查通过（没拿到 claude auth status，只检查了 ANTHROPIC_BASE_URL）"
    return True, "通道检查通过"


def check_codex_channel() -> Tuple[bool, str]:
    home = os.environ.get("CODEX_HOME") or os.path.join(_home(), ".codex")
    p = os.path.join(home, "auth.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return False, "codex 没有登录（找不到 ~/.codex/auth.json）。"
    mode = d.get("auth_mode")
    if mode == "chatgpt" or (d.get("tokens") and not d.get("OPENAI_API_KEY")):
        return True, "ChatGPT 订阅登录"
    return False, f"codex 的登录方式是 {mode or 'API key'}（按量计费），拒绝调用。"


# ================================================================ 可执行文件 / 环境
def _cfg_cmd(key: str) -> Optional[List[str]]:
    v = settings.ai_config().get(key)
    if not v:
        return None
    return list(v) if isinstance(v, list) else [str(v)]


def _cmd_exists(cmd: List[str]) -> bool:
    """配置里写的命令得真的存在（PATH 里找得到，或是一个现成的文件）；写错了、被删了都不算可用，不会去启动它。"""
    exe = str(cmd[0]) if cmd else ""
    return bool(exe) and bool(shutil.which(exe) or os.path.isfile(exe))


def claude_cmd() -> Optional[List[str]]:
    c = _cfg_cmd("claude_cmd")
    if c:
        return c if _cmd_exists(c) else None
    w = shutil.which("claude")
    if not w:
        return None
    if w.lower().endswith((".cmd", ".bat")):
        exe = os.path.join(os.path.dirname(w), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
        return [exe] if os.path.isfile(exe) else None
    return [w]


def codex_cmd() -> Optional[List[str]]:
    c = _cfg_cmd("codex_cmd")
    if c:
        return c if _cmd_exists(c) else None
    w = shutil.which("codex")
    if not w:
        return None
    if w.lower().endswith((".cmd", ".bat")):
        js = os.path.join(os.path.dirname(w), "node_modules", "@openai", "codex", "bin", "codex.js")
        node = shutil.which("node")
        return [node, js] if (node and os.path.isfile(js)) else None
    return [w]


# Windows：后端没有控制台窗口时（例如用 pythonw 启动），子进程也不弹黑框
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

_SCRUB_PREFIX = ("CLAUDE", "CODEX_COMPANION", "CODEX_THREAD", "CODEX_SANDBOX")
_SCRUB_KEYS = {"AI_AGENT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL",
               "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "AZURE_OPENAI_API_KEY"}


def child_env() -> Dict[str, str]:
    """子进程环境：去掉 Claude Code 会话相关变量（不然子进程会以为自己是嵌套会话）和各种 API key（只许走订阅登录）。"""
    env = {k: v for k, v in os.environ.items() if not k.startswith(_SCRUB_PREFIX) and k not in _SCRUB_KEYS}
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def claude_effort() -> Optional[str]:
    """v2.ai.claude_effort（默认 low）；写 null / "default" 表示不传 --effort（跟随 ~/.claude/settings.json 的 effortLevel）。"""
    v = settings.ai_config().get("claude_effort")
    if v is None:
        return None
    v = str(v).strip().lower()
    return None if v in ("", "default", "none") else v


def claude_model() -> str:
    return str(settings.ai_config().get("claude_model") or "sonnet")


# ================================================================ 一次 AI 请求（可流式、可取消）
class AiReply:
    __slots__ = ("text", "warm", "first_token_ms", "total_ms", "output_tokens", "engine")

    def __init__(self, text: str, warm: bool = False, first_token_ms: Optional[int] = None,
                 total_ms: Optional[int] = None, output_tokens: Optional[int] = None, engine: str = "claude"):
        self.text = text
        self.warm = warm
        self.first_token_ms = first_token_ms
        self.total_ms = total_ms
        self.output_tokens = output_tokens
        self.engine = engine


class AiJob:
    """一次 fill / ask 请求。emit(event, data) 把进度（status / delta）推给 SSE；cancel() 杀掉正在用的进程、断开正在用的 API 连接。"""

    def __init__(self, kind: str, emit: Optional[Callable[[str, Any], None]] = None, job_id: Optional[str] = None):
        self.kind = kind
        self.id = (str(job_id)[:64] if job_id else uuid.uuid4().hex[:12])
        self.t0 = time.perf_counter()
        self._emit = emit
        self.cancelled = threading.Event()
        self.first_token_ms: Optional[int] = None
        self.ai_done_ms: Optional[int] = None
        self.text_parts: List[str] = []
        self.warm: Optional[bool] = None
        self.warm_age_s: Optional[float] = None       # 用的预热进程开了多久（刚开几秒的进程还在启动）
        self.output_tokens: Optional[int] = None
        self.done = False
        self._proc: Any = None
        self._lock = threading.Lock()
        self._thinking = False

    def ms(self) -> int:
        return round((time.perf_counter() - self.t0) * 1000)

    def emit(self, event: str, data: Any) -> None:
        if self._emit is None:
            return
        try:
            self._emit(event, data)
        except Exception:  # noqa: BLE001  推送失败（连接已断）不影响计算
            pass

    def status(self, stage: str, message: str, **extra) -> None:
        self.emit("status", {"stage": stage, "message": message, "ms": self.ms(), **extra})

    def delta(self, text: str) -> None:
        if self.first_token_ms is None:
            self.first_token_ms = self.ms()
            self.status("writing", "AI 在写")
        self.text_parts.append(text)
        self.emit("delta", {"text": text})

    def thinking(self) -> None:
        if not self._thinking and self.first_token_ms is None:
            self._thinking = True
            self.status("thinking", "AI 在想")

    def attach(self, proc: Any) -> None:
        with self._lock:
            self._proc = proc
            dead = self.cancelled.is_set()
        if dead:
            proc.kill()

    def detach(self) -> None:
        with self._lock:
            self._proc = None

    def cancel(self) -> None:
        self.cancelled.set()
        with self._lock:
            p = self._proc
        if p is not None:
            try:
                p.kill()
            except Exception:  # noqa: BLE001
                pass

    def timing(self) -> Dict[str, Any]:
        return {"ai_first_token_ms": self.first_token_ms, "ai_total_ms": self.ai_done_ms, "warm": self.warm,
                "warm_age_s": self.warm_age_s, "ai_output_tokens": self.output_tokens}


_JOBS: Dict[str, AiJob] = {}
_JOBS_LOCK = threading.Lock()


def _register(job: AiJob) -> None:
    with _JOBS_LOCK:
        _JOBS[job.id] = job


def _unregister(job: AiJob) -> None:
    with _JOBS_LOCK:
        if _JOBS.get(job.id) is job:
            _JOBS.pop(job.id, None)


def cancel_job(job_id: str) -> bool:
    """前端点「取消」：杀掉这次请求正在用的 claude / codex 进程（预热池会在后台补开新的），或断开 API 连接。"""
    with _JOBS_LOCK:
        job = _JOBS.get(str(job_id))
    if job is None:
        return False
    job.cancel()
    return True


# ================================================================ 预热进程池（只对 claude）
def _pool_key(system: str) -> str:
    return aipool.Pool.key_for(claude_model(), claude_effort(), tuple(claude_cmd() or ()), system)


def _spawn_claude(kind: str, key: str, system: str) -> aipool.WarmProc:
    cmd = claude_cmd()
    if not cmd:
        raise aipool.PoolError("找不到 claude 命令行", code="unavailable")
    return aipool.WarmProc(kind, key, cmd, system, model=claude_model(), effort=claude_effort(), env=child_env(),
                           creationflags=_NO_WINDOW)


def system_for(kind: str) -> str:
    if kind == "fill":
        return fill_system()
    return with_snapshot(ask_system_cached)


def _pool_prompt(kind: str) -> Tuple[str, str]:
    s = system_for(kind)
    return s, _pool_key(s)


def _truthy_default(v: Any, default: bool) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    return _truthy(v)


def _pool_enabled() -> bool:
    cfg = settings.ai_config()
    if not _truthy_default(cfg.get("warm_enabled"), True):
        return False
    return RUNNER is run_engine and bool(claude_cmd())


def _idle_s() -> float:
    try:
        return float(settings.ai_config().get("warm_idle_s") or 600)
    except (TypeError, ValueError):
        return 600.0


POOL = aipool.Pool(spawn=_spawn_claude, prompt_for=_pool_prompt,
                   channel_check=lambda full: check_claude_channel(run_auth_status=full),
                   enabled=_pool_enabled, idle_s=_idle_s)
atexit.register(POOL.shutdown)          # 兜底（正常退出走 router 的 shutdown 事件；被强杀时靠 Windows 作业对象）


def warm(kinds: Iterable[str], engine_id: Optional[str] = None) -> Dict[str, Any]:
    """前端打开工作台 / 问数据页时调（POST /v2/ai/warm）。不阻塞：进程在后台开。"""
    cfg = settings.ai_config()
    eid = engine_id or cfg.get("default_engine") or "api"
    ks = [k for k in (kinds or []) if k in aipool.KINDS]
    if eid == "api":
        return {"ok": True, "warming": [], "note": "API 不需要预热", "pool": POOL.status()}
    if eid != "claude":
        return {"ok": True, "warming": [], "note": "codex 没有预热（每次现开，较慢）", "pool": POOL.status()}
    if not _pool_enabled():
        return {"ok": True, "warming": [], "note": "预热关着（v2.ai.warm_enabled）或找不到 claude", "pool": POOL.status()}
    POOL.warm(ks)
    return {"ok": True, "warming": ks, "pool": POOL.status()}


def shutdown_pool() -> None:
    """后端退出：关掉所有预热的 / 正在用的 claude 进程，取消正在跑的请求。"""
    POOL.shutdown()
    with _JOBS_LOCK:
        jobs = list(_JOBS.values())
    for j in jobs:
        j.cancel()


# ================================================================ 调用
_CODEX_DISABLE = ["apps", "browser_use", "browser_use_external", "code_mode_host", "computer_use", "goals", "hooks",
                  "image_generation", "in_app_browser", "multi_agent", "plugins", "shell_snapshot", "shell_tool",
                  "skill_search", "sleep_tool", "tool_suggest", "unified_exec", "view_image", "workspace_dependencies",
                  "remote_plugin", "skill_mcp_dependency_install", "tool_call_mcp_elicitation"]


class _ProcHandle:
    """给 AiJob.attach 用：cancel 时杀整棵进程树。"""

    def __init__(self, proc: subprocess.Popen, pjob: Any = None):
        self.proc = proc
        self.pjob = pjob

    def kill(self) -> None:
        aipool.kill_tree(self.proc, self.pjob)


def _run(args: List[str], stdin_text: str, cwd: str, timeout: float, job: Optional[AiJob] = None) -> Tuple[int, str, str]:
    """起一个子进程、喂 stdin、等它结束；超时 / 取消时杀整棵进程树。"""
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
                            env=child_env(), creationflags=_NO_WINDOW)
    # 和 claude 预热进程一样放进 Windows 作业对象：后端不管怎么退出（包括被 taskkill /F 强杀），codex 整棵进程树都跟着结束
    pjob = aipool._Job.for_process(proc)          # noqa: SLF001
    if job is not None:
        job.attach(_ProcHandle(proc, pjob))
    out_b: List[bytes] = []
    err_b: List[bytes] = []
    readers = [threading.Thread(target=lambda: out_b.append(proc.stdout.read()), daemon=True),
               threading.Thread(target=lambda: err_b.append(proc.stderr.read()), daemon=True)]
    for t in readers:
        t.start()
    try:
        try:
            proc.stdin.write(stdin_text.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass
        deadline = time.monotonic() + timeout
        while proc.poll() is None:
            if job is not None and job.cancelled.is_set():
                aipool.kill_tree(proc, pjob)
                raise AIError("已取消", code="cancelled")
            if time.monotonic() > deadline:
                aipool.kill_tree(proc, pjob)
                raise AIError(f"AI 超过 {timeout:g} 秒没有返回，已中止", code="timeout")
            time.sleep(0.1)
        for t in readers:
            t.join(timeout=10)
    finally:
        if job is not None:
            job.detach()
        if pjob is not None:
            pjob.close()                           # KILL_ON_JOB_CLOSE：正常结束后还留着的孙子进程也一起结束
    if job is not None and job.cancelled.is_set():
        raise AIError("已取消", code="cancelled")
    out = (out_b[0] if out_b else b"").decode("utf-8", "replace")
    err = (err_b[0] if err_b else b"").decode("utf-8", "replace")
    return proc.returncode, out, err


def _run_codex(system: str, user: str, timeout: float, job: Optional[AiJob] = None) -> str:
    cmd = codex_cmd()
    if not cmd:
        raise AIError("找不到 codex 命令行", code="unavailable")
    cfg = settings.ai_config()
    d = tempfile.mkdtemp(prefix="ccb_ai_")
    try:
        out_file = os.path.join(d, "last_message.txt")
        args = cmd + ["exec", "--ignore-user-config", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
                      "--color", "never", "-C", d, "-o", out_file, "-c", 'web_search="disabled"',
                      "-c", f'model_reasoning_effort="{cfg.get("codex_effort") or "medium"}"']
        if cfg.get("codex_model"):
            args += ["-m", str(cfg["codex_model"])]
        for f in _CODEX_DISABLE:
            args += ["--disable", f]
        args += ["-"]
        prompt = f"{system}\n\n==========\n\n{user}"
        rc, out, err = _run(args, prompt, d, timeout, job)
        text = ""
        if os.path.exists(out_file):
            with open(out_file, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    if not text.strip():
        raise AIError(f"codex 没有给出回答（退出码 {rc}）：{(err or out)[-300:]}")
    return text


def _run_claude_stream(kind: str, system: str, user: str, timeout: float, job: AiJob) -> AiReply:
    """用预热池里的 claude 进程（没有就现开一个）跑一次，边读边把文字推给 job。"""
    if not claude_cmd():
        raise AIError("找不到 claude 命令行", code="unavailable")
    key = _pool_key(system)
    try:
        stall = float(settings.ai_config().get("stall_s") or 60)
    except (TypeError, ValueError):
        stall = 60.0
    for attempt in (1, 2):
        try:
            wp, warm_hit = POOL.acquire(kind, system, key)
        except aipool.PoolError as e:
            raise AIError(e.message, code=e.code)
        job.warm = warm_hit
        age = float(wp.age_s()) if warm_hit else 0.0
        job.warm_age_s = round(age, 1) if warm_hit else None
        job.attach(wp)
        if not warm_hit:
            msg = "没有预热好的 AI 进程，现开一个（要多等几秒）"
        elif age < WARM_READY_S:        # 进程开出来要约 6 秒才能开始干活（例：报错后马上点「让 AI 改」，补开的进程才刚开）
            msg = f"AI 进程刚开 {age:.0f} 秒，还在启动，马上就好"
        else:
            msg = "AI 进程已经预热好，直接开始"
        job.status("start", msg, warm=warm_hit, warm_age_s=job.warm_age_s)
        try:
            left = timeout - job.ms() / 1000
            ev = wp.run(user, max(1.0, left), job.cancelled, job.delta, job.thinking, stall_s=stall)
        except aipool.Cancelled:
            raise AIError("已取消", code="cancelled")
        except aipool.Timeout:
            raise AIError(f"AI 超过 {timeout:g} 秒没有返回，已中止", code="timeout")
        except aipool.Stalled as e:
            raise AIError(f"AI 连续 {e.seconds:g} 秒没有任何动静（可能卡住了），已中止。点「再试一次」重新问", code="timeout")
        except aipool.ProcDead as e:
            if job.cancelled.is_set():
                raise AIError("已取消", code="cancelled")
            if e.before_output and attempt == 1:
                # 在收到模型输出之前进程就退出了：换一个进程把同一个请求再发一次。
                job.status("restart", "预热的 AI 进程意外退出了，换一个重来")
                continue
            raise AIError(e.message)
        finally:
            job.detach()
            POOL.release(kind, wp)
        if ev.get("is_error") or (ev.get("subtype") not in (None, "success")):
            raise AIError(f"claude 报错：{str(ev.get('result') or ev.get('subtype'))[:300]}")
        job.ai_done_ms = job.ms()
        usage = ev.get("usage") or {}
        job.output_tokens = usage.get("output_tokens")
        text = str(ev.get("result") or "") or "".join(job.text_parts)
        return AiReply(text, warm=warm_hit, first_token_ms=job.first_token_ms, total_ms=job.ai_done_ms,
                       output_tokens=job.output_tokens, engine="claude")
    raise AIError("AI 进程连续两次刚开就退出了")


def _run_api(system: str, user: str, timeout: float, job: AiJob) -> AiReply:
    """API 通道（aiapi.py）：每次请求现连，没有预热。"""
    from . import aiapi
    a = settings.api_config()
    ok, note = aiapi.api_ready(a)
    if not ok:
        raise AIError(note, code="channel")
    try:
        stall = float(settings.ai_config().get("stall_s") or 60)
    except (TypeError, ValueError):
        stall = 60.0
    job.warm = False
    job.status("start", f"正在连接 {aiapi.label(a)}")     # 不带 warm：前端的「没有预热好的进程」提示只对 claude 有意义
    return aiapi.stream_chat(a, system, user, timeout, stall, job)


def run_engine(engine_id: str, kind: str, system: str, user: str, timeout: float, job: AiJob) -> AiReply:
    """真正调 AI。同时最多 2 个请求在跑；排队时可以取消。"""
    waited = False
    while not _SEM.acquire(timeout=0.2):
        if not waited:
            waited = True
            job.status("queue", "前面还有 AI 请求在跑，排队中")
        if job.cancelled.is_set():
            raise AIError("已取消", code="cancelled")
    try:
        if engine_id == "api":
            return _run_api(system, user, timeout, job)
        if engine_id == "codex":
            ok, note = check_codex_channel()
            if not ok:
                raise AIError(note, code="channel")
            job.warm = False
            job.status("start", "Codex 在写（Codex 没有预热，也不能边写边显示，比 Claude 慢）", warm=False)
            text = _run_codex(system, user, timeout, job)
            job.ai_done_ms = job.ms()
            job.delta(text)                     # codex 不能流式：写完一次性给出
            return AiReply(text, warm=False, first_token_ms=job.first_token_ms, total_ms=job.ai_done_ms, engine="codex")
        return _run_claude_stream(kind, system, user, timeout, job)
    finally:
        _SEM.release()


# 测试时替换成假函数：RUNNER(engine_id, kind, system, user, timeout, job) -> AiReply 或 str
RUNNER: Callable[..., Any] = run_engine


def _call_ai(engine_id: str, kind: str, system: str, user: str, timeout: float, job: AiJob) -> AiReply:
    r = RUNNER(engine_id, kind, system, user, timeout, job)
    if isinstance(r, AiReply):
        return r
    text = str(r)                      # 假 RUNNER 直接返回字符串：补上计时
    if job.first_token_ms is None:
        job.delta(text)
    job.ai_done_ms = job.ms()
    if job.warm is None:
        job.warm = False
    return AiReply(text, warm=bool(job.warm), first_token_ms=job.first_token_ms, total_ms=job.ai_done_ms, engine=engine_id)


def engine_ready(engine_id: str) -> Tuple[bool, str]:
    if engine_id not in ENGINES:
        return False, f"引擎只能是 {' / '.join(ENGINES)}"
    if RUNNER is not run_engine:           # 测试用的假引擎
        return True, "测试引擎"
    if engine_id == "api":
        from . import aiapi
        return aiapi.api_ready(settings.api_config())
    if engine_id == "claude":
        if not claude_cmd():
            return False, "找不到 claude 命令行"
        return check_claude_channel()
    if not codex_cmd():
        return False, "找不到 codex 命令行"
    return check_codex_channel()


def status() -> Dict[str, Any]:
    from . import aiapi
    cfg = settings.ai_config()
    a = settings.api_config()
    ok, note = aiapi.api_ready(a)
    out = [{"id": "api", "label": aiapi.label(a), "model": str(a.get("model") or "") or None, "available": ok,
            "channel_ok": ok, "note": note, "warm": False, "slow": False}]
    for eid in ("claude", "codex"):
        cmd = claude_cmd() if eid == "claude" else codex_cmd()
        ok, note = (check_claude_channel() if eid == "claude" else check_codex_channel()) if cmd else (False, "找不到命令行")
        out.append({"id": eid, "label": CLI_LABELS[eid], "available": bool(cmd), "channel_ok": bool(cmd) and ok,
                    "note": note, "model": claude_model() if eid == "claude" else (cfg.get("codex_model") or "codex 默认"),
                    "warm": eid == "claude", "slow": eid == "codex"})
    return {"engines": out, "default": cfg.get("default_engine") or "api",
            "timeout_s": cfg.get("timeout_s"), "max_input_chars": cfg.get("max_input_chars"),
            "claude_effort": claude_effort() or "default", "pool": POOL.status()}


# ================================================================ 解析
def extract_json(text: str) -> Dict[str, Any]:
    """从 AI 输出里取出第一个 JSON 对象（容忍 ```json 代码块和前后的附加文字）。"""
    if not isinstance(text, str) or not text.strip():
        raise AIError("AI 没有输出内容", code="parse")
    s = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", s, flags=re.S)
    cands = [m.group(1).strip()] if m else []
    cands.append(s)
    for c in cands:
        try:
            v = json.loads(c)
            if isinstance(v, dict):
                return v
        except ValueError:
            pass
        start = c.find("{")
        while start != -1:
            depth, in_str, esc = 0, False, False
            for i in range(start, len(c)):
                ch = c[i]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                    continue
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            v = json.loads(c[start:i + 1])
                            if isinstance(v, dict):
                                return v
                        except ValueError:
                            pass
                        break
            start = c.find("{", start + 1)
    raise AIError("AI 的输出没法解析成 JSON，已丢弃", code="parse")


def _str_list(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v] if v.strip() else []
    if isinstance(v, list):
        return [str(x) for x in v if x is not None and str(x).strip()]
    return [str(v)]


# ================================================================ 标签 / 声优名：对照库校验，能换就换
_STYLE_WHAT = {"game": "角色的作品标签", "char": "角色标签", "meta": "公共标签", "work": "作品本身的标签", "va": "声优"}
# 「XX 番 / XX 类 / XX 题材」这类说法：去掉后缀之后库里有，就换成库里的写法（长的后缀先试）
_SUFFIXES = tuple(sorted(("番剧", "番", "类型", "类", "题材", "元素", "作品", "动画", "属性", "风格", "系列", "系", "风", "向"),
                         key=len, reverse=True))
_NORM_STRIP = re.compile(r"[\s·・\-_/／,，、.。'\"「」『』]+")


def _norm_name(s: str) -> str:
    """只抹掉写法差异：全角半角、大小写、空格和间隔号。"""
    return _NORM_STRIP.sub("", unicodedata.normalize("NFKC", s or "").casefold())


def _tf_style(tf: Any) -> str:
    return "meta" if getattr(tf, "tag_mode", None) == "meta" else "work"


def _name_slots(spec: SpecV2):
    """(style, 名字列表) —— 方案里所有要对照库检查的名字（清单里的不查：那是用户自己的）。"""
    for r in list(spec.ranges) + list(spec.excludes):
        if r.source.kind == "rank" and r.source.work_filter is not None:
            yield _tf_style(r.source.work_filter), list(r.source.work_filter.tags or [])
        for c in r.conditions:
            if c.type == "game_tags":
                yield "game", list(c.tags or [])
            elif c.type == "char_tags":
                yield "char", list(c.tags or [])
            elif c.type == "appearance" and c.work_tags is not None:
                yield _tf_style(c.work_tags), list(c.work_tags.tags or [])
            elif c.type == "va":
                yield "va", [n for n in c.names if n and n.strip()]


def _dict_slots(d: Dict[str, Any]):
    """同上，但走 dict（替换名字时用）：yield (style, 容器 dict, 字段名)。"""
    for key in ("ranges", "excludes"):
        for r in d.get(key) or []:
            src = r.get("source") or {}
            wf = src.get("work_filter") if src.get("kind") == "rank" else None
            if isinstance(wf, dict):
                yield ("meta" if wf.get("tag_mode") == "meta" else "work"), wf, "tags"
            for c in r.get("conditions") or []:
                t = c.get("type")
                if t == "game_tags":
                    yield "game", c, "tags"
                elif t == "char_tags":
                    yield "char", c, "tags"
                elif t == "appearance" and isinstance(c.get("work_tags"), dict):
                    wt = c["work_tags"]
                    yield ("meta" if wt.get("tag_mode") == "meta" else "work"), wt, "tags"
                elif t == "va":
                    yield "va", c, "names"


def _exists_fn(snap, spec: SpecV2, style: str) -> Callable[[str], bool]:
    """这个名字库里有没有（便宜：内存查表或按名字查一次 SQL）。"""
    if style == "game":
        mp = HUB.mode(snap, spec.game.mode)
        return lambda t: t in mp.tag_universe
    if style == "char":
        return snap.char_tag_counts().__contains__
    if style == "meta":
        return lambda t: bool(snap.meta_tag_set(t))
    if style == "work":
        return lambda t: bool(snap.work_tag_sets(t)[0])
    fold = snap.va_fold()
    return lambda t: t.strip().casefold() in fold


def _universe(snap, spec: SpecV2, style: str) -> Dict[str, int]:
    """全部名字 → 数量（找相近写法用）。作品标签的全集第一次要读好几秒（后端启动时已在后台预热），所以只在名字不存在时才取。"""
    if style == "game":
        return HUB.mode(snap, spec.game.mode).tag_universe
    if style == "char":
        return snap.char_tag_counts()
    if style == "meta":
        return snap.meta_tag_counts()
    if style == "work":
        return snap.work_tag_counts()
    return snap.va_counts()


def _norm_index(snap, spec: SpecV2, style: str, universe: Dict[str, int]) -> Dict[str, List[str]]:
    key = f"ai_norm:{style}:{spec.game.mode if style == 'game' else ''}"
    with snap.cache_lock:
        hit = snap.cache.get(key)
    if hit is not None:
        return hit
    idx: Dict[str, List[str]] = {}
    for k in universe:
        idx.setdefault(_norm_name(k), []).append(k)
    with snap.cache_lock:
        snap.cache[key] = idx
    return idx


def auto_fix_name(name: str, style: str, exists: Callable[[str], bool], norm_index: Dict[str, List[str]]) -> Optional[str]:
    """库里没有的名字 → 唯一且足够接近的库里写法；拿不准返回 None。
    足够接近 = ① 只差写法（全半角 / 大小写 / 空格 / 间隔号），而且库里只有一个这样的；
              ② 标签去掉「番 / 类 / 题材 / 系 / 向 …」后缀之后库里正好有（例：后宫番 → 后宫）。声优名只认 ①。"""
    raw = (name or "").strip()
    if not raw:
        return None
    hits = [t for t in norm_index.get(_norm_name(raw), []) if t != name and exists(t)]
    if len(hits) == 1:
        return hits[0]
    if hits or style == "va":
        return None
    for suf in _SUFFIXES:
        if raw.endswith(suf) and len(raw) > len(suf):
            base = raw[: -len(suf)].strip()
            if base and exists(base):
                return base
            hits = [t for t in norm_index.get(_norm_name(base), []) if exists(t)]
            return hits[0] if len(hits) == 1 else None
    return None


def scan_names(spec: SpecV2) -> List[Dict[str, Any]]:
    """方案里 AI 写的标签 / 声优名，库里不存在的 → [{name, style, what, auto, candidates: [{name, count}]}]。"""
    def run(snap):
        out: List[Dict[str, Any]] = []
        seen = set()
        for style, names in _name_slots(spec):
            for nm in names:
                if (style, nm) in seen:
                    continue
                seen.add((style, nm))
                exists = _exists_fn(snap, spec, style)
                if exists(nm):
                    continue
                universe = _universe(snap, spec, style)
                idx = _norm_index(snap, spec, style, universe)
                auto = auto_fix_name(nm, style, exists, idx)
                # 候选：先放只差写法的（大小写 / 全半角，按数量），再放 closest_names 找的相近写法
                same = sorted((k for k in idx.get(_norm_name(nm), []) if k != nm), key=lambda k: -int(universe.get(k, 0) or 0))
                close: List[str] = []
                for k in same + engine.closest_names(nm.strip(), universe, 6):
                    if k != auto and k not in close and exists(k):
                        close.append(k)
                close = close[:5]
                out.append({"name": nm, "style": style, "what": _STYLE_WHAT[style], "auto": auto,
                            "auto_count": int(universe.get(auto, 0) or 0) if auto else None,
                            "candidates": [{"name": k, "count": int(universe.get(k, 0) or 0)} for k in close]})
        return out
    return with_snapshot(run)


def replace_name(d: Dict[str, Any], style: str, old: str, new: str) -> bool:
    """在方案 dict 里把 style 这一类的名字 old 换成 new（去重）。返回有没有换。"""
    changed = False
    for st, box, field in _dict_slots(d):
        if st != style:
            continue
        vals = box.get(field) or []
        if old in vals:
            nv: List[str] = []
            for v in vals:
                v2 = new if v == old else v
                if v2 not in nv:
                    nv.append(v2)
            box[field] = nv
            changed = True
    return changed


def fix_names(spec: SpecV2, text: str = "") -> Tuple[SpecV2, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """标签名不存在时**不让 AI 改**：唯一且足够接近的后端直接换（replaced），拿不准的原样保留、给候选（fixes）。"""
    missing = scan_names(spec)
    if not missing:
        return spec, [], []
    d = spec_to_dict(spec)
    replaced, fixes = [], []
    for m in missing:
        if m["auto"] and replace_name(d, m["style"], m["name"], m["auto"]):
            who = "你说的" if m["name"] in (text or "") else "AI 写的"
            replaced.append({"from": m["name"], "to": m["auto"], "to_count": m.get("auto_count"), "style": m["style"],
                             "what": m["what"], "others": m["candidates"],
                             "message": f"{who}『{m['name']}』库里叫『{m['auto']}』，已替换"})
        else:
            fixes.append({"name": m["name"], "style": m["style"], "what": m["what"], "candidates": m["candidates"],
                          "message": f"{m['what']}『{m['name']}』库里没有" +
                                     (f"，可以换成：{'、'.join(c['name'] for c in m['candidates'])}" if m["candidates"]
                                      else "，也没有相近的（这个条件现在筛不出人）")})
    if replaced:
        try:
            spec = parse_spec(d)
        except SpecError:
            return spec, [], [{"name": m["name"], "style": m["style"], "what": m["what"], "candidates": m["candidates"],
                               "message": f"{m['what']}『{m['name']}』库里没有"} for m in missing]
    return spec, replaced, fixes


# ================================================================ 提示词
SPEC_DOC = """工作台方案（Spec）JSON 结构：
{
  "version": 2,
  "game": {"mode": "anime"|"game"|"book"|"real"|"all", "tag_count": 0–10},   // 对局设置：游戏模式和作品标签数（默认 anime、6）
  "ranges": [Range, ...],       // 纳入的范围，彼此之间是「或」
  "excludes": [Range, ...],     // 排除项（结构和范围一样），永远最后生效
  "draw": {"method": "per_character"|"per_work"|"range_share", "seed": null}
}
Range = {
  "id": "r_xxx", "enabled": true, "label": null, "share": null,
  "source": Source,             // 从哪来（一定有值）
  "pick": {"roles": ["主角"] 或 ["主角","配角"] 或 ["配角"], "per_work": 数字或 null（不限）, "order": "heat"|"game"},  // 每部作品取哪些角色
     // order：heat = 按角色热度取前 per_work 个；game = 和游戏一样（角色 id 从小到大，游戏就是按这个顺序截取的）
     // 默认（和游戏一样）：只要主角时 per_work = null（不截断）；带配角时 per_work = 6
  "conditions": [Condition, ...]   // 再筛，彼此之间是「且」
}
Source 四种：
  {"kind":"rank","subject_types":[2],"year_from":2016,"year_to":2026,"rank_from":1,"rank_to":50,"rank_scope":"merged"|"per_year","work_filter":null 或 TagFilter}
     // 条目类型 1 书籍 2 动画 3 音乐 4 游戏 6 三次元；year_from/year_to 为 null 表示不限；rank_to 为 null 表示「全部」；
     // per_year = 每年分别取前 N 部；work_filter = 作品本身的标签（先按它筛作品，再按热度排名）
  {"kind":"work_list","list_id":"清单 id"}     // 作品清单里的作品
  {"kind":"char_list","list_id":"清单 id"}     // 角色清单里的角色
  {"kind":"all_characters"}                     // 整个角色库（一般只用在排除区）
TagFilter = {"quant":"any"|"all"|"at_least"|"none", "k":数字或 null, "tags":["标签",...], "tag_list_id":null 或 标签清单 id,
             "tag_mode":"main"|"any"|"meta"}
     // any 含任一 / all 含全部 / at_least 至少含 k 个 / none 都不含；tags 和 tag_list_id 取并集
     // tag_mode 只对作品本身的标签有意义：main = 这部作品的主要标签（默认），any = 有人打过就算，meta = Bangumi 公共标签（如 Galgame）
Condition（每个都有 "id":"c_xxx","enabled":true,"negate":false；negate=true 表示取反）：
  {"type":"gender","values":["男"|"女"|"未知",...]}
  {"type":"char_heat","min":数字或 null,"max":数字或 null}               // 角色热度（收藏数）
  {"type":"game_tags", ...TagFilter}   // 角色的作品标签 = 游戏格子里显示的那组（按 game.mode 和 tag_count 算）。「XX 番的角色」「标签含 XX」一般用它
  {"type":"char_tags", ...TagFilter}   // 角色标签（外观 / 属性，如 黑长直、双马尾、傲娇）
  {"type":"va","names":["声优名"]}     // 声优是其中任一
  {"type":"source_tag","values":["原创"|"漫画改"|"小说改"|"游戏改"]}
  {"type":"n_app"|"earliest_year"|"latest_year"|"rating","min":…,"max":…}   // 登场作品数 / 最早登场年 / 最晚登场年 / 最高评分
  {"type":"appearance","subject_types":null 或 [..],"year_from":…,"year_to":…,"roles":null 或 ["主角","配角","客串"],"work_tags":null 或 TagFilter,"work_list_id":null}
     // 至少有一部登场作品同时满足给出的所有项（例：「2024 年的某部动画里当过主角」）
  {"type":"char_list","list_id":"角色清单 id"}
  {"type":"sql","sql":"只读 SQL，第一列是 character_id","label":"说明"}"""

FILL_RULES = """规则（必须遵守）：
1. 不追问。信息不全就沿用当前方案里已有的值。
2. 只改用户话里说到的东西；没说到的字段不要动（不要写进 patch）。
3. 只输出一个 JSON 对象，不要任何其它文字，不要 markdown 代码块。
4. 标签要写 Bangumi 上的常见写法（百合、日常、战斗、恋爱、后宫、校园、奇幻、科幻、搞笑、音乐、运动、偶像、治愈、热血、机战、推理、悬疑、GL、萌……）。
   后端会对照库校验：只差一点的写法（例「百合番」）会自动换成库里的写法。
5. 清单只能用下面「现有清单」里的 id，不要编。
6. 常见说法怎么填：
   - 「XX 番」「XX 类」「作品标签含 XX」「标签含 XX 的角色」→ 主理解一律用条件 game_tags（界面上叫「作品标签」= 角色在游戏格子里显示的作品标签）；
     「作品本身带 XX 标签」（source.work_filter）只能放在 alternative 里。
   - 「女性角色 / 男角色」→ gender。「全部作品 / 不限热度」→ rank_to = null。
   - 「主角和配角 / 包括配角」→ pick.roles = ["主角", "配角"]；用户没说每部几个人时 per_work = 6（游戏的默认每部角色数）。
     只要主角时 per_work = null（游戏「仅主角」不截断）。用户说了人数就按用户的。
   - 「近 N 年」→ year_from = 今年 − N，year_to = 今年；「某年的」→ year_from = year_to = 该年。
   - 「热门」「别太冷门」「不要太冷门」→ 不改热度范围：默认的「热度前 50 部」已经是热门作品，在 defaults_used 里说明。
     注意「别太冷门」的意思是「要热门一点」，不是「要冷门」。只有用户明确要冷门作品（例「冷门番」「小众作品」）时，才把 rank_from 改大（例 51–300）。
   - 「拥有 N 个以上某清单的标签」→ 条件 game_tags（quant = at_least, k = N, tag_list_id = 清单 id），并且同时放宽范围：
     rank_to = null（全部作品）、pick.roles = ["主角", "配角"]、per_work = 6——这几项都要写进 patch（清单条件本身已经很严，不放宽就几乎没人）。
   - 「某声优配音的」→ va。「在 XX 年的动画里登场过 / 当过主角」→ appearance。「不要 XX」→ 取反的条件或排除项。
   - 「标签数 N」→ game.tag_count。
7. 作品类型和对局模式要一致（猜猜呗里选「游戏 / 书籍 / 三次元」分类时，出题范围和格子都按这一类算）：
   - 用户的话明确指向单独一种作品类型（游戏 / 书籍 / 三次元）时，把范围的 source.subject_types 改成它（游戏 [4]、书籍 [1]、三次元 [6]），
     同时把 game.mode 改成对应模式（game / book / real）。
     例：「近 5 年热门游戏的女主角」→ subject_types = [4]、game.mode = "game"、year_from = 今年 − 5、条件 gender = 女、pick.roles = ["主角"]。
   - 例外：Galgame。游戏的 Galgame 模式里角色数据按动画算，所以 subject_types = [4]、work_filter = 公共标签 Galgame（tag_mode = "meta"），game.mode 保持 anime。
   - 用户明确说「所有类型 / 全部类型的作品」→ subject_types = [1, 2, 4, 6]、game.mode = "all"。
   - 真的拿不准用户是想换模式、还是只想从这类作品里出题但按动画格子猜时：按换模式填，用 alternative 给出「模式保持动画」的另一种理解。
8. 只有当一句话有两种都说得通的理解、而且两种理解会筛出不同的人时，才给 alternative（例：「战斗番」可以理解为角色的作品标签含「战斗」，也可以理解为作品本身带「战斗」标签）。
9. defaults_used / note / alternative.label 这些给人看的文字只用中文：模式写 动画 / 游戏 / 书籍 / 三次元 / 全部，
   不要写 anime / game / book / real / all，也不要写字段名（subject_types、game_tags、rank_to 之类）。

输出格式（只输出这个 JSON，越短越好）：
{"patch": [修改, ...], "defaults_used": ["…"], "note": null, "alternative": null}
- patch 是对「当前方案」的 JSON Patch（RFC 6902），只用 add / replace / remove；路径以「当前方案」为准，数组下标从 0 开始。
  一次删 / 改好几个条件时，每条的下标都按它在「当前方案」里的位置写（后端按原来的位置处理，不用自己算删掉之后的位移）。
  路径写到具体字段（如 /ranges/0/source/year_from），字段名必须是上面结构里有的——写错的字段会让这次修改整个作废：
  改一个值：{"op":"replace","path":"/ranges/0/source/year_from","value":2024}
  加条件（加在末尾写 -）：{"op":"add","path":"/ranges/0/conditions/-","value":{"type":"gender","values":["女"]}}
  删掉一个条件：{"op":"remove","path":"/ranges/0/conditions/1"}
  设作品本身的标签：{"op":"replace","path":"/ranges/0/source/work_filter","value":{"quant":"any","tags":["战斗"],"tag_mode":"main"}}
  改对局模式：{"op":"replace","path":"/game/mode","value":"game"}
  新加的条件不用写 id / enabled / negate（后端会补）。完全不用改时 patch 写 []。
- defaults_used：用户没说、沿用当前方案的要点，最多 3 条，每条不超过 30 字（例「热度前 50 部（你说「别太冷门」，我没有再收紧）」）。
- note：一般写 null；有必须提醒用户的事才写一句话。
- alternative：null 或 {"label": "另一种理解：……", "patch": [...]}。alternative.patch 也是对「当前方案」的完整修改
  （两种理解共同的改动也要写上），不是在 patch 的基础上再改。"""


def _lists_brief() -> List[Dict[str, Any]]:
    out = []
    for d in LISTS.all():
        items = d.get("items") or []
        e = {"id": d.get("id"), "name": d.get("name"), "kind": d.get("kind"), "items": len(items)}
        if d.get("kind") == "tag":
            e["tags"] = [it.get("name") for it in items[:40]]
        out.append(e)
    return out


def fill_system() -> str:
    y = time.localtime().tm_year
    return ("你是「猜猜呗出题器」工作台的填表助手。用户用一句中文描述想从哪些 Bangumi 角色里出题（猜猜呗猜角色游戏），"
            "你输出对当前工作台方案（JSON）的修改。\n"
            f"今天是 {time.strftime('%Y-%m-%d')}，今年 = {y}。\n\n" + SPEC_DOC + "\n\n" + FILL_RULES)


def fill_user(text: str, cur: SpecV2) -> str:
    return ("现有清单：" + json.dumps(_lists_brief(), ensure_ascii=False) + "\n\n"
            "当前方案（patch 的路径以它为准）：" + json.dumps(spec_to_dict(cur), ensure_ascii=False) + "\n\n"
            f"用户的话：「{text}」")


ASK_FORMAT = """输出格式（纯文本，严格按这个顺序写，方便边写边给用户看；不要 JSON，不要别的话）：
说明：这条查询怎么算的（1–3 句中文）
范围：统计的是库里哪些作品 / 角色，以及库的覆盖范围带来的限制（要具体；不要写具体数字）
```sql
一条 SELECT 或 WITH…SELECT
```
存为：character character_id
（最后一行：结果能存成清单时写「存为：种类 列名」——角色列表写 character 和角色 id 列、作品列表写 work 和作品 id 列、标签列表写 tag 和标签列；不能存就写「存为：无」）"""


def ask_system(snap) -> str:
    vis_rule = ("subject.search_visible = 1（匿名搜索可见；和游戏的热度排名同一口径）"
                if snap.visible_col == "search_visible" else "subject.nsfw = 0")
    conn = snap.connect()
    try:
        schema = schema_doc.build_schema(conn)
        vis = snap.visible_sql
        types = dict(conn.execute(f"SELECT s.type, COUNT(*) FROM subject s WHERE {vis} GROUP BY s.type").fetchall())
        with_chars = dict(conn.execute(
            "SELECT s.type, COUNT(DISTINCT s.id) FROM subject s JOIN appearance a ON a.subject_id = s.id "
            f"WHERE {vis} GROUP BY s.type").fetchall())
    finally:
        conn.close()
    m = snap.meta
    facts = [
        f"数据来自 Bangumi dump「{m.get('dump_name')}」，库生成于 {m.get('built_at')}，today = {snap.today}。",
        f"subject 里匿名搜索可见（{vis}）的条目数：" + "、".join(f"{schema_doc_type(t)} {n:,}" for t, n in sorted(types.items())),
        "其中有角色（appearance）的：" + "、".join(f"{schema_doc_type(t)} {n:,}" for t, n in sorted(with_chars.items())),
        f"作品标签：tags_source='api' 的 {m.get('tags_api_subjects')} 部有完整标签（最多 30 个）；"
        f"tags_source='dump' 的 {m.get('tags_dump_subjects')} 部只有 dump 前 11 个标签；其余没有标签。",
        f"character 表 {snap.counts.get('characters'):,} 人（在任意非 NSFW 条目里当过主角或配角的角色）。",
    ]
    ex = "\n\n".join(f"问：{e['q']}\nSQL：\n{e['sql']}" for e in schema["examples"])
    return ("你是「猜猜呗出题器」的「问数据」助手。用户用一句中文问 Bangumi 角色 / 作品数据的问题，你写一条 SQLite（3.40）只读查询来回答。"
            "后端会自动运行你写的 SQL，把结果表给用户看。\n\n"
            "规则：\n"
            "1. " + ASK_FORMAT + "\n"
            "2. 只能一条查询；不能写入；不要用 SQLite 3.40 没有的函数（string_agg、concat），用 group_concat 和 ||。\n"
            "3. 结果列名用中文或清楚的英文。返回角色列表时带 character_id 列、名字（display_name）和热度，按热度降序；"
            "返回作品列表时带 subject_id 列；列表类结果加 LIMIT（不超过 500）。\n"
            "4. 用户说「作品」「番」没说类型时默认指动画（type = 2）；统计作品一定加 " + vis_rule + "。\n"
            "5. 「某标签在多少部作品里出现」有两种口径：任意标注数 / 主要标签（count ≥ 该作品最高 count 的 10%）。"
            "能的话在一条查询里用两列同时给出两种口径，并在说明里讲清楚。\n"
            "6. 「范围」要写清楚：统计的是库里哪些作品 / 角色，以及库的覆盖范围带来的限制（比如按标签统计时，只有部分作品有完整标签）。"
            "范围里**不要写具体数字**（后端会自己附上准确的覆盖数字）。\n\n"
            "库的情况：\n" + "\n".join("- " + f for f in facts) + "\n\n"
            "表结构：\n" + schema_doc.schema_text(schema) + "\n\n"
            "示例：\n" + ex)


def ask_system_cached(snap) -> str:
    """ask 的系统提示词按库快照缓存：预热进程的指纹靠它判断「库换了没有」，不能每次都重算（要查库）。"""
    key = "ai_ask_system"
    with snap.cache_lock:
        hit = snap.cache.get(key)
    if hit is not None:
        return hit
    s = ask_system(snap)
    with snap.cache_lock:
        snap.cache[key] = s
    return s


def scope_facts(snap) -> str:
    """库的覆盖数字（后端统计，附在 scope_note 后面；不让 AI 自己写数字）。"""
    key = "scope_facts"
    with snap.cache_lock:
        hit = snap.cache.get(key)
    if hit:
        return hit
    conn = snap.connect()
    try:
        vis = snap.visible_sql
        n_anime = conn.execute(f"SELECT COUNT(*) FROM subject s WHERE s.type = 2 AND {vis}").fetchone()[0]
        n_anime_c = conn.execute("SELECT COUNT(DISTINCT s.id) FROM subject s JOIN appearance a ON a.subject_id = s.id "
                                 f"WHERE s.type = 2 AND {vis}").fetchone()[0]
        tag_src = dict(conn.execute(f"SELECT COALESCE(s.tags_source, 'none'), COUNT(*) FROM subject s WHERE s.type = 2 AND {vis} "
                                    "GROUP BY 1").fetchall())
    finally:
        conn.close()
    m = snap.meta
    out = (f"库的覆盖（后端统计）：Bangumi dump「{m.get('dump_name')}」；匿名搜索可见的动画 {n_anime:,} 部，其中有角色登场的 {n_anime_c:,} 部；"
           f"这些动画里标签完整（最多 30 个）的 {tag_src.get('api', 0):,} 部、只有 dump 前 11 个标签的 {tag_src.get('dump', 0):,} 部、"
           f"没有标签的 {tag_src.get('none', 0):,} 部；角色 {snap.counts.get('characters', 0):,} 人（只收当过主角或配角的）。")
    with snap.cache_lock:
        snap.cache[key] = out
    return out


def schema_doc_type(t: int) -> str:
    return {1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元"}.get(t, str(t))


def ask_user(question: str) -> str:
    return ("现有清单（在 user_list / user_list_item 表里）：" + json.dumps(_lists_brief(), ensure_ascii=False) + "\n\n"
            f"问题：「{question}」")


def ask_fix_user(question: str, sql: str, error: str) -> str:
    return (ask_user(question) + "\n\n上一次写的 SQL：\n```sql\n" + (sql or "").strip() + "\n```\n"
            f"运行出错：{(error or '').strip()}\n"
            "请改正这条 SQL，按同样的格式重新输出（说明、范围、SQL、存为）。")


# ================================================================ 人数为 0 / 太多时的建议（人数全部由后端算，句子用后端模板）
def _variants(spec: SpecV2, total: int) -> List[Tuple[str, SpecV2]]:
    out: List[Tuple[str, SpecV2]] = []
    base = spec_to_dict(spec)

    def mk(desc: str, mutate) -> None:
        d = json.loads(json.dumps(base))
        changed = False
        for r in d.get("ranges") or []:
            if r.get("enabled", True):
                changed = mutate(r, d) or changed
        if changed:
            try:
                out.append((desc, parse_spec(d)))
            except SpecError:
                pass

    if total == 0:
        def roles(r, d):
            if r["source"]["kind"] in ("rank", "work_list") and r["pick"]["roles"] == ["主角"]:
                r["pick"]["roles"] = ["主角", "配角"]
                if not r["pick"].get("per_work"):
                    r["pick"]["per_work"] = 6          # 带配角时和游戏一样每部最多 6 人
                return True
        mk("改成主角和配角（每部最多 6 人，和游戏一样）", roles)

        def rank_all(r, d):
            s = r["source"]
            if s["kind"] == "rank" and s.get("rank_to") is not None:
                s["rank_to"] = None
                s["rank_from"] = 1
                return True
        mk("热度范围改成全部作品", rank_all)

        def per_work(r, d):
            if r["source"]["kind"] in ("rank", "work_list") and r["pick"].get("per_work"):
                r["pick"]["per_work"] = None
                return True
        mk("每部作品不限人数", per_work)

        def widen_years(r, d):
            s = r["source"]
            if s["kind"] == "rank" and (s.get("year_from") is not None or s.get("year_to") is not None):
                yf, yt = s.get("year_from"), s.get("year_to")
                s["year_from"] = (yf - 5) if yf is not None else None
                s["year_to"] = (yt + 5) if yt is not None else None
                if s["year_to"] is not None and s["year_to"] > time.localtime().tm_year:
                    s["year_to"] = time.localtime().tm_year
                return True
        mk("年份范围前后各放宽 5 年", widen_years)

        def all_to_any(r, d):
            ch = False
            for c in r.get("conditions") or []:
                if c.get("type") in ("game_tags", "char_tags") and c.get("quant") == "all" and len(c.get("tags") or []) > 1:
                    c["quant"] = "any"
                    ch = True
            return ch
        mk("标签条件从「同时含」改成「含任一」", all_to_any)

        def more_tags(r, d):
            if d["game"]["tag_count"] < 10:
                d["game"]["tag_count"] = min(10, d["game"]["tag_count"] + 4)
                return True
        mk("作品标签数加到 {}".format(min(10, spec.game.tag_count + 4)), more_tags)
        # 去掉单个条件
        for ri, r in enumerate(spec.ranges):
            if not r.enabled:
                continue
            for c in r.conditions:
                if not c.enabled:
                    continue
                cid = c.id

                def drop(rr, d, cid=cid, rid=r.id):
                    if rr["id"] != rid:
                        return False
                    before = len(rr["conditions"])
                    rr["conditions"] = [x for x in rr["conditions"] if x.get("id") != cid]
                    return len(rr["conditions"]) != before
                from .sentence import condition_phrase
                mk("去掉条件「" + condition_phrase(c, LISTS.get) + "」", drop)
    else:
        def top(r, d):
            s = r["source"]
            if s["kind"] == "rank" and (s.get("rank_to") is None or s["rank_to"] > 100):
                s["rank_from"] = 1
                s["rank_to"] = 100
                return True
        mk("热度范围收紧到前 100 部", top)

        def main_only(r, d):
            if r["source"]["kind"] in ("rank", "work_list") and "配角" in r["pick"]["roles"]:
                r["pick"]["roles"] = ["主角"]
                return True
        mk("只要主角", main_only)

        def cap(r, d):
            if r["source"]["kind"] in ("rank", "work_list") and not r["pick"].get("per_work"):
                r["pick"]["per_work"] = 6
                return True
        mk("每部最多 6 人", cap)

        def recent(r, d):
            s = r["source"]
            if s["kind"] == "rank" and s.get("year_from") is None:
                y = time.localtime().tm_year
                s["year_from"], s["year_to"] = y - 10, y
                return True
        mk("只看近 10 年", recent)

        def heat(r, d):
            r.setdefault("conditions", []).append({"id": "c_sugg_heat", "type": "char_heat", "min": 300})
            return True
        mk("加条件：角色热度至少 300", heat)
    return out


def compute_suggestions(spec: SpecV2, total: int) -> List[Dict[str, Any]]:
    res = []
    for desc, sp in _variants(spec, total)[:10]:
        try:
            t = len(engine.evaluate(sp).pool)
        except Exception:  # noqa: BLE001
            continue
        if t == total:
            continue
        res.append({"desc": desc, "total": t})
    if total == 0:
        res = [r for r in res if r["total"] > 0]
        res.sort(key=lambda r: r["total"])
    else:
        res = [r for r in res if r["total"] > 0]
        res.sort(key=lambda r: -r["total"])
    return res[:5]


def _template_suggestion(total: int, sugg: List[Dict[str, Any]]) -> str:
    if not sugg:
        return "现在是 0 人，后端试了几种放宽办法也还是 0 人，可能是标签写法不对或条件互相矛盾。" if total == 0 else \
            f"现在有 {total:,} 人，范围比较大。"
    tips = "；".join(f"{s['desc']}（{s['total']:,} 人）" for s in sugg[:3])
    return (f"现在是 0 人。可以试试：{tips}。" if total == 0 else f"现在有 {total:,} 人，偏多。可以试试：{tips}。")


# ================================================================ 给人看的文字：只用中文（兜底，AI 偶尔会写 anime / game_tags）
_FIELD_ZH = [
    (r"game\.mode", "对局模式"), (r"game\.tag_count", "作品标签数"), (r"tag_count", "作品标签数"),
    (r"source\.subject_types", "作品类型"), (r"subject_types", "作品类型"), (r"game_tags", "作品标签"),
    (r"char_tags", "角色标签"), (r"work_filter", "作品本身的标签"), (r"pick\.roles", "身份"),
    (r"per_work", "每部人数"), (r"rank_to", "热度范围"), (r"rank_from", "热度范围起点"),
]
_MODE_WORD = re.compile(r"(?<![A-Za-z0-9_.])(anime|game|book|real|all)(?![A-Za-z0-9_])")
_MODE_ZH = {"anime": "动画", "game": "游戏", "book": "书籍", "real": "三次元", "all": "全部"}
_QUOTED = re.compile(r"(『[^』]*』|「[^」]*」|“[^”]*”)")


def humanize(text: Any) -> Any:
    """把 AI 写的给人看的文字里的英文模式 id / 字段名换成中文；『』「」“” 里面的（标签名、清单名、用户原话）不动。"""
    if not isinstance(text, str) or not text:
        return text
    parts = _QUOTED.split(text)
    for i in range(0, len(parts), 2):          # 偶数下标 = 引号外面
        seg = parts[i]
        for pat, zh in _FIELD_ZH:
            seg = re.sub(pat, zh, seg)
        seg = _MODE_WORD.sub(lambda m: _MODE_ZH[m.group(1)], seg)
        parts[i] = seg
    return "".join(parts)


_SINGLE_TYPE_MODE = {4: ("game", "游戏"), 1: ("book", "书籍"), 6: ("real", "三次元")}


def mode_type_mismatch(spec: SpecV2, text: str) -> Optional[str]:
    """范围全是单独一种非动画作品（游戏 / 书籍 / 三次元），对局模式却还是动画 → 提示（Galgame 除外）。"""
    if spec.game.mode != "anime":
        return None
    types = set()
    for r in spec.ranges:
        if not r.enabled:
            continue
        if r.source.kind != "rank":
            return None
        wf = r.source.work_filter
        if wf is not None and any("galgame" in t.casefold() for t in (wf.tags or [])):
            return None
        types.add(tuple(r.source.subject_types))
    if "gal" in (text or "").casefold() or len(types) != 1:
        return None
    t = next(iter(types))
    if len(t) != 1 or t[0] not in _SINGLE_TYPE_MODE:
        return None
    _, zh = _SINGLE_TYPE_MODE[t[0]]
    return (f"范围里的作品都是{zh}，但对局模式还是动画：猜猜呗里选「{zh}」分类时，格子按{zh}模式算。"
            f"如果你们房间选的是{zh}，把对局模式也改成{zh}。")


# ================================================================ /v2/ai/fill
def _fail(engine_id: str, t0: float, msg: str, code: str = "ai_error", job: Optional[AiJob] = None, **extra) -> Dict[str, Any]:
    out = {"ok": False, "error": msg, "error_code": code, "engine": engine_id,
           "elapsed_ms": round((time.perf_counter() - t0) * 1000), "spec": None, "changes": [], "defaults_used": [],
           "alternative": None, "total": None, "tag_fixes": [], "tag_replaced": []}
    if job is not None:
        out.update(job.timing())
    out.update(extra)
    return out


def _fill_merge(toks: List[str], old: Dict[str, Any], new: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """AI 把一个「设置对象」整个 replace 掉、却只写了一部分字段时：和原来的合并，没写的字段保持原样（规则 2「没说到的不要动」）。
    - game / draw、范围的 source（kind 不变时）/ pick、整个范围：浅合并；
    - pick 换了身份却没写 per_work：去掉 per_work，让解析时按游戏的默认补（只要主角 → 不限；带配角 → 6）；
    - 整个条件：保留原来的 id / enabled / negate，其余用 AI 给的（条件是「一个筛选」，AI 给的就是新的筛选）；
    - 其它（作品本身的标签 work_filter 等）照 RFC 整个替换。"""
    n = len(toks)
    if n == 1 and toks[0] in ("game", "draw"):
        return {**old, **new}
    if n >= 2 and toks[0] in ("ranges", "excludes"):
        if n == 2:
            return {**old, **new}
        if n == 3 and toks[2] == "source":
            return {**old, **new} if new.get("kind", old.get("kind")) == old.get("kind") else None
        if n == 3 and toks[2] == "pick":
            m = {**old, **new}
            if "roles" in new and "per_work" not in new and new.get("roles") != old.get("roles"):
                m.pop("per_work", None)
            return m
        if n == 4 and toks[2] == "conditions":
            keep = {k: old[k] for k in ("id", "enabled", "negate") if k in old}
            return {**keep, **new}
    return None


def _check_whole(d: Any, what: str) -> Dict[str, Any]:
    """AI 给了整份方案（整份 replace，或直接给 {"spec": …}）：必须是完整的（至少有 ranges），
    不然解析时会用默认值补——例：只写了 {"game": …} 会把所有范围和条件都换成默认的。"""
    if not isinstance(d, dict):
        raise AIError(f"AI 改出来的{what}不是一份方案，已丢弃", code="parse")
    if "ranges" not in d:
        raise AIError(f"AI 把{what}整个换成了一份不完整的方案（没有「纳入范围」），这会清掉你现在的范围和条件，已丢弃。"
                      "点「再试一次」重新问", code="parse")
    return d


def _patch(cur_d: Dict[str, Any], ops: Any, what: str) -> Dict[str, Any]:
    for op in (ops if isinstance(ops, list) else [ops]):
        if isinstance(op, dict) and op.get("path") == "" and str(op.get("op") or "").lower() in ("add", "replace"):
            _check_whole(op.get("value"), what)
    try:
        return jsonpatch.apply_patch(cur_d, ops, merge=_fill_merge)
    except jsonpatch.PatchError as e:
        raise AIError(f"AI 给的{'修改' if what == '方案' else what}用不上，已丢弃：" + e.message, code="parse")


def _apply_fill_output(obj: Dict[str, Any], cur_d: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]], List[str], int]:
    """AI 的输出 → (新方案 dict, 另一种理解 {label, spec(dict)} 或 None, 提示, patch 条数（-1 = AI 给的是整份方案）)。
    正常是 {"patch": [...]}；AI 偶尔会直接给整份 {"spec": {...}}，也认（但必须是完整的方案）。"""
    notes: List[str] = []
    if "patch" in obj:
        new_d = _patch(cur_d, obj.get("patch"), "方案")
        n_ops = len(obj["patch"]) if isinstance(obj.get("patch"), list) else 1
    elif isinstance(obj.get("spec"), dict):
        new_d, n_ops = _check_whole(obj["spec"], "方案"), -1
    else:
        raise AIError("AI 的输出里没有 patch（对方案的修改），已丢弃", code="parse")
    if not isinstance(new_d, dict):
        raise AIError("AI 改出来的不是一份方案，已丢弃", code="parse")
    alt = obj.get("alternative")
    alt_out = None
    if isinstance(alt, dict):
        label = str(alt.get("label") or "另一种理解")
        try:
            alt_d = None
            if "patch" in alt:
                alt_d = _patch(cur_d, alt.get("patch"), "「另一种理解」")
            elif isinstance(alt.get("spec"), dict):
                alt_d = _check_whole(alt["spec"], "「另一种理解」")
            if isinstance(alt_d, dict):
                alt_out = {"label": label, "spec": alt_d}
        except AIError as e:
            msg = e.message.replace("点「再试一次」重新问", "").replace("已丢弃", "已丢掉（第一种理解照常用）").rstrip("。 ")
            notes.append(msg + "。")
    return new_d, alt_out, notes, n_ops


def _extra_keys(model: Any, path: str = "", ident: str = "") -> Dict[str, str]:
    """方案（pydantic 模型）里所有「结构里没有的键」：{身份路径: 显示路径}。
    身份路径里数组元素用 id 标识（插入 / 删除条件后下标会变），显示路径用下标（给人看）。"""
    out: Dict[str, str] = {}
    for k in (getattr(model, "model_extra", None) or {}):
        out[f"{ident}/{k}"] = f"{path}/{k}"
    for name in (getattr(type(model), "model_fields", None) or {}):
        v = getattr(model, name, None)
        if isinstance(v, BaseModel):
            out.update(_extra_keys(v, f"{path}/{name}", f"{ident}/{name}"))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                if isinstance(x, BaseModel):
                    out.update(_extra_keys(x, f"{path}/{name}/{i}", f"{ident}/{name}[{getattr(x, 'id', None) or i}]"))
    return out


def _new_unknown_keys(new: SpecV2, cur: SpecV2) -> List[str]:
    """AI 改出来的方案比当前方案多出来的「结构里没有的键」（多半是字段名写错了：例 /ranges/0/source/year）。
    当前方案本身带的未知键（前端保留的）不算。"""
    before = set(_extra_keys(cur))
    return [shown for key, shown in _extra_keys(new).items() if key not in before]


def _touched_per_work(ops: Any, cur: SpecV2) -> set:
    """patch 里明确写了 per_work 的范围 id（没写的话，改身份时按游戏的默认补人数）。"""
    out = set()
    for op in (ops if isinstance(ops, list) else [ops]):
        if not isinstance(op, dict) or not isinstance(op.get("path"), str):
            continue
        toks = op["path"].split("/")[1:]
        if len(toks) < 2 or toks[0] not in ("ranges", "excludes") or not toks[1].isdigit():
            continue
        lst = cur.ranges if toks[0] == "ranges" else cur.excludes
        i = int(toks[1])
        if i >= len(lst):
            continue
        v = op.get("value")
        if (toks[2:] == ["pick", "per_work"]
                or (toks[2:] == ["pick"] and isinstance(v, dict) and "per_work" in v)
                or (len(toks) == 2 and isinstance(v, dict) and isinstance(v.get("pick"), dict) and "per_work" in v["pick"])):
            out.add(lst[i].id)
    return out


def _per_work_follow_roles(new_d: Dict[str, Any], cur: SpecV2, touched: set) -> List[str]:
    """和界面上手动切换一样：身份从「只要主角」改成带配角、AI 又没写人数 → 每部 6 人；改回只要主角 → 不限。返回提示。"""
    notes = []
    old = {r.id: r for r in list(cur.ranges) + list(cur.excludes)}
    for key in ("ranges", "excludes"):
        for r in new_d.get(key) or []:
            if not isinstance(r, dict):
                continue
            o = old.get(r.get("id"))
            pick = r.get("pick")
            if o is None or not isinstance(pick, dict) or r.get("id") in touched:
                continue
            roles = list(pick.get("roles") or ["主角"])
            if roles == list(o.pick.roles):
                continue
            if "配角" in roles and list(o.pick.roles) == ["主角"] and pick.get("per_work") is None:
                pick["per_work"] = 6
                notes.append("带上配角后每部最多 6 人（和游戏一样；你没说人数）")
            elif roles == ["主角"] and "配角" in o.pick.roles and pick.get("per_work") == 6:
                pick["per_work"] = None
                notes.append("只要主角时每部不限人数（和游戏一样；你没说人数）")
    return notes


def _parse_spec_or_ai_error(d: Dict[str, Any], what: str) -> SpecV2:
    try:
        return parse_spec(d)
    except SpecError as e:
        raise AIError(f"AI 改出来的{what}不合格，已丢弃：" + "；".join(e.messages[:5]), code="parse")


def _merge_named(a: List[Dict[str, Any]], b: List[Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
    seen = {(x.get("style"), x.get(key)) for x in a}
    return a + [x for x in b if (x.get("style"), x.get(key)) not in seen]


# 「当前方案」整体的大小上限（压成紧凑 JSON 后的字符数）。默认方案约 400 字，常见方案在几 KB 以内；
# 取 100,000，正常用不会碰到。方案要整份解析、整份放进给 AI 的提示词，所以不能不设上限。
MAX_SPEC_CHARS = 100_000


def spec_too_long(spec_raw: Any) -> bool:
    """方案整体是不是超过 MAX_SPEC_CHARS。（None = 用默认方案，不会超；转不成 JSON 的当作太大。）"""
    if spec_raw is None:
        return False
    try:
        return len(json.dumps(spec_raw, ensure_ascii=False, separators=(",", ":"), default=str)) > MAX_SPEC_CHARS
    except (TypeError, ValueError, RecursionError):
        return True


def fill_job(text: str, spec_raw: Any, engine_id: Optional[str], job: AiJob) -> Dict[str, Any]:
    """一句话填工作台（只调一次 AI）。当前方案本身不合格 → SpecError（非流式接口翻成 422）；没库 → NoDatabase（503）。"""
    t0 = job.t0
    cfg = settings.ai_config()
    engine_id = engine_id or cfg.get("default_engine") or "api"
    text = (text or "").strip()
    if not text:
        return _fail(engine_id, t0, "请先说一句话", code="empty")
    if len(text) > int(cfg.get("max_input_chars") or 500):
        return _fail(engine_id, t0, f"这句话太长了（最多 {cfg.get('max_input_chars')} 个字）", code="too_long")
    if spec_too_long(spec_raw):
        return _fail(engine_id, t0, f"当前方案太长了（最多 {MAX_SPEC_CHARS} 个字）", code="too_long")
    ok, note = engine_ready(engine_id)
    if not ok:
        return _fail(engine_id, t0, note, code="channel")
    cur = parse_spec(spec_raw if spec_raw is not None else default_spec())   # 当前方案本身不合格 → 422
    HUB.current()                                                             # 没库 → 503
    timeout = float(cfg.get("timeout_s") or 120)
    system = fill_system()
    user = fill_user(text, cur)
    calls = 0
    try:
        reply = _call_ai(engine_id, "fill", system, user, timeout, job)
        calls = 1
        obj = extract_json(reply.text)
        new_d, alt_raw, notes, n_ops = _apply_fill_output(obj, spec_to_dict(cur))
        auto_notes = _per_work_follow_roles(new_d, cur, _touched_per_work(obj.get("patch"), cur))
        new = _parse_spec_or_ai_error(new_d, "方案")
        bad = _new_unknown_keys(new, cur)
        if bad:
            raise AIError(f"AI 改了方案里没有的设置「{'、'.join(bad[:3])}」（多半是字段名写错了），这次的修改没法照办，已丢弃。"
                          "点「再试一次」重新问", code="parse")
        alt = None
        if alt_raw is not None:
            try:
                alt_d = alt_raw["spec"]
                alt_ops = (obj.get("alternative") or {}).get("patch") if isinstance(obj.get("alternative"), dict) else None
                _per_work_follow_roles(alt_d, cur, _touched_per_work(alt_ops, cur))
                alt_spec = parse_spec(alt_d)
                bad = _new_unknown_keys(alt_spec, cur)
                if bad:
                    notes.append(f"AI 给的「另一种理解」改了方案里没有的设置「{'、'.join(bad[:3])}」，已丢掉（第一种理解照常用）。")
                else:
                    alt = {"label": alt_raw["label"], "spec": alt_spec}
            except SpecError as e:
                notes.append("AI 给的「另一种理解」格式不对，已丢掉：" + "；".join(e.messages[:2]))
    except AIError as e:
        return _fail(engine_id, t0, e.message, code=e.code, job=job, ai_calls=calls)

    job.status("checking", "后端在核对标签名、算人数")
    new, replaced, fixes = fix_names(new, text)
    alt_replaced: List[Dict[str, Any]] = []
    alt_fixes: List[Dict[str, Any]] = []
    if alt is not None:
        alt["spec"], alt_replaced, alt_fixes = fix_names(alt["spec"], text)

    ev = engine.evaluate(new)
    total = len(ev.pool)
    alternative = None
    if alt:
        alt_ev = engine.evaluate(alt["spec"])
        alt_total = len(alt_ev.pool)
        same = json.dumps(spec_to_dict(alt["spec"]), sort_keys=True) == json.dumps(spec_to_dict(new), sort_keys=True)
        # 另一种理解只在人数不同时才给；它是 0 人（而第一种不是 0 人）时也不给——换过去什么都抽不到，没有意义
        if alt_total != total and not same and not (alt_total == 0 and total > 0):
            alternative = {"label": humanize(alt["label"]), "spec": spec_to_dict(alt["spec"]), "total": alt_total,
                           "sentences": [r.sentence for r in alt_ev.ranges]}
    # 另一种理解最后留下来了，它的标签替换 / 待选才并进来（被丢掉的另一种理解里的名字，不该出现在结果卡上）
    if alternative is not None:
        replaced = _merge_named(replaced, alt_replaced, "from")
        fixes = _merge_named(fixes, alt_fixes, "name")
    warnings = [f["message"] for f in fixes]
    ai_note = humanize(obj.get("note")) if isinstance(obj.get("note"), str) and obj.get("note").strip() else None
    mismatch = mode_type_mismatch(new, text)
    if mismatch:
        warnings.append(mismatch)
    suggestions: List[Dict[str, Any]] = []
    suggestion_note = None
    if total == 0 or total > HUGE_TOTAL:
        suggestions = compute_suggestions(new, total)
        suggestion_note = _template_suggestion(total, suggestions)     # 只用后端模板句，不调 AI
    changes = describe_changes(cur, new, LISTS.get)
    return {
        "ok": True,
        "spec": spec_to_dict(new),
        "changes": changes or ["（方案没有变化）"],
        "defaults_used": [humanize(x) for x in _str_list(obj.get("defaults_used"))] + auto_notes,
        "note": "；".join(x for x in [ai_note, suggestion_note] if x) or None,
        # note 拆开的两半：AI 自己的话 / 后端的放宽收紧模板句（有 suggestions 列表时，界面只显示 AI 的话，免得同一组建议出现两遍）
        "ai_note": ai_note,
        "suggestion_note": suggestion_note,
        "alternative": alternative,
        "total": total,
        "engine": engine_id,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
        # 附加字段：
        "ai_changes": [humanize(x) for x in _str_list(obj.get("changes"))],
        "suggestions": suggestions,
        "sentences": [r.sentence for r in ev.ranges],
        "exclude_sentences": [e.sentence for e in ev.excludes],
        # 求值时引擎也会提示「『X』在库里不存在」：tag_fixes 里已经有同一个名字（带替换按钮），不再重复
        "warnings": warnings + notes + [w for w in ev.warnings if w not in warnings and not
                                        any(f"『{f['name']}』" in w and "不存在" in w for f in fixes)],
        "tag_replaced": replaced,
        "tag_fixes": fixes,
        "patch_ops": n_ops,
        "ai_calls": calls,
        **job.timing(),
    }


def fill(text: str, spec_raw: Any = None, engine_id: Optional[str] = None) -> Dict[str, Any]:
    """非流式（POST /v2/ai/fill）：和流式同一套代码，只是不推进度。"""
    job = AiJob("fill")
    _register(job)
    try:
        return fill_job(text, spec_raw, engine_id, job)
    finally:
        job.done = True
        _unregister(job)


# ================================================================ /v2/ai/ask
def _save_hint(hint: Any, columns: List[str]) -> Optional[Dict[str, str]]:
    if isinstance(hint, dict):
        kind, col = hint.get("kind"), hint.get("id_column")
        if kind in ("character", "work", "tag") and col in columns:
            return {"kind": kind, "id_column": col}
    low = [c.lower() for c in columns]
    if "character_id" in low:
        return {"kind": "character", "id_column": columns[low.index("character_id")]}
    if "subject_id" in low:
        return {"kind": "work", "id_column": columns[low.index("subject_id")]}
    for c in columns:
        if c.lower() in ("tag", "标签", "name") and len(columns) <= 3 and c.lower() != "name":
            return {"kind": "tag", "id_column": c}
    return None


_ASK_MARK = re.compile(r"^[ \t]*(说明|范围|统计范围|存为)[ \t]*[：:][ \t]*", re.M)
_FENCE = re.compile(r"```[ \t]*([A-Za-z]*)[ \t]*\r?\n?(.*?)(?:```|\Z)", re.S)
_SAVE_KIND = {"character": "character", "角色": "character", "char": "character",
              "work": "work", "作品": "work", "subject": "work", "tag": "tag", "标签": "tag"}


def _parse_save(line: str) -> Optional[Dict[str, str]]:
    s = (line or "").strip().strip("`'\"「」")
    if not s or s.lower() in ("无", "none", "null", "no", "—", "-") or s.startswith("无"):
        return None
    parts = [p for p in re.split(r"[\s,，、/:：]+", s) if p]
    if len(parts) < 2:
        return None
    kind = _SAVE_KIND.get(parts[0].lower())
    if not kind:
        return None
    return {"kind": kind, "id_column": parts[1].strip("`'\"「」")}


def parse_ask_output(text: str) -> Dict[str, Any]:
    """AI 的回答 → {explanation, scope_note, sql, save_hint}。
    正常格式是「说明：… / 范围：… / ```sql … ``` / 存为：…」；AI 偶尔会改用 JSON 输出，也认。"""
    s = (text or "").strip()
    if not s:
        raise AIError("AI 没有输出内容", code="parse")
    if s.startswith("{") or s.startswith("```json"):
        try:
            obj = extract_json(s)
            if isinstance(obj.get("sql"), str):
                return {"sql": obj.get("sql"), "explanation": obj.get("explanation") or "",
                        "scope_note": obj.get("scope_note") or "", "save_hint": obj.get("save_hint")}
        except AIError:
            pass
    sql = None
    head, tail = s, ""
    for m in _FENCE.finditer(s):
        lang = (m.group(1) or "").lower()
        body = (m.group(2) or "").strip()
        if lang in ("", "sql", "sqlite") and body:
            sql = body
            head, tail = s[:m.start()], s[m.end():]
            break
    if sql is None:                                # 没有代码块：从第一个 SELECT / WITH 开始，到「存为」为止
        m = re.search(r"(?im)^[ \t]*(select|with)\b", s)
        if m:
            end = _ASK_MARK.search(s, m.start())
            while end is not None and end.group(1) != "存为":
                end = _ASK_MARK.search(s, end.end())
            sql = s[m.start(): end.start() if end else len(s)].strip()
            head, tail = s[:m.start()], (s[end.start():] if end else "")
    sections: Dict[str, str] = {}
    marks = list(_ASK_MARK.finditer(head))
    for i, m in enumerate(marks):
        name = "范围" if m.group(1) == "统计范围" else m.group(1)
        seg = head[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(head)].strip()
        sections.setdefault(name, seg)
    if not marks and head.strip():
        sections["说明"] = head.strip()
    save = None
    for m in _ASK_MARK.finditer(tail):
        if m.group(1) == "存为":
            rest = tail[m.end():]
            save = _parse_save(rest.splitlines()[0] if rest else "")
            break
    if sql:
        sql = sql.strip().rstrip("`").strip()
    return {"sql": sql, "explanation": sections.get("说明", ""), "scope_note": sections.get("范围", ""), "save_hint": save}


def _run_sql(sql: str) -> Dict[str, Any]:
    def go(sn):
        conn = sn.connect()
        try:
            return sqlsafe.run_query(conn, sql, lists=LISTS.all())
        finally:
            conn.close()
    return with_snapshot(go)


# 「让 AI 改」带回来的上一次 SQL 和报错的字数上限：SQL 和 sqlsafe 允许运行的最长语句一致（再长的本来就跑不了，改它没有意义）；
# 报错信息一般一两句，2000 字绰绰有余。这两段都会原样放进给 AI 的提示词。
MAX_FIX_SQL_CHARS = sqlsafe.MAX_SQL_CHARS
MAX_FIX_ERROR_CHARS = 2000


def ask_job(question: str, engine_id: Optional[str], job: AiJob, fix: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """一句话问数据：AI 写说明 + SQL（只调一次），后端立刻自动跑。SQL 报错不自动重试：返回 fixable = true。"""
    t0 = job.t0
    cfg = settings.ai_config()
    engine_id = engine_id or cfg.get("default_engine") or "api"
    base = {"ok": False, "sql": None, "explanation": None, "scope_note": None, "columns": [], "rows": [],
            "truncated": False, "save_hint": None, "engine": engine_id, "fixable": False, "ai_calls": 0}
    question = (question or "").strip()
    if not question:
        return {**base, "error": "请先输入问题", "error_code": "empty", "elapsed_ms": 0}
    if len(question) > int(cfg.get("max_input_chars") or 500):
        return {**base, "error": f"问题太长了（最多 {cfg.get('max_input_chars')} 个字）", "error_code": "too_long", "elapsed_ms": 0}
    if fix is not None and not (fix.get("sql") or "").strip():
        return {**base, "error": "没有要改的 SQL", "error_code": "empty", "elapsed_ms": 0}
    if fix is not None and len(fix.get("sql") or "") > MAX_FIX_SQL_CHARS:
        return {**base, "error": f"要改的 SQL 太长了（最多 {MAX_FIX_SQL_CHARS} 个字）", "error_code": "too_long", "elapsed_ms": 0}
    if fix is not None and len(fix.get("error") or "") > MAX_FIX_ERROR_CHARS:
        return {**base, "error": f"报错信息太长了（最多 {MAX_FIX_ERROR_CHARS} 个字）", "error_code": "too_long", "elapsed_ms": 0}
    ok, note = engine_ready(engine_id)
    if not ok:
        return {**base, "error": note, "error_code": "channel", "elapsed_ms": round((time.perf_counter() - t0) * 1000)}
    timeout = float(cfg.get("timeout_s") or 120)
    snap = HUB.current()
    system = ask_system_cached(snap)
    user = ask_fix_user(question, fix["sql"], fix.get("error") or "") if fix is not None else ask_user(question)
    try:
        reply = _call_ai(engine_id, "ask", system, user, timeout, job)
        base["ai_calls"] = 1
        parsed = parse_ask_output(reply.text)
        sql = parsed.get("sql")
        if not isinstance(sql, str) or not sql.strip():
            why = str(parsed.get("explanation") or "").strip()
            base["explanation"] = why or None
            base["scope_note"] = str(parsed.get("scope_note") or "").strip() or None
            raise AIError("AI 没写 SQL" + (f"，它说：{why}" if why else "，已丢弃"), code="parse")
    except AIError as e:
        return {**base, "error": e.message, "error_code": e.code, "elapsed_ms": round((time.perf_counter() - t0) * 1000),
                **job.timing()}
    sql = sql.strip()
    explanation = str(parsed.get("explanation") or "")
    scope_ai = str(parsed.get("scope_note") or "").strip()
    job.status("sql", "在只读库上跑 SQL")
    try:
        res = _run_sql(sql)
    except sqlsafe.SqlError as e:
        err = e.message + (f"（{e.detail}）" if e.detail and e.detail not in e.message else "")
        return {**base, "sql": sql, "explanation": explanation, "scope_note": scope_ai or None,
                "error": "SQL 运行出错：" + err, "error_code": "sql", "sql_error": err, "fixable": True,
                "sql_ms": None, "fixed_from": (fix or {}).get("sql"),
                "elapsed_ms": round((time.perf_counter() - t0) * 1000), **job.timing()}
    scope = scope_ai or "统计范围：本机出题器数据库收录的条目和角色。"
    facts = scope_facts(snap)
    scope = scope.strip() + "\n" + facts
    return {
        "ok": True, "sql": sql, "explanation": explanation,
        "scope_note": scope, "scope_facts": facts, "columns": res["columns"], "rows": res["rows"], "truncated": res["truncated"],
        "save_hint": _save_hint(parsed.get("save_hint"), res["columns"]), "engine": engine_id,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
        "sql_ms": res["elapsed_ms"], "ai_calls": 1, "fixable": False,
        "fixed_from": (fix or {}).get("sql"),
        **job.timing(),
    }


def ask(question: str, engine_id: Optional[str] = None) -> Dict[str, Any]:
    job = AiJob("ask")
    _register(job)
    try:
        return ask_job(question, engine_id, job)
    finally:
        job.done = True
        _unregister(job)


def ask_fix(question: str, sql: str, error: str, engine_id: Optional[str] = None) -> Dict[str, Any]:
    """「让 AI 改」：把上一次的 SQL 和报错发给 AI，改好后照样自动跑。"""
    job = AiJob("ask")
    _register(job)
    try:
        return ask_job(question, engine_id, job, fix={"sql": sql or "", "error": error or ""})
    finally:
        job.done = True
        _unregister(job)


# ================================================================ SSE（/v2/ai/*/stream）
def sse_pack(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def _error_event(e: BaseException) -> Dict[str, Any]:
    if isinstance(e, NoDatabase):
        return {"code": "no_db", "message": str(e)}
    if isinstance(e, SpecError):
        return {"code": "bad_spec", "message": "方案格式不对：" + "；".join(e.messages), "detail": e.messages}
    if isinstance(e, AIError):
        return {"code": e.code, "message": e.message}
    return {"code": "internal", "message": f"后端出错：{type(e).__name__}: {e}"}


async def sse_events(kind: str, work: Callable[[AiJob], Dict[str, Any]], job_id: Optional[str] = None,
                     keepalive_s: float = 10.0):
    """SSE 事件流。事件：open {job_id} → status {stage, message, ms} / delta {text} … → result {…同非流式的返回…}；
    意外（没库、后端 bug）时 error {code, message}。客户端断开连接 = 取消：杀掉这次正在用的进程。"""
    loop = asyncio.get_running_loop()
    q: "asyncio.Queue[Tuple[str, Any]]" = asyncio.Queue()

    def emit(ev: str, data: Any) -> None:
        try:
            loop.call_soon_threadsafe(q.put_nowait, (ev, data))
        except RuntimeError:          # 事件循环已经关了（后端在退出）
            pass

    job = AiJob(kind, emit=emit, job_id=job_id)
    _register(job)

    def worker() -> None:
        try:
            res = work(job)
            job.emit("result", res)
        except BaseException as e:  # noqa: BLE001
            if not isinstance(e, (NoDatabase, SpecError, AIError)):
                traceback.print_exc()
            job.emit("error", _error_event(e))
        finally:
            job.done = True
            _unregister(job)
            job.emit("__end__", None)

    started = False
    try:
        yield sse_pack("open", {"job_id": job.id, "kind": kind})
        threading.Thread(target=worker, name=f"ai-{kind}-job", daemon=True).start()
        started = True
        while True:
            try:
                ev, data = await asyncio.wait_for(q.get(), timeout=keepalive_s)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
                continue
            if ev == "__end__":
                break
            yield sse_pack(ev, data)
    finally:
        if not started:
            _unregister(job)
        elif not job.done:
            job.cancel()              # 客户端断开 / 取消：杀掉进程（预热池在后台补开）
