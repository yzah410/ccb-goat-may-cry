# -*- coding: utf-8 -*-
"""AI 的 API 通道：后端直接向服务商的接口发流式请求，只用标准库（urllib）。设置在 v2.ai.api，网页「设置 → AI」里改。

- 两种协议：
  - openai：POST {base_url}/chat/completions。OpenAI 兼容接口，大多数服务商和本机的 Ollama / LM Studio 都是这种。
  - anthropic：POST {base_url}/v1/messages，Anthropic 的接口。base_url 不填就用 https://api.anthropic.com。
- 请求体只放必需的字段：模型、system + user 两条消息、stream；max_tokens 配置了才放（anthropic 协议必须有，默认 4096）。
  temperature、response_format 这类参数各家支持得不一样，传了对方不认的参数会直接报错，所以都不传。
- base_url 只去掉末尾的 / 和误粘进来的 /chat/completions、/v1/messages，不自动补 /v1：各家的路径不一样
  （例如智谱是 /api/paas/v4），补错了反而连不上。
- 代理：urllib 读 HTTPS_PROXY / HTTP_PROXY 环境变量；本机地址（127.0.0.1 / localhost / ::1）不走代理。
- 不跟随跳转（3xx）：跟过去的话 Authorization / x-api-key 会一起发到跳转后的地址，所以直接报错，让用户填跳转后的地址。
- 取消：job.attach() 拿到的对象 kill() 时直接关掉这次请求的 socket，正在阻塞的读马上返回。
  socket 在连接之前就交给它：TCP 连接、代理的 CONNECT、TLS 握手进行中也能取消。
- 超时：总时长 v2.ai.timeout_s。收到回答的第一个字节之后，连续 v2.ai.stall_s 秒一个字节都没收到 → 当成卡住了，中止；
  第一个字节之前只看总时长（推理模型可能先想很久才开始输出）。
- 回答因为 max_tokens 被截断、或者连接在回答结束前断了，都直接报出来，不等到后面解析失败。
- 报错是中文，带 HTTP 状态码和服务商自己的说明（截到约 300 字）。完整的 API key 不出现在报错里，换成「…后 4 位」：
  先替换再截短，key 的转义写法（例如 repr 里的 \\n）也替换。
"""
from __future__ import annotations

import errno
import http.client
import json
import os
import select
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from . import settings
from .ai import AIError, AiJob, AiReply

PROTOCOLS = ("openai", "anthropic")
ANTHROPIC_BASE = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_MAX_TOKENS = 4096
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")
MSG_CHARS = 300                 # 服务商的报错说明最多留这么多字
MAX_BODY = 4_000_000            # 非流式返回 / 报错正文最多读这么多字节
USER_AGENT = "outsetter"
NOT_CONFIGURED = "还没设置 AI 接口：在「设置 → AI」里填接口地址、模型和 API key"
BAD_KEY = "API key 里有不能用的字符（空格、换行或非英文字符），请检查"
TRUNCATED = "回答被截断了（达到 max_tokens 上限）。把 backend/config.json 里 \"api\" 那一段的 max_tokens 设大一些再试"
ENDED_EARLY = "回答没收完：接口的连接在回答结束前断了。点「再试一次」重新问"
KEY_CHANGED = "接口地址换了，原来的 API key 已清掉，请重新填"
ENV_KEY_MOVES = (f"API key 来自环境变量 {settings.API_KEY_ENV}，换了接口地址后它也会发到新地址；"
                 "不想这样就先取消这个环境变量")
REDIRECT_CODES = (301, 302, 303, 307, 308)

# 网页上的服务商预设（id 和 web/src/features/ai/providers.ts 一致）→（显示名，接口域名）。
# 只用来显示名字：接口地址的域名和预设对不上时（例如改成了别的地址），显示域名。
PRESETS: Dict[str, Tuple[str, str]] = {
    "deepseek": ("DeepSeek", "api.deepseek.com"),
    "dashscope": ("阿里云百炼", "dashscope.aliyuncs.com"),
    "moonshot": ("Kimi", "api.moonshot.cn"),
    "zhipu": ("智谱", "open.bigmodel.cn"),
    "siliconflow": ("硅基流动", "api.siliconflow.cn"),
    "openai": ("OpenAI", "api.openai.com"),
    "gemini": ("Gemini", "generativelanguage.googleapis.com"),
    "anthropic": ("Anthropic", "api.anthropic.com"),
    "openrouter": ("OpenRouter", "openrouter.ai"),
    "ollama": ("Ollama", "127.0.0.1"),
    "lmstudio": ("LM Studio", "127.0.0.1"),
}


# ================================================================ 地址、key、显示名
def normalize_base_url(url: Any, protocol: str = "openai") -> str:
    """去掉首尾空白、末尾的 /、误粘进来的 /chat/completions 或 /v1/messages。
    anthropic 协议的请求路径自带 /v1，所以末尾的 /v1 也去掉；没填就用官方地址。"""
    u = str(url or "").strip().rstrip("/")
    for tail in ("/chat/completions", "/v1/messages"):
        if u.lower().endswith(tail):
            u = u[: -len(tail)].rstrip("/")
    if protocol == "anthropic":
        if u.lower().endswith("/v1"):
            u = u[:-3].rstrip("/")
        return u or ANTHROPIC_BASE
    return u


def host_of(url: Any) -> str:
    try:
        return (urlparse(str(url or "")).hostname or "").lower()
    except ValueError:
        return ""


