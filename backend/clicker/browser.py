# -*- coding: utf-8 -*-
"""连接用户自己的 Chrome（CDP）+ 找对标签页 + 断线重连。

设计要点：
- 连 `http://127.0.0.1:<port>` 而不是 `localhost`（localhost 在部分 Windows 上先解析成 ::1，Chrome 只监听 127.0.0.1，会偶发连不上）。
- 长连接复用：连一次约 0.5–1 秒，自动模式每轮重连太慢；断了（Chrome 关了/崩了）自动重连。
- 选标签页不是取「URL 匹配的第一个」，而是读页面状态打分：优先「弹窗已开 / 我是房主」的页；
  同分时优先前台可见、再优先上次用过的页。
  （同一个房间可能同时开着多个标签页，按顺序取第一个很可能选错。）
- 「CDP 端口是否可用」用纯 HTTP 查 /json/version，不挂 Playwright，前端轮询状态不会打扰浏览器。
- 断线判定：按 Playwright 异常类型 + Browser.is_connected() + 驱动进程是否还活着判断，
  异常文字只做兜底；读页面状态返回结构化结果（ProbeResult）；所有断线统一走 reset()（显式重连路径，清掉旧引用）。
"""
from __future__ import annotations

import asyncio
import base64
import functools
import json
import os
import re
import socket
import struct
import time
import urllib.request
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from .js import JS_PROBE

try:  # playwright 是可选依赖：没装时服务仍能启动，只是点击功能报错
    from playwright.async_api import async_playwright, Browser, Page, Playwright
    from playwright.async_api import TimeoutError as PWTimeout
except Exception:  # pragma: no cover
    async_playwright = None  # type: ignore
    Browser = Page = Playwright = Any  # type: ignore
    PWTimeout = asyncio.TimeoutError  # type: ignore
try:  # 「目标已关闭」的专用异常类型：Playwright 1.41+ 才有，而且只在内部模块里；拿不到就退回看异常文字
    from playwright._impl._errors import TargetClosedError as PWTargetClosed
except Exception:  # pragma: no cover
    PWTargetClosed = None  # type: ignore

# 兜底用的断线文字：老版本 Playwright 没有 TargetClosedError 类型；驱动进程掉了时抛的是普通 Exception
# （"Connection closed while reading from the driver"）。只在类型和连接状态都判断不出来时才看它。
_DISCONNECT_TEXTS = ("Target closed", "Browser has been closed", "Browser closed", "Connection closed",
                     "has been closed", "disconnected")
DISCONNECTED_MSG = "和 Chrome 的连接断了（浏览器被关掉 / 崩溃，或调试连接中断），已重置连接，下次操作会自动重连"
PAGE_CLOSED_MSG = "正在操作的标签页被关掉了"


class FlowError(RuntimeError):
    """可预期的业务错误：带一个机器可读的 code，message 是给人看的中文。"""

    def __init__(self, message: str, code: str = "error", recoverable: bool = False):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


# ---------------------------------------------------------------------------
# 纯 HTTP 探测（不接管浏览器）
# ---------------------------------------------------------------------------
def probe_cdp_http(host: str, port: int, timeout: float = 1.2) -> Dict[str, Any]:
    out: Dict[str, Any] = {"ok": False, "browser": None, "pages": [], "error": None, "error_code": None}
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/json/version", timeout=timeout) as r:
            ver = json.loads(r.read())
        out["ok"] = True
        out["browser"] = ver.get("Browser")
        with urllib.request.urlopen(f"http://{host}:{port}/json/list", timeout=timeout) as r:
            lst = json.loads(r.read())
        out["pages"] = [{"url": p.get("url"), "title": p.get("title")} for p in lst if p.get("type") == "page"]
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        out["error_code"] = _http_error_code(e)
    return out


