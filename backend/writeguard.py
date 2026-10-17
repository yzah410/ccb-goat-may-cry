# backend/writeguard.py
"""写请求守卫：挡住外部网页对本机后端的跨站写请求。

CORS 只决定「网页能不能读到响应」，不决定「请求有没有发出去」。外部网页用普通表单、或不带
Content-Type 的 fetch（后端会按 JSON 解析请求体）发出的 POST 是不触发预检的「简单请求」，
浏览器会直接把它发给本机后端，后端照常执行：烧 AI 额度、启停自动点击、覆盖方案。

所以 GET / HEAD / OPTIONS 以外的请求要同时满足：

1. Origin 头不存在，或者是本机页面（和 CORS 同一条规则）。外部网页、`Origin: null`（沙箱 iframe、
   file:// 页面）一律拒绝。
2. 没有 `Sec-Fetch-Site: cross-site`。这个头由浏览器自己填、网页改不了；浏览器给跨站写请求都会带
   Origin，所以这一条只是第二道保险。本机页面（Origin 合法）不看它：从 localhost 打开前端、
   后端地址写 127.0.0.1 时，浏览器会把它标成 cross-site，但 Origin 已经说明是本机页面。
3. 带自定义头 `X-Outsetter: 1`。自定义头会让浏览器先发预检，而预检会被 CORS 规则挡住，
   所以外部网页发不出带这个头的请求。本仓库的前端所有写请求都带它。

curl、脚本这类非浏览器客户端没有 Origin，只需要加 `X-Outsetter: 1`。
这里写成纯 ASGI 中间件（不用 BaseHTTPMiddleware），以免影响 SSE 流式响应的断线检测。
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

# 本机页面的来源：出题器前端（默认 5175 端口，可在 web/.env.development.local 里用 WEB_PORT 改）都在 127.0.0.1 / localhost 上。CORS 和守卫共用。
LOCAL_ORIGIN_REGEX = r"^http://(127\.0\.0\.1|localhost)(:\d+)?$"
_LOCAL_ORIGIN = re.compile(LOCAL_ORIGIN_REGEX)

GUARD_HEADER = "X-Outsetter"
GUARD_VALUE = "1"

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _values(scope: Dict[str, Any], name: bytes) -> List[str]:
    return [v.decode("latin-1") for k, v in scope.get("headers", ()) if k == name]


def _reject(error: str, message: str) -> Dict[str, Any]:
    return {"error": error, "message": message}


def check_write_request(method: str, origins: List[str], fetch_site: List[str], guard: List[str]) -> Dict[str, Any] | None:
    """返回 None 表示放行，否则返回 {error, message}（403 的响应体内容）。"""
    if method.upper() in _SAFE_METHODS:
        return None
    if any(_LOCAL_ORIGIN.fullmatch(o) is None for o in origins):
        return _reject("forbidden_origin", "后端只接受本机出题器页面的写请求，这个请求来自别的网页，已拒绝")
    if not origins and any(s.strip().lower() == "cross-site" for s in fetch_site):
        return _reject("forbidden_origin", "后端只接受本机出题器页面的写请求，这个请求被浏览器标成跨站，已拒绝")
    if GUARD_VALUE not in [g.strip() for g in guard]:
        return _reject(
            "missing_guard_header",
            f"写请求缺少 {GUARD_HEADER}: {GUARD_VALUE} 请求头，已拒绝。"
            "如果是在出题器页面里遇到的，刷新页面（Ctrl+F5）让前端更新到和后端匹配的版本；自己写脚本调接口，就在请求里加上这个头",
        )
    return None


class WriteGuardMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        bad = check_write_request(
            scope["method"],
            _values(scope, b"origin"),
            _values(scope, b"sec-fetch-site"),
            _values(scope, GUARD_HEADER.lower().encode("ascii")),
        )
        if bad is None:
            await self.app(scope, receive, send)
            return
        body = json.dumps({"ok": False, **bad}, ensure_ascii=False).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": body})