def origin_of(url: Any) -> Tuple[str, str, int]:
    """（协议, 域名, 端口）。判断「还是不是同一个接口地址」用：协议、域名、端口有一个不同就算换了地址。没写端口按协议的默认端口算。"""
    try:
        p = urlparse(str(url or "").strip())
        scheme = (p.scheme or "").lower()
        port = p.port or (443 if scheme == "https" else 80 if scheme == "http" else 0)
        return scheme, (p.hostname or "").lower(), port
    except ValueError:
        return "", "", 0


def origin_text(url: Any) -> str:
    """协议 + 域名（+ 端口），给人看；不带路径和参数。"""
    scheme, host, port = origin_of(url)
    if not scheme or not host:
        return ""
    h = f"[{host}]" if ":" in host else host
    default = 443 if scheme == "https" else 80
    return f"{scheme}://{h}" + ("" if port == default else f":{port}")


def _bad_chars(s: str) -> bool:
    """控制字符、单独的代理码元（写不进 UTF-8）。"""
    return any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in s)


def is_local(url: Any) -> bool:
    return host_of(url) in LOCAL_HOSTS


def key_hint(key: str) -> str:
    """「…后 4 位」。key 太短时只给「…」：后 4 位就是整个 key 的一大半了。"""
    if not key:
        return ""
    return "…" + key[-4:] if len(key) >= 8 else "…"


def _key_forms(key: str) -> List[str]:
    """key 在报错文字里可能出现的写法：原样、repr / JSON 转义后（换行变成 \\n）、bytes 的 repr、空白合并后。长的先换。"""
    forms = {key, repr(key)[1:-1], json.dumps(key)[1:-1], json.dumps(key, ensure_ascii=False)[1:-1], " ".join(key.split()),
             repr(key.encode("utf-8", "backslashreplace"))[2:-1]}
    return sorted((f for f in forms if f), key=len, reverse=True)


def redact(text: Any, key: str) -> str:
    s = str(text or "")
    if not key:
        return s
    hint = key_hint(key)
    for f in _key_forms(key):
        s = s.replace(f, hint)
    return s


def _safe(text: Any, key: str, n: int = MSG_CHARS) -> str:
    """先把 key 换掉再截短：反过来的话，截短时合并的空白和截断位置都可能让 key 认不出来。"""
    return _clip(redact(text, key), n)


def check_url(base_url: Any) -> Optional[str]:
    """接口地址的格式问题（一句中文）；没问题返回 None。"""
    u = str(base_url or "").strip()
    if not u.lower().startswith(("http://", "https://")):
        return "接口地址要以 http:// 或 https:// 开头"
    if len(u) > 500 or any(c.isspace() for c in u):
        return "接口地址不能有空格，最长 500 个字"
    if _bad_chars(u):
        return "接口地址里有不能用的字符"
    if "\\" in u:
        return "接口地址里不能有反斜杠 \\"
    if "?" in u:
        return "接口地址里不要带 ? 参数"
    if "#" in u:
        return "接口地址里不要带 # 和后面的内容"
    try:
        p = urlparse(u)
        p.port                                 # 端口不是数字、超出范围时抛 ValueError
    except ValueError:
        return "接口地址的端口不对"
    if "@" in p.netloc:
        return "接口地址里不要带用户名或密码（@ 和它前面的部分）"
    if not p.hostname:
        return "接口地址里没有域名或 IP"
    return None


def check_key(key: Any) -> Optional[str]:
    if not isinstance(key, str):
        return "API key 要是一段文字"
    if len(key) > 500:
        return "API key 太长了（最多 500 个字）"
    if any(c.isspace() for c in key):
        return "API key 里不能有空格或换行"
    if any(not (33 <= ord(c) <= 126) for c in key):
        return "API key 只能有英文字母、数字和符号"
    return None


def bad_key_message(a: Dict[str, Any]) -> str:
    return BAD_KEY + (f"（key 来自环境变量 {settings.API_KEY_ENV}）" if a.get("key_from_env") else "")


def configured(a: Dict[str, Any]) -> Tuple[bool, str]:
    """设置齐了没有：有接口地址和模型，并且有 key（本机地址可以没有 key）；地址和 key 的格式也要对。"""
    base = normalize_base_url(a.get("base_url"), str(a.get("protocol") or "openai"))
    if not base or not str(a.get("model") or "").strip():
        return False, NOT_CONFIGURED
    err = check_url(base)
    if err:
        return False, f"AI 接口地址有问题：{err}，在「设置 → AI」里改"
    key = str(a.get("api_key") or "")
    if not key and not is_local(base):
        return False, NOT_CONFIGURED
    if key and check_key(key):
        return False, bad_key_message(a)
    return True, f"已设置（{host_of(base) or base}）"


def api_ready(a: Dict[str, Any]) -> Tuple[bool, str]:
    """输入条用的判断（AI 状态、真正发请求前）：config.json 读不出来时直接说文件的问题，
    不能说成「还没设置」（读不出来时设置按空的处理）；读得出来就按 configured 判断。"""
    broken = config_file_error()
    if broken:
        return False, broken
    return configured(a)


def label(a: Dict[str, Any]) -> str:
    """引擎的显示名：预设的名字；接口域名和预设对不上（或是自定义）时用域名。"""
    base = normalize_base_url(a.get("base_url"), str(a.get("protocol") or "openai"))
    host = host_of(base)
    p = PRESETS.get(str(a.get("preset") or ""))
    if p and (host == p[1] or (host in LOCAL_HOSTS and p[1] in LOCAL_HOSTS)):
        return p[0]
    return host or "AI 接口"