def _http_error_code(e: BaseException) -> str:
    """HTTP 探测失败的机器可读类别：refused = 端口没人听（Chrome 没用调试端口启动）；
    timeout = 端口在但不回（Chrome 卡住）；error = 其他（例如端口上不是 Chrome）。"""
    for x in (e, getattr(e, "reason", None)):      # urllib 的 URLError 把底层异常放在 reason 里
        if isinstance(x, ConnectionRefusedError):
            return "refused"
        if isinstance(x, (socket.timeout, TimeoutError)):
            return "timeout"
    return "error"


_RULE_SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.\-]*)://")
_DEFAULT_PORT = {"http": 80, "https": 443}


@functools.lru_cache(maxsize=256)
def _parse_rule(rule: str) -> Optional[Tuple[Optional[str], str, Optional[int], str]]:
    """把一条房间页规则拆成 (协议, 主机, 端口, 路径前缀)。写法：`主机[:端口][/路径前缀]`，前面可以加 `http://` 或 `https://`。
    协议没写 = http 和 https 都行；端口没写 = 页面所用协议的默认端口。没有主机的规则（例如只写了一段路径）无效，返回 None：
    只有路径的规则会匹配到任何网站。"""
    s = (rule or "").strip()
    m = _RULE_SCHEME.match(s)
    scheme = m.group(1).lower() if m else None
    if not s or scheme not in (None, "http", "https"):
        return None
    try:
        u = urlparse(s if m else "//" + s)
        host, port = u.hostname, u.port
    except ValueError:
        return None
    if not host:
        return None
    return scheme, host.lower(), port, (u.path or "").lower()


def _split_page_url(url: str) -> Optional[Tuple[str, str, int, str]]:
    """标签页地址 → (协议, 主机, 端口, 路径)。不是 http / https 页面（chrome://、about:blank、file: 等）返回 None。"""
    try:
        u = urlparse((url or "").strip())
        host, port = u.hostname, u.port
    except ValueError:
        return None
    scheme = u.scheme.lower()
    if scheme not in _DEFAULT_PORT or not host:
        return None
    return scheme, host.lower(), port or _DEFAULT_PORT[scheme], (u.path or "/").lower()


def url_matches(url: str, patterns: List[str]) -> bool:
    """标签页地址是不是某条房间页规则指向的页面。把地址解析开，严格比较协议、主机、端口，路径按前缀比较；
    不把规则当整串子串去找，否则 `evil.com/?x=ccb.baka.website/multiplayer/`、`ccb.baka.website.evil.com/multiplayer/` 这类
    别的网站的地址也会被当成游戏页。主机和路径不分大小写；路径前缀按目录边界比较（`/multiplayer` 匹配 `/multiplayer/x`，
    不匹配 `/multiplayer2`）；查询串和 # 后面的部分不参与比较。"""
    page = _split_page_url(url)
    if page is None:
        return False
    scheme, host, port, path = page
    for p in patterns:
        rule = _parse_rule(p) if isinstance(p, str) else None
        if rule is None:
            continue
        r_scheme, r_host, r_port, r_path = rule
        if r_scheme not in (None, scheme) or r_host != host or (_DEFAULT_PORT[scheme] if r_port is None else r_port) != port:
            continue
        if not r_path or r_path == "/" or path == r_path or path.startswith(r_path if r_path.endswith("/") else r_path + "/"):
            return True
    return False