def public_config() -> Dict[str, Any]:
    """GET /v2/ai/config 的返回：不含 key，只说有没有、后 4 位、是不是来自环境变量；
    configured / problem：按现在的设置能不能用、不能用的原因（和 /v2/ai/status 里 api 的判断一样）。"""
    a = settings.api_config()
    key = a["api_key"]
    ok, note = configured(a)
    return {"protocol": a.get("protocol") or "openai", "preset": a.get("preset"), "base_url": a.get("base_url") or "",
            "model": a.get("model") or "", "max_tokens": a.get("max_tokens"), "has_key": bool(key),
            "key_hint": key_hint(key), "key_from_env": bool(a["key_from_env"]),
            "configured": ok, "problem": None if ok else note}


def config_file_error(saving: bool = False) -> Optional[str]:
    """config.json 存在但读不出来时给人看的说明（GET 和 PUT 用同一句）；读得出来返回 None。"""
    detail = settings.config_problem()
    if detail is None:
        return None
    mid = "，没有保存。先修好或删掉它" if saving else "，先修好或删掉它"
    return f"{settings.config_label()} 读不出来（不是合法的 JSON）{mid}：{_clip(detail, 200)}"


# ================================================================ 改设置（PUT /v2/ai/config）、表单里的设置（测试 / 列出模型）
class ConfigError(Exception):
    def __init__(self, message: str, code: str = "bad_ai_config", status: int = 422):
        self.message = message
        self.code = code
        self.status = status
        super().__init__(message)


def _form_fields(body: Dict[str, Any], cur: Dict[str, Any], need_model: bool) -> Dict[str, Any]:
    """body 里给了的 protocol / preset / base_url / model / max_tokens 校验后盖到 cur 上；没给的沿用 cur。"""
    out = dict(cur)
    if "protocol" in body:
        if body["protocol"] not in PROTOCOLS:
            raise ConfigError(f"协议只能是 {' / '.join(PROTOCOLS)}")
        out["protocol"] = body["protocol"]
    protocol = str(out.get("protocol") or "openai")
    if protocol not in PROTOCOLS:
        protocol = out["protocol"] = "openai"
    if "preset" in body:
        p = body["preset"]
        if p is not None and (not isinstance(p, str) or len(p) > 64):
            raise ConfigError("服务商（preset）要是不超过 64 个字的文字，或者不填")
        if p and _bad_chars(p):
            raise ConfigError("服务商（preset）里有不能用的字符")
        out["preset"] = p or None
    if "base_url" in body:
        if not isinstance(body["base_url"], str):
            raise ConfigError("接口地址要是一段文字")
        out["base_url"] = body["base_url"]
    out["base_url"] = normalize_base_url(out.get("base_url"), protocol)
    err = check_url(out["base_url"])
    if err:
        raise ConfigError(err)
    if "model" in body:
        if not isinstance(body["model"], str):
            raise ConfigError("模型名要是一段文字")
        out["model"] = body["model"]
    out["model"] = str(out.get("model") or "").strip()
    if len(out["model"]) > 200:
        raise ConfigError("模型名太长了（最多 200 个字）")
    if _bad_chars(out["model"]):
        raise ConfigError("模型名里有不能用的字符")
    if need_model and not out["model"]:
        raise ConfigError("模型名要填")
    if "max_tokens" in body:
        v = body["max_tokens"]
        if v is None or v == "":
            out["max_tokens"] = None
        elif isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 1_000_000:
            raise ConfigError("max_tokens 要是 1 到 1000000 之间的整数，或者不填")
        else:
            out["max_tokens"] = v
    return out


def _new_key(body: Dict[str, Any]) -> Optional[str]:
    """body 里带的 key（去掉首尾空白）；没带或是空字符串返回 None。"""
    k = body.get("api_key")
    if k is None:
        return None
    if not isinstance(k, str):
        raise ConfigError("API key 要是一段文字")
    k = k.strip()
    if not k:
        return None
    err = check_key(k)
    if err:
        raise ConfigError(err)
    return k


def _same_origin(new_base: str, cur: Dict[str, Any]) -> bool:
    """新填的地址和已保存的地址是不是同一个（协议、域名、端口都一样）。"""
    saved = normalize_base_url(cur.get("base_url"), str(cur.get("protocol") or "openai"))
    return origin_of(new_base) == origin_of(saved)


# 整个「读设置 → 算新设置 → 写文件」要串行：同时保存时，后一个要看到前一个写好的结果，
# 也避免两个线程同时 os.replace 同一个文件（Windows 上会报拒绝访问）。
_SAVE_LOCK = threading.Lock()


def update_config(body: Any) -> Dict[str, Any]:
    """PUT /v2/ai/config。key 的规则：
    - 不传 api_key（或传空字符串）：key 不变；传了就存传来的值；clear_key: true 清掉。
    - 接口地址变了（协议、域名、端口任一不同）、请求里又没带 key：清掉存着的 key（不把 key 发给另一个地址）。
    - key 来自环境变量 OUTSETTER_AI_API_KEY 时不能在这里改 key；换了地址时返回说明（环境变量的 key 会发到新地址），
      key_cleared 是 false（实际用的 key 没变）。配置文件里存的 key 也按上一条清掉。
    """
    if not isinstance(body, dict):
        raise ConfigError("请求体要是一个 JSON 对象")
    with _SAVE_LOCK:
        broken = config_file_error(saving=True)
        if broken:
            raise ConfigError(broken, code="config_invalid", status=500)
        cur = settings.api_config()
        new = _form_fields(body, cur, need_model=True)
        key = _new_key(body)
        clear = body.get("clear_key") is True
        env = bool(cur["key_from_env"])
        if env and (key is not None or clear):
            raise ConfigError(f"API key 来自环境变量 {settings.API_KEY_ENV}，这里改不了；要换 key，改这个环境变量后重启后端",
                              code="key_from_env", status=409)
        saved = settings.saved_api_key()
        moved = not _same_origin(new["base_url"], cur)
        message = None
        cleared = False
        if key is not None:
            new["api_key"] = key
        elif clear:
            new["api_key"] = ""
            cleared = bool(saved)
        elif saved and moved:
            new["api_key"] = ""
            cleared = True
            message = KEY_CHANGED
        else:
            new["api_key"] = saved
        if env:
            cleared = False
            message = ENV_KEY_MOVES if moved else None
        try:
            settings.save_api_config(new)
        except settings.ConfigFileInvalid as e:
            raise ConfigError(f"{settings.config_label()} 读不出来（不是合法的 JSON），没有保存。先修好或删掉它：{_clip(e, 200)}",
                              code="config_invalid", status=500)
        except (OSError, ValueError) as e:
            raise ConfigError(f"配置文件写不进去：{_clip(e, 200)}", code="config_write", status=500)
        return {"ok": True, "message": message, "key_cleared": cleared, "config": public_config()}