def _ws_eval(ws_url: str, timeout: float = 1.5) -> bool:
    """最小 WebSocket 客户端（标准库）：对一个页面发 Runtime.evaluate("1")，看它 timeout 秒内回不回。

    用途：Playwright 的 connect_over_cdp 会等所有标签页初始化；只要有一个标签页被 alert() 卡住
    （例如：房间 5 分钟无操作被服务器关闭 → 游戏弹 alert → 那个标签页再也不响应 CDP），
    整个连接就会超时。这里逐个页面体检，把卡住的标签页指给用户看。
    """
    CRLF = "\r\n"
    u = urlparse(ws_url)
    try:
        sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
    except Exception:
        return False
    try:
        sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = CRLF.join([
            f"GET {u.path} HTTP/1.1", f"Host: {u.hostname}:{u.port}", "Upgrade: websocket",
            "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13", "", ""])
        sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                return False
            buf += chunk
        if b" 101 " not in buf.split(b"\r\n", 1)[0]:
            return False
        payload = json.dumps({"id": 1, "method": "Runtime.evaluate",
                              "params": {"expression": "1", "returnByValue": True}}).encode()
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        deadline = time.time() + timeout
        data = buf.split(b"\r\n\r\n", 1)[1]
        while time.time() < deadline:
            if b'"id":1' in data:
                return True
            chunk = sock.recv(65536)
            if not chunk:
                return False
            data += chunk
        return False
    except Exception:
        return False
    finally:
        try:
            sock.close()
        except Exception:
            pass


def find_stuck_pages(host: str, port: int, timeout: float = 1.5) -> List[str]:
    """返回不响应 CDP 的标签页 URL 列表（多半是弹着 alert 没点掉）。"""
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/json/list", timeout=2) as r:
            lst = json.loads(r.read())
    except Exception:
        return []
    stuck = []
    for t in lst:
        if t.get("type") != "page" or not t.get("webSocketDebuggerUrl"):
            continue
        if not _ws_eval(t["webSocketDebuggerUrl"], timeout):
            stuck.append(t.get("url") or "?")
    return stuck


# ---------------------------------------------------------------------------
# 页面角色判定 + 打分
# ---------------------------------------------------------------------------
def page_role(p: Optional[dict]) -> str:
    """把 JS_PROBE 的结果归成一个角色名（给 UI 和选页用）。"""
    if not p:
        return "unknown"
    if not p.get("joined"):
        return "not_joined"
    if p.get("popup") is not None:
        return "setter"                      # 出题弹窗开着（我是被指定的出题人）
    if p.get("hasPlayerList"):
        if p.get("isGameStarted"):
            if p.get("answerSetterView"):
                return "setter_ingame"       # 本局我出的题，正在看别人猜
            if p.get("gameSearch"):
                return "guesser"
            return "observer"
        return "host_lobby" if p.get("isHost") else "guest_lobby"
    if p.get("gameSearch"):
        return "single"                      # 单人模式页
    return "unknown"


_SCORES = {
    "host": {"setter": 100, "host_lobby": 80, "setter_ingame": 40, "guesser": 15, "observer": 15,
             "guest_lobby": 10, "single": 0, "not_joined": 1, "unknown": 0},
}


def score_page(mode: str, probe: Optional[dict], is_last: bool) -> float:
    role = page_role(probe)
    s = float(_SCORES.get(mode, _SCORES["host"]).get(role, 0))
    if probe:
        if probe.get("visible"):
            s += 5
        if probe.get("focus"):
            s += 3
    if is_last:
        s += 2
    return s


@dataclass
class ProbeResult:
    """读页面状态（JS_PROBE）的结构化结果：data 有值 = 读到了；否则 error 说明为什么没读到。

    error 取值：
      timeout      —— 连接还在，但页面 3 秒内没回（页面卡住 / 还在加载 / 弹着提示框）
      page_closed  —— 这个标签页已经关掉了（浏览器连接还在）
      disconnected —— 和 Chrome 的连接没了（浏览器被关掉 / 崩溃、调试连接中断、Playwright 驱动进程没了）
      error        —— 其他（页面脚本报错、页面正在跳转导致执行环境被销毁等，一般过一会儿就好）
    """
    data: Optional[dict] = None
    error: Optional[str] = None
    detail: str = ""