def form_config(body: Any, need_model: bool) -> Dict[str, Any]:
    """「测试」「列出模型」用表单里的设置（可以还没保存）。没给 key 时：
    - key 来自环境变量：用它（保存后它对任何地址都会用，测试时也一样）；
    - 否则用已保存的 key，但只在接口地址（协议、域名、端口）没变时用。"""
    if not isinstance(body, dict):
        body = {}
    cur = settings.api_config()
    a = _form_fields(body, cur, need_model=need_model)
    key = _new_key(body)
    if key is not None:
        a["api_key"] = key
    elif cur["key_from_env"] or _same_origin(a["base_url"], cur):
        a["api_key"] = cur["api_key"]
    else:
        a["api_key"] = ""
    return a


# ================================================================ 连接（能从别的线程关掉）
def _close_sock(s: Any) -> None:
    """立刻关掉 socket，让别的线程里阻塞着的读马上出错返回。
    响应还拿着 makefile 的引用时 close() 不会真正关；Windows 上只 shutdown 也叫不醒阻塞的读，所以把句柄拆下来直接关。"""
    try:
        s.shutdown(socket.SHUT_RDWR)
    except (OSError, ValueError):
        pass
    try:
        fd = s.detach()
    except (OSError, ValueError, AttributeError):
        fd = -1
    if isinstance(fd, int) and fd >= 0:
        try:
            socket.close(fd)
        except OSError:
            pass
    try:
        s.close()
    except (OSError, ValueError):
        pass


class _Kill:
    """给 AiJob.attach 用。socket 一创建（还没连）就记下来；kill() 时直接关掉它，阻塞在连接、握手、读上的线程马上返回。
    connected：TCP 连上（https 还要握手完）之后才是 True，用来分清「连不上」和「连上了但等回答超时」。
    got_body：收到回答的第一个字节之后才是 True，之后才按 stall_s 判断卡住。"""

    def __init__(self):
        self.sock: Any = None
        self.killed = False
        self.connected = False
        self.got_body = False
        self._lock = threading.Lock()

    def set_sock(self, sock: Any) -> None:
        with self._lock:
            self.sock = sock
            dead = self.killed
        if dead:
            _close_sock(sock)

    def settimeout(self, t: float) -> None:
        s = self.sock
        if s is not None:
            try:
                s.settimeout(t)
            except OSError:
                pass

    def kill(self) -> None:
        with self._lock:
            self.killed = True
            s = self.sock
        if s is not None:
            _close_sock(s)


class _Aborted(ConnectionAbortedError):
    """连接进行中被 kill()。"""


# 非阻塞 connect 还在进行中时 connect_ex 的返回值（Linux 的 EINPROGRESS，Windows 的 WSAEWOULDBLOCK 等）
_IN_PROGRESS = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, 10035, 10036, 10037}


def _start_connect(sock: socket.socket, addr: Any) -> int:
    return sock.connect_ex(addr)


def _sock_error(rc: int) -> OSError:
    """非阻塞 connect 失败的错误码 → 和阻塞 connect 一样的异常（按错误码变成 ConnectionRefusedError 等子类）。
    Windows 的 socket 错误码 os.strerror 认不出来，用系统的说明。"""
    text = os.strerror(rc)
    if os.name == "nt" and text.startswith("Unknown error"):
        try:
            import ctypes
            text = ctypes.FormatError(rc)
        except Exception:  # noqa: BLE001
            pass
    return OSError(rc, text)


def _wait_connect(sock: socket.socket, t: float) -> bool:
    """等非阻塞的 connect 出结果（成功或失败），最多 t 秒；出结果了返回 True。"""
    _, w, x = select.select([], [sock], [sock], t)
    return bool(w or x)


def _connect(address: Tuple[str, int], timeout: Any, source_address: Any, kh: _Kill) -> socket.socket:
    """代替 socket.create_connection：socket 先交给 kh 再连。connect 用非阻塞方式，每 0.1 秒看一次有没有被取消，
    所以 TCP 连接卡住时（例如对方不回 SYN）取消也能马上返回。"""
    host, port = address
    t = float(timeout) if isinstance(timeout, (int, float)) else None
    deadline = None if t is None else time.monotonic() + t
    last: Optional[Exception] = None
    for af, socktype, proto, _canon, sa in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM):
        if kh.killed:
            raise _Aborted("已取消")
        sock = socket.socket(af, socktype, proto)
        kh.set_sock(sock)
        try:
            if source_address:
                sock.bind(source_address)
            sock.setblocking(False)
            rc = _start_connect(sock, sa)
            while rc in _IN_PROGRESS:
                if kh.killed:
                    raise _Aborted("已取消")
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    raise socket.timeout("timed out")
                if _wait_connect(sock, 0.1 if left is None else min(0.1, left)):
                    rc = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if rc:
                raise _sock_error(rc)
            sock.settimeout(t)
            return sock
        except (OSError, ValueError) as e:              # 被 kill() 关掉的 socket 再 select 时是 ValueError
            _close_sock(sock)
            if kh.killed or isinstance(e, _Aborted):
                raise _Aborted("已取消") from None
            last = e
    raise last or OSError("找不到这个域名的地址")


def _use_kill_handle(conn: http.client.HTTPConnection, kh: _Kill) -> None:
    conn._create_connection = (                                 # type: ignore[attr-defined]
        lambda address, timeout=None, source_address=None: _connect(address, timeout, source_address, kh))


class _HTTPConn(http.client.HTTPConnection):
    """TCP 连接（经代理时还有 CONNECT）用 _connect：socket 在连之前就交给 kill_handle。"""

    def __init__(self, *a: Any, kill_handle: _Kill, **kw: Any):
        super().__init__(*a, **kw)
        self.kill_handle = kill_handle
        _use_kill_handle(self, kill_handle)

    def connect(self):
        super().connect()
        self.kill_handle.connected = True


class _HTTPSConn(http.client.HTTPSConnection):
    """和 HTTPSConnection.connect 一样先连 TCP 再套 TLS，区别是握手前先把套好的 socket 交给 kill_handle：
    套 TLS 时 TCP 那个 socket 对象的句柄会被拆走，只记着它的话握手中途就关不掉了。"""

    def __init__(self, *a: Any, kill_handle: _Kill, **kw: Any):
        super().__init__(*a, **kw)
        self.kill_handle = kill_handle
        _use_kill_handle(self, kill_handle)

    def connect(self):
        http.client.HTTPConnection.connect(self)
        server_hostname = self._tunnel_host or self.host       # type: ignore[attr-defined]
        ss = self._context.wrap_socket(self.sock, server_hostname=server_hostname,  # type: ignore[attr-defined]
                                       do_handshake_on_connect=False)
        self.sock = ss
        self.kill_handle.set_sock(ss)
        ss.do_handshake()
        self.kill_handle.connected = True


class _HTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, kh: _Kill):
        super().__init__()
        self.kh = kh

    def http_open(self, req):
        return self.do_open(lambda host, **kw: _HTTPConn(host, kill_handle=self.kh, **kw), req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, kh: _Kill):
        super().__init__()
        self.kh = kh

    def https_open(self, req):
        return self.do_open(lambda host, **kw: _HTTPSConn(host, kill_handle=self.kh, **kw), req, context=self._context)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟随跳转：跟过去的话 Authorization / x-api-key 会一起发到跳转后的地址。
    返回 None 后由默认的出错处理抛 HTTPError，_open 再把它翻成「接口地址发生了跳转」。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _opener(url: str, kh: _Kill) -> urllib.request.OpenerDirector:
    handlers: List[Any] = [_HTTPHandler(kh), _HTTPSHandler(kh), _NoRedirect()]
    if is_local(url):
        handlers.append(urllib.request.ProxyHandler({}))       # 本机地址不走代理
    return urllib.request.build_opener(*handlers)


# ================================================================ 报错
def _clip(s: Any, n: int = MSG_CHARS) -> str:
    t = " ".join(str(s or "").split())
    return t if len(t) <= n else t[:n] + "…"


def _pick_message(obj: Any) -> Optional[str]:
    """从服务商的报错 JSON 里取出说明：{"error": {"message": …}} / {"error": "…"} / {"message": …} 等。"""
    if isinstance(obj, list) and obj:
        obj = obj[0]
    if not isinstance(obj, dict):
        return None
    err = obj.get("error")
    if isinstance(err, dict):
        for k in ("message", "msg", "type", "code"):
            if err.get(k):
                return str(err[k])
    if isinstance(err, str) and err:
        return err
    for k in ("message", "msg", "detail", "error_msg"):
        v = obj.get(k)
        if v:
            return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return None


def _provider_message(body: bytes, key: str) -> str:
    text = body.decode("utf-8", "replace").strip()
    try:
        msg = _pick_message(json.loads(text))
    except ValueError:
        msg = None
    return _safe(msg or text, key)


def http_error(status: int, detail: str, key: str) -> AIError:
    low = detail.lower()
    if status == 402 or any(w in low for w in ("balance", "余额", "欠费", "arrear")):
        what = "余额不足"
    elif status in (401, 403):
        what = "API key 不对、过期或没有权限"
    elif status == 404 or (status == 400 and "model" in low
                           and any(w in low for w in ("not exist", "not found", "does not exist", "unknown", "invalid model"))):
        what = "接口地址或模型名不对"
    elif status == 429:
        what = "请求太频繁或额度用完"
    elif status >= 500:
        what = "服务商那边出错"
    else:
        what = "接口拒绝了这次请求"
    msg = f"{what}（HTTP {status}）" + (f"：{detail}" if detail else "")
    return AIError(redact(msg, key), code="api_error")


def redirect_error(url: str, status: int, location: str, key: str) -> AIError:
    """跳转到别的地址时只说协议 + 域名（+ 端口），不带路径和参数；跳转到同一个地址的别的路径时带上路径（不带参数）。"""
    target = urljoin(url, location) if location else ""
    where = origin_text(target)
    if where and origin_of(target) == origin_of(url):
        where += urlparse(target).path
    msg = f"接口地址发生了跳转（HTTP {status}" + (f" → {_clip(where, 200)}" if where else "") + "）：请直接填跳转后的地址"
    return AIError(redact(msg, key), code="api_redirect")