async def _stop_driver(pw: Any, timeout: float = 4.0) -> None:
    """停掉 Playwright 驱动（node 子进程）。正常最多等 timeout 秒；驱动卡死时强制结束子进程，
    并让所有挂起的调用立刻收到「连接已关闭」（用到 Playwright 内部属性，拿不到就算了）。"""
    try:
        await asyncio.wait_for(pw.stop(), timeout=timeout)
        return
    except asyncio.CancelledError:
        raise
    except Exception:
        pass
    try:
        conn = pw._impl_obj._connection
        try:
            conn._transport._proc.kill()
        except Exception:
            pass
        conn.cleanup("Playwright 驱动被强制结束")
    except Exception:
        pass


class BrowserManager:
    def __init__(self, host: str, port: int, patterns: Dict[str, List[str]],
                 log: Callable[[str, str], None]):
        self.host = host
        self.port = int(port)
        self.patterns = patterns             # {"host": [...]}
        self.log = log
        self._pw: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._lock = asyncio.Lock()
        self.last_page_url: Optional[str] = None
        self.last_used_at: float = 0.0
        # 连着的时候，游戏房间页弹出的 alert/confirm 都在这里记一笔并自动点确定（否则页面会一直卡在提示框上）；
        # 其他标签页的提示框不记、不点，留给用户自己处理
        self.dialogs: Deque[Dict[str, Any]] = deque(maxlen=50)
        self._last_pick_sig: Any = None
        self.resets = 0                      # reset() 真正丢掉过连接的次数（调试用）

    # ---------------- 连接 ----------------
    @property
    def connected(self) -> bool:
        """真的还连着：Browser 自己说连着，而且 Playwright 驱动进程还活着
        （驱动死了时没人发「断开」事件，Browser.is_connected() 会一直是 True）。"""
        try:
            return bool(self._browser and self._browser.is_connected()) and not self.driver_dead()
        except Exception:
            return False

    def driver_dead(self) -> bool:
        """Playwright 驱动（node 子进程）是不是已经没了。驱动一死，所有调用都会立刻抛普通 Exception，
        只重连浏览器没用，必须连驱动一起重启（reset(hard=True)）。
        读的是 Playwright 内部属性；读不到就当它活着，交给异常文字兜底。"""
        pw = self._pw
        if pw is None:
            return False
        try:
            conn = pw._impl_obj._connection
            if getattr(conn, "_closed_error", None) is not None:
                return True
            return bool(conn._transport.on_error_future.done())
        except Exception:
            return False

    async def ensure(self) -> "Browser":
        if async_playwright is None:
            raise FlowError("后端 Python 环境没装 playwright（pip install playwright）", code="no_playwright")
        async with self._lock:
            if self.connected:
                return self._browser  # type: ignore[return-value]
            if self._browser is not None or self.driver_dead():
                # 旧连接已经失效（浏览器关了 / 崩了、驱动没了）：先走统一的重置路径清掉旧引用，再重新连
                await self._reset_locked("旧连接已失效，重新连接", hard=self.driver_dead())
            info = await asyncio.to_thread(probe_cdp_http, self.host, self.port)
            if not info["ok"]:
                raise FlowError(
                    f"连不上 Chrome 调试端口 {self.host}:{self.port}。请先启动带调试端口的 Chrome"
                    f"（Windows：scripts\\launch-guessr-chrome.bat；macOS / Linux：scripts/launch-guessr-chrome.sh），"
                    f"普通方式打开的 Chrome 没有这个端口。详情：{info['error']}",
                    code="cdp_unreachable", recoverable=True)
            if self._pw is None:
                self._pw = await async_playwright().start()
            t0 = time.time()
            try:
                self._browser = await self._pw.chromium.connect_over_cdp(
                    f"http://{self.host}:{self.port}", timeout=15000)
            except Exception as e:
                stuck = await asyncio.to_thread(find_stuck_pages, self.host, self.port)
                if stuck:
                    raise FlowError(
                        "Chrome 里有标签页没有响应（多半弹着提示框没点掉，例如「房间已关闭」），导致接不上浏览器。"
                        "请切到这些标签页点掉提示框或关掉它们：" + "；".join(stuck[:5]),
                        code="page_stuck", recoverable=True)
                raise FlowError(f"CDP 端口在，但 Playwright 接不上：{str(e).splitlines()[0]}",
                                code="cdp_connect_failed", recoverable=True)
            b = self._browser
            b.on("disconnected", lambda *_: self._on_disconnected(b))
            for ctx in self._browser.contexts:
                self._watch_context(ctx)
            self.log("info", f"已接上 Chrome（{info.get('browser')}，{(time.time() - t0) * 1000:.0f}ms）")
            return self._browser

    def _on_disconnected(self, b: Any) -> None:
        # 我们自己断开 / 重置时会先把 self._browser 清掉；只有「不是我们断的」才提示用户
        if self._browser is b:
            self.log("warn", "Chrome 连接断开（浏览器被关闭或崩溃），下次操作会自动重连")

    def _is_game_url(self, url: str) -> bool:
        """这个地址是不是游戏房间页（和选页用的是同一批规则）。"""
        return url_matches(url, [p for pats in self.patterns.values() for p in (pats or [])])

    def _watch_context(self, ctx: Any) -> None:
        # Playwright 对提示框的处理：
        #   - 整个浏览器上下文和这个页面都没有 dialog 监听：Playwright 自己把它关掉（alert 直接关，confirm 当「取消」，prompt 当 null）；
        #   - 只要有监听，Playwright 就不再自动处理：提示框一直开着、页面脚本一直停着，直到有人点掉。
        # 所以这里在上下文上挂监听，但只对游戏房间页调用 accept()。别的标签页的提示框不碰：
        # 有这个监听在，Playwright 不会替用户把它们取消掉，它们和平时一样显示在 Chrome 里，由用户自己点。
        # 点击器只会对游戏房间页选页、读状态、点击，不会去等那些标签页，它们不会拖住点击器。
        async def on_dialog(d: Any) -> None:
            url, pg = "", None
            try:
                pg = d.page
                url = pg.url if pg else ""
            except Exception:
                pass
            if not self._is_game_url(url):
                try:
                    where = urlparse(url).hostname or "未知页面"
                except ValueError:
                    where = "未知页面"
                self.log("warn", f"其他标签页（{where}）弹出了提示框，没有自动点确定，请你自己处理")
                return
            self.dialogs.append({"ts": time.time(), "url": url, "page": pg, "msg": d.message, "type": d.type})
            self.log("warn", f"游戏页面弹出提示框：「{d.message}」（已自动点确定）")
            try:
                await d.accept()
            except Exception:
                pass
        try:
            ctx.on("dialog", on_dialog)
        except Exception:
            pass

    def dialogs_since(self, ts: float, page: Any = None) -> List[str]:
        """某个标签页在 ts 之后弹过的提示框。按页面对象判断归属（同一房间的多个标签页 URL 完全相同）。"""
        out = []
        for d in list(self.dialogs):
            if d["ts"] < ts:
                continue
            if page is not None and d.get("page") is not None and d["page"] is not page:
                continue
            out.append(d["msg"])
        return out

    async def disconnect(self, reason: str = "") -> None:
        """正常断开（空闲断开 / 关服）。连接出问题时不要用它，用 reset()。"""
        async with self._lock:
            b, self._browser = self._browser, None
            if b is not None:
                try:
                    # connect_over_cdp 的 close = 断开连接，不会关掉用户的 Chrome
                    await asyncio.wait_for(b.close(), timeout=5.0)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass
                if reason:
                    self.log("debug", f"已断开 Chrome 连接（{reason}）")

    async def reset(self, reason: str, hard: bool = False) -> None:
        """显式重连路径：所有「连接断了 / 连接卡死」都走这里。丢掉旧的 Browser 引用
        （hard=True 时连 Playwright 驱动一起重启），清掉和旧连接绑定的东西；下次 ensure() 会重新连接。
        不会关掉用户的 Chrome（CDP 连接的 close 只是断开）。旧连接上还挂着的调用会立刻失败。"""
        async with self._lock:
            await self._reset_locked(reason, hard)

    async def _reset_locked(self, reason: str, hard: bool) -> None:
        if self._browser is None and (not hard or self._pw is None):
            return                                   # 已经是断开状态，没什么可丢的
        b, self._browser = self._browser, None
        pw: Any = None
        if hard:
            pw, self._pw = self._pw, None
        self._last_pick_sig = None
        self.dialogs.clear()                         # 记录里存的是旧连接的 Page 对象
        self.resets += 1
        self.log("warn", f"重置浏览器连接：{reason}" + ("（连 Playwright 驱动一起重启）" if hard else "")
                 + "；下次操作会自动重连")
        if b is not None:
            try:
                await asyncio.wait_for(b.close(), timeout=5.0)   # 连接早就断了时会立刻返回或报错，忽略
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
        if pw is not None:
            await _stop_driver(pw)

    async def classify(self, e: BaseException, page: Any = None) -> str:
        """把 Playwright 操作抛出的异常分成 disconnected / page_closed / timeout / error（含义见 ProbeResult）。
        先看异常类型和连接状态（Browser.is_connected()、驱动进程是否还活着），异常文字只做兜底。"""
        if isinstance(e, FlowError):
            return {"browser_disconnected": "disconnected", "page_closed": "page_closed"}.get(e.code, "error")
        target_closed = PWTargetClosed is not None and isinstance(e, PWTargetClosed)
        if target_closed:
            # 「目标已关闭」既可能只是这个标签页关了，也可能是整个浏览器断了。浏览器的「断开」事件和这个错误
            # 走同一条管道、可能比错误晚到一点：先让出一下事件循环，等事件处理完再看连接状态
            await asyncio.sleep(0.05)
        if self.driver_dead():
            return "disconnected"
        b = self._browser
        if b is None:
            # 连接已经被别处重置掉了（旧页面上的调用都会失败）
            if target_closed:
                return "disconnected"
            return "timeout" if isinstance(e, (asyncio.TimeoutError, PWTimeout)) else "error"
        try:
            alive = bool(b.is_connected())
        except Exception:
            alive = False
        if not alive:
            return "disconnected"
        if target_closed:
            return "page_closed"                     # 浏览器还连着：只是这个标签页关了（或正在关）
        if isinstance(e, (asyncio.TimeoutError, PWTimeout)):
            return "timeout"
        if any(k in str(e) for k in _DISCONNECT_TEXTS):
            return "disconnected"                    # 兜底：类型和状态都看不出来时才看文字
        return "error"

    async def recover(self, e: BaseException, where: str, page: Any = None) -> str:
        """页面操作抛异常后调用：判断是不是断线，是就走 reset()（统一的重连路径）。返回分类。"""
        kind = await self.classify(e, page)
        if kind == "disconnected":
            await self.reset(f"{where}发现连接断了（{type(e).__name__}）", hard=self.driver_dead())
        return kind

    async def shutdown(self) -> None:
        await self.disconnect("服务关闭")
        pw, self._pw = self._pw, None
        if pw is not None:
            await _stop_driver(pw)

    # ---------------- 页面 ----------------
    def _all_pages(self) -> List["Page"]:
        out: List[Page] = []
        if not self._browser:
            return out
        for ctx in self._browser.contexts:
            for pg in ctx.pages:
                out.append(pg)
        return out

    async def probe_ex(self, page: "Page", timeout: float = 3.0) -> ProbeResult:
        """读页面状态；失败时返回结构化原因（不抛异常），
        让上层分得清「页面暂时没回」和「连接已经断了」，不用傻等到各步骤超时。"""
        try:
            d = await asyncio.wait_for(page.evaluate(JS_PROBE), timeout=timeout)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            first = (str(e).splitlines() or [""])[0][:160]
            return ProbeResult(error=await self.classify(e, page), detail=f"{type(e).__name__}: {first}")
        if not isinstance(d, dict):
            return ProbeResult(error="error", detail=f"页面脚本返回了 {type(d).__name__}")
        return ProbeResult(data=d)

    async def probe(self, page: "Page", timeout: float = 3.0) -> Optional[dict]:
        """给流程用：读到返回 dict；暂时读不到（超时 / 页面在跳转）返回 None，调用方继续轮询；
        标签页关了、连接断了直接抛 FlowError（不傻等到超时），断线时顺手走 reset() 清掉旧连接。"""
        r = await self.probe_ex(page, timeout)
        if r.data is not None:
            return r.data
        if r.error == "disconnected":
            await self.reset(f"读页面状态时发现连接断了（{r.detail}）", hard=self.driver_dead())
            raise FlowError(DISCONNECTED_MSG, code="browser_disconnected", recoverable=True)
        if r.error == "page_closed":
            raise FlowError(PAGE_CLOSED_MSG, code="page_closed", recoverable=True)
        return None

    async def pick_page(self, mode: str) -> Tuple["Page", dict, str]:
        """按模式挑最合适的猜猜呗标签页。返回 (page, probe, role)。"""
        await self.ensure()
        pats = self.patterns.get(mode) or self.patterns.get("host") or []
        pages = [p for p in self._all_pages() if url_matches(p.url, pats)]
        if not pages:
            if not self.connected:           # 刚连上又断了（例如 Chrome 正在退出）：别报成「没找到房间页」
                await self.reset("选标签页时发现连接断了", hard=self.driver_dead())
                raise FlowError(DISCONNECTED_MSG, code="browser_disconnected", recoverable=True)
            urls = [p.url for p in self._all_pages() if p.url.startswith("http")][:6]
            raise FlowError(
                "Chrome 里没找到猜猜呗房间页（匹配规则：" + " / ".join(pats[:4]) + "）。"
                + ("当前打开的是：" + "；".join(urls) if urls else "当前没有打开任何网页。"),
                code="no_page", recoverable=True)
        results = await asyncio.gather(*(self.probe_ex(p) for p in pages))
        bad = next((r for r in results if r.error == "disconnected"), None)
        if bad is not None:
            await self.reset(f"选标签页时发现连接断了（{bad.detail}）", hard=self.driver_dead())
            raise FlowError(DISCONNECTED_MSG, code="browser_disconnected", recoverable=True)
        scored: List[Tuple[float, int, Page, ProbeResult]] = []
        for i, (p, r) in enumerate(zip(pages, results)):
            if r.error == "page_closed":
                continue                     # 这个标签页刚好被关掉了：不参与挑选
            scored.append((score_page(mode, r.data, p.url == self.last_page_url), -i, p, r))
        if not scored:
            raise FlowError("匹配的房间页刚刚都被关掉了", code="page_closed", recoverable=True)
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        best_score, _, page, best = scored[0]
        pr = best.data
        if pr is None:
            why = {"timeout": "页面 3 秒内没响应（在加载，或弹着提示框）",
                   "error": "页面脚本报错（可能正在跳转）"}.get(best.error or "", best.error or "")
            raise FlowError(f"找到了房间页，但读不到页面状态（页面还在加载？）：{why}", code="probe_failed", recoverable=True)
        role = page_role(pr)
        sig = (page.url, role, len(pages))
        if len(pages) > 1 and sig != self._last_pick_sig:
            self.log("debug", f"{len(pages)} 个候选标签页，选中得分最高的（{role}，{best_score:.0f} 分）：{page.url}")
        self._last_pick_sig = sig
        self.last_page_url = page.url
        self.last_used_at = time.time()
        return page, pr, role