def connect_error(url: str, reason: Any, key: str) -> AIError:
    if isinstance(reason, ssl.SSLCertVerificationError):
        why = "证书验证没通过"
    elif isinstance(reason, ssl.SSLError):
        why = f"加密连接出错：{_safe(reason, key, 120)}"
    elif isinstance(reason, socket.gaierror):
        why = "找不到这个域名"
    elif isinstance(reason, ConnectionRefusedError):
        why = "连接被拒绝，地址或端口不对，或者对方的服务没开"
    elif isinstance(reason, socket.timeout):
        why = "连接超时"
    else:
        why = _safe(reason, key, 160) or type(reason).__name__
    where = host_of(url) or url
    msg = f"连不上接口地址 {where}（{why}）。检查地址有没有写对，网络和代理是否正常"
    if is_local(url):
        msg += "；本机的服务（例如 Ollama、LM Studio）要先打开"
    return AIError(redact(msg, key), code="api_connect")


def _cancelled() -> AIError:
    return AIError("已取消", code="cancelled")


def _timeout(deadline: float, stall: float, timeout: float) -> AIError:
    if time.monotonic() >= deadline - 0.05:
        return AIError(f"AI 超过 {timeout:g} 秒没有返回，已中止", code="timeout")
    return AIError(f"AI 连续 {stall:g} 秒没有任何动静（可能卡住了），已中止。点「再试一次」重新问", code="timeout")


def _wait_s(deadline: float, stall: Optional[float]) -> float:
    """这一次读最多等多久。stall 是 None 时只看总时长（还没收到回答的第一个字节）。"""
    left = deadline - time.monotonic()
    return max(0.05, left if stall is None else min(stall, left))


def _is_cancelled(job: Optional[AiJob]) -> bool:
    return job is not None and job.cancelled.is_set()


# ================================================================ 请求
def _headers(protocol: str, key: str, accept: str) -> Dict[str, str]:
    h = {"Content-Type": "application/json", "Accept": accept, "User-Agent": USER_AGENT}
    if protocol == "anthropic":
        h["anthropic-version"] = ANTHROPIC_VERSION
        if key:
            h["x-api-key"] = key
    elif key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _max_tokens(v: Any) -> Optional[int]:
    if isinstance(v, bool) or v is None:
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def build_request(cfg: Dict[str, Any], system: str, user: str) -> Tuple[str, Dict[str, str], bytes]:
    protocol = str(cfg.get("protocol") or "openai")
    base = normalize_base_url(cfg.get("base_url"), protocol)
    key = str(cfg.get("api_key") or "")
    model = str(cfg.get("model") or "").strip()
    mt = _max_tokens(cfg.get("max_tokens"))
    if protocol == "anthropic":
        body: Dict[str, Any] = {"model": model, "max_tokens": mt or ANTHROPIC_MAX_TOKENS, "system": system,
                                "messages": [{"role": "user", "content": user}], "stream": True}
        url = base + "/v1/messages"
    else:
        body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "stream": True}
        if mt:
            body["max_tokens"] = mt
        url = base + "/chat/completions"
    return url, _headers(protocol, key, "text/event-stream"), json.dumps(body, ensure_ascii=False).encode("utf-8")


def _precheck(cfg: Dict[str, Any], key: str) -> None:
    """发请求前再查一遍地址和 key：设置文件可能是手改的，key 也可能来自环境变量，格式不对的话
    http.client 的报错里会带着转义后的 key，而且会被当成「连不上」。"""
    err = check_url(normalize_base_url(cfg.get("base_url"), str(cfg.get("protocol") or "openai")))
    if err:
        raise AIError(f"AI 接口地址有问题：{err}，在「设置 → AI」里改", code="channel")
    if key and check_key(key):
        raise AIError(bad_key_message(cfg), code="bad_key")


def _open(url: str, headers: Dict[str, str], body: Optional[bytes], kh: _Kill, key: str, deadline: float,
          stall: float, timeout: float, job: Optional[AiJob]):
    """连上并拿到响应头。连接、握手、等响应头都只受总时长限制（推理模型可能先想很久才回响应头）。"""
    if _is_cancelled(job):
        raise _cancelled()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        return _opener(url, kh).open(req, timeout=_wait_s(deadline, None))
    except urllib.error.HTTPError as e:
        if e.code in REDIRECT_CODES:
            location = (e.headers.get("Location") if e.headers is not None else None) or ""
            try:
                e.close()
            except Exception:  # noqa: BLE001
                pass
            raise redirect_error(url, e.code, location, key)
        try:
            kh.settimeout(_wait_s(deadline, stall))
            raw = e.read(MAX_BODY)
        except Exception:  # noqa: BLE001  报错正文读不出来就只报状态码
            raw = b""
        if _is_cancelled(job):
            raise _cancelled()
        raise http_error(e.code, _provider_message(raw, key), key)
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as e:
        if _is_cancelled(job):
            raise _cancelled()
        reason = e.reason if isinstance(e, urllib.error.URLError) else e
        if isinstance(reason, socket.timeout) and kh.connected:
            raise _timeout(deadline, stall, timeout)               # 连上了，等响应头时超时
        raise connect_error(url, reason, key)


def _read_line(resp, kh: _Kill, key: str, deadline: float, stall: float, timeout: float, job: Optional[AiJob]) -> bytes:
    """读一行。收到第一个字节之前只看总时长，之后每次最多等 stall 秒；保活注释（: 开头的行）也算收到了字节。"""
    if _is_cancelled(job):
        raise _cancelled()
    kh.settimeout(_wait_s(deadline, stall if kh.got_body else None))
    try:
        raw = resp.readline(1 << 20)
    except socket.timeout:
        if _is_cancelled(job):
            raise _cancelled()
        raise _timeout(deadline, stall, timeout)
    except (OSError, ValueError, http.client.HTTPException) as e:
        if _is_cancelled(job):
            raise _cancelled()
        raise AIError(_safe(f"读 AI 的回答时连接断了：{str(e) or type(e).__name__}", key, 200), code="api_broken")
    if raw:
        kh.got_body = True
        if time.monotonic() > deadline:
            raise _timeout(deadline, stall, timeout)
    return raw


def _read_body(resp, kh: _Kill, key: str, deadline: float, stall: float, timeout: float, job: Optional[AiJob]) -> bytes:
    buf = bytearray()
    while len(buf) < MAX_BODY:
        line = _read_line(resp, kh, key, deadline, stall, timeout, job)
        if not line:
            break
        buf += line
    return bytes(buf)


def _stream_error(obj: Dict[str, Any], key: str) -> AIError:
    return AIError("接口在回答过程中报错：" + _safe(_pick_message(obj) or json.dumps(obj, ensure_ascii=False), key),
                   code="api_error")


def _on_openai(obj: Dict[str, Any], job: AiJob, parts: List[str], key: str, st: Dict[str, Any]) -> bool:
    if obj.get("error"):
        raise _stream_error(obj, key)
    usage = obj.get("usage")
    if isinstance(usage, dict) and isinstance(usage.get("completion_tokens"), int):
        job.output_tokens = usage["completion_tokens"]
    choices = obj.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        d = choices[0].get("delta")
        if isinstance(d, dict):
            if d.get("reasoning_content") or d.get("reasoning"):
                job.thinking()
            c = d.get("content")
            if isinstance(c, str) and c:
                parts.append(c)
                job.delta(c)
        fr = choices[0].get("finish_reason")
        if fr:
            st["finish"] = str(fr).lower()
    return False


def _on_anthropic(obj: Dict[str, Any], job: AiJob, parts: List[str], key: str, st: Dict[str, Any]) -> bool:
    t = obj.get("type")
    if t == "content_block_delta":
        d = obj.get("delta") if isinstance(obj.get("delta"), dict) else {}
        if d.get("type") == "text_delta" and isinstance(d.get("text"), str) and d["text"]:
            parts.append(d["text"])
            job.delta(d["text"])
        elif d.get("type") == "thinking_delta":
            job.thinking()
    elif t == "message_delta":
        u = obj.get("usage")
        if isinstance(u, dict) and isinstance(u.get("output_tokens"), int):
            job.output_tokens = u["output_tokens"]
        d = obj.get("delta")
        if isinstance(d, dict) and d.get("stop_reason"):
            st["finish"] = str(d["stop_reason"]).lower()
    elif t == "message_stop":
        return True
    elif t == "error":
        raise _stream_error(obj, key)
    return False


def _consume_sse(next_line: Callable[[], bytes], protocol: str, job: AiJob, parts: List[str], key: str,
                 st: Dict[str, Any]) -> None:
    """一行一行处理 SSE。st["done"]：收到了结束标记（openai 的 [DONE]、anthropic 的 message_stop）；
    st["finish"]：服务商给的结束原因（finish_reason / stop_reason）。"""
    on = _on_anthropic if protocol == "anthropic" else _on_openai
    while True:
        raw = next_line()
        if not raw:
            return                                  # 对方关了连接
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
        elif line.startswith("{"):
            payload = line                          # 个别服务商出错时直接给一行 JSON
        else:
            continue                                # 空行、event: 行、: 开头的保活注释
        if payload == "[DONE]":
            st["done"] = True
            return
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        if isinstance(obj, dict) and on(obj, job, parts, key, st):
            st["done"] = True
            return


def _check_end(st: Dict[str, Any], job: AiJob, stream: bool) -> None:
    """回答收完后：因为 max_tokens 被截断 → 直接报，不交给后面解析；流式回答既没有结束标记也没有结束原因 → 连接中途断了。"""
    if _is_cancelled(job):
        raise _cancelled()
    if st.get("finish") in ("length", "max_tokens"):
        raise AIError(TRUNCATED, code="truncated")
    if stream and not st.get("done") and not st.get("finish"):
        raise AIError(ENDED_EARLY, code="api_incomplete")


def _whole_text(obj: Any, protocol: str, key: str, st: Dict[str, Any]) -> str:
    """服务商没按流式返回、给了一整段 JSON 时，从里面取出回答和结束原因。"""
    if not isinstance(obj, dict):
        raise AIError("接口返回的内容看不懂（不是 JSON 对象）", code="api_error")
    if obj.get("error") or obj.get("type") == "error":
        raise _stream_error(obj, key)
    if obj.get("stop_reason"):
        st["finish"] = str(obj["stop_reason"]).lower()
    if protocol == "anthropic":
        blocks = obj.get("content") if isinstance(obj.get("content"), list) else []
        return "".join(b.get("text") or "" for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    choices = obj.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        if choices[0].get("finish_reason"):
            st["finish"] = str(choices[0]["finish_reason"]).lower()
        m = choices[0].get("message") or {}
        c = m.get("content") if isinstance(m, dict) else None
        return c if isinstance(c, str) else ""
    return ""


def _read_answer(resp, protocol: str, kh: _Kill, key: str, deadline: float, stall: float, timeout: float,
                 job: AiJob) -> str:
    parts: List[str] = []
    st: Dict[str, Any] = {}
    ctype = (resp.headers.get("Content-Type") or "").lower()
    if "event-stream" not in ctype and "json" in ctype:
        raw = _read_body(resp, kh, key, deadline, stall, timeout, job)
        try:
            obj = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            if not raw.lstrip().startswith(b"data:"):
                raise AIError("接口返回的内容看不懂：" + _safe(raw.decode("utf-8", "replace"), key), code="api_error")
            # 响应头说是 JSON，内容其实是 SSE（个别服务商这样）：按 SSE 解析
            lines = iter(raw.splitlines(keepends=True))
            _consume_sse(lambda: next(lines, b""), protocol, job, parts, key, st)
            _check_end(st, job, stream=True)
            return "".join(parts)
        if isinstance(obj, dict) and isinstance(obj.get("usage"), dict):
            u = obj["usage"]
            n = u.get("completion_tokens", u.get("output_tokens"))
            if isinstance(n, int):
                job.output_tokens = n
        text = _whole_text(obj, protocol, key, st)
        _check_end(st, job, stream=False)
        if text:
            job.delta(text)
        return text
    _consume_sse(lambda: _read_line(resp, kh, key, deadline, stall, timeout, job), protocol, job, parts, key, st)
    _check_end(st, job, stream=True)
    return "".join(parts)


def stream_chat(cfg: Dict[str, Any], system: str, user: str, timeout: float, stall_s: float, job: AiJob) -> AiReply:
    """发一次流式请求，边收边把文字推给 job（delta / thinking）。cfg 是 settings.api_config() 那样的字典（api_key 是要发的 key）。
    总时长从 job 开始算（排队的时间也算在内），和本机命令行一致。"""
    protocol = str(cfg.get("protocol") or "openai")
    key = str(cfg.get("api_key") or "")
    if protocol not in PROTOCOLS:
        raise AIError(f"接口协议只能是 {' / '.join(PROTOCOLS)}", code="channel")
    _precheck(cfg, key)
    timeout = float(timeout)
    stall = float(stall_s or 60)
    deadline = time.monotonic() + max(1.0, timeout - job.ms() / 1000)
    kh = _Kill()
    resp = None
    job.attach(kh)
    try:
        url, headers, body = build_request(cfg, system, user)
        resp = _open(url, headers, body, kh, key, deadline, stall, timeout, job)
        job.status("connected", "已连上接口，等 AI 开始写")
        text = _read_answer(resp, protocol, kh, key, deadline, stall, timeout, job)
    except AIError:
        raise
    except Exception as e:  # noqa: BLE001  意外的错误也不能把 key 带出去
        if _is_cancelled(job):
            raise _cancelled()
        raise AIError(_safe(f"调用 AI 接口出错：{type(e).__name__}: {e}", key, 240), code="api_error")
    finally:
        job.detach()
        kh.kill()                                   # 一次请求一个连接，用完就关
        if resp is not None:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass
    job.ai_done_ms = job.ms()
    return AiReply(text, warm=False, first_token_ms=job.first_token_ms, total_ms=job.ai_done_ms,
                   output_tokens=job.output_tokens, engine="api")


def list_models(cfg: Dict[str, Any], timeout: float = 20.0) -> List[str]:
    """GET {base_url}/models（只对 openai 协议），返回模型名列表。"""
    if str(cfg.get("protocol") or "openai") != "openai":
        raise AIError("只有 OpenAI 兼容协议能列出模型；Anthropic 的模型名请看服务商文档", code="unsupported")
    key = str(cfg.get("api_key") or "")
    _precheck(cfg, key)
    url = normalize_base_url(cfg.get("base_url")) + "/models"
    headers = _headers("openai", key, "application/json")
    headers.pop("Content-Type", None)
    deadline = time.monotonic() + timeout
    kh = _Kill()
    resp = None
    try:
        resp = _open(url, headers, None, kh, key, deadline, timeout, timeout, None)
        raw = _read_body(resp, kh, key, deadline, timeout, timeout, None)
    except AIError:
        raise
    except Exception as e:  # noqa: BLE001
        raise AIError(_safe(f"列出模型时出错：{type(e).__name__}: {e}", key, 240), code="api_error")
    finally:
        kh.kill()
        if resp is not None:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass
    try:
        obj = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise AIError("接口返回的模型列表看不懂：" + _safe(raw.decode("utf-8", "replace"), key), code="api_error")
    items = obj.get("data") if isinstance(obj, dict) else obj
    if isinstance(obj, dict) and not isinstance(items, list):
        items = obj.get("models")
    if not isinstance(items, list):
        raise AIError("接口返回的模型列表看不懂（没有 data 列表）", code="api_error")
    names = []
    for it in items:
        v = (it.get("id") or it.get("name")) if isinstance(it, dict) else it
        if isinstance(v, str) and v.strip():
            names.append(v.strip())
    return sorted(set(names))[:1000]


def ping(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """「测试」按钮：发一个很短的请求，看能不能连上、能不能拿到回答。"""
    ai_cfg = settings.ai_config()
    try:
        timeout = min(float(ai_cfg.get("timeout_s") or 120), 60.0)
        stall = min(float(ai_cfg.get("stall_s") or 60), 30.0)
    except (TypeError, ValueError):
        timeout, stall = 60.0, 30.0
    t0 = time.perf_counter()
    job = AiJob("test")
    try:
        r = stream_chat(cfg, "只回复 OK", "只回复 OK 这两个字母，不要别的内容。", timeout, stall, job)
    except AIError as e:
        return {"ok": False, "ms": round((time.perf_counter() - t0) * 1000), "reply": None, "error": e.message,
                "error_code": e.code}
    ms = round((time.perf_counter() - t0) * 1000)
    reply = r.text.strip()
    if not reply:
        return {"ok": False, "ms": ms, "reply": "", "error_code": "empty",
                "error": "连上了，但 AI 没有输出文字（如果设置了 max_tokens，可能设得太小）"}
    return {"ok": True, "ms": ms, "reply": _safe(reply, str(cfg.get("api_key") or ""), 200), "error": None}
