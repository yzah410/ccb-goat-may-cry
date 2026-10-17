# -*- coding: utf-8 -*-
"""API 通道（aiapi.py）和它的设置接口。对面是本机的假接口（http.server，127.0.0.1 随机端口），不连外网。

改设置的用例都写临时配置文件（环境变量 OUTSETTER_CONFIG），每个用例结束时核对真实的 backend/config.json 没有被碰过。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from . import base  # noqa: F401  （设置合成库、临时配置文件的环境变量）
from fastapi.testclient import TestClient

from backend import paths
from backend.app import app
from backend.v2 import ai, aiapi, settings
from backend.v2.spec import default_spec
from .test_ai import GOOD_SQL, ask_text, patch_2024

KEY = "sk-test-0123456789abcdefWXYZ"
GUARD = {"X-Outsetter": "1"}
REAL_CONFIG = os.path.join(paths.BACKEND_DIR, "config.json")


def _snapshot(path):
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return os.path.getmtime(path), hashlib.sha256(f.read()).hexdigest()


# ================================================================ 本机假接口
class FakeAPI:
    """respond(handler, req) 决定怎么回；req = {method, path, headers（小写键）, body}。close() 让还在等的处理函数也结束。"""

    def __init__(self, respond):
        self.respond = respond
        self.requests = []
        self.stop = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _any(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                req = {"method": self.command, "path": self.path,
                       "headers": {k.lower(): v for k, v in self.headers.items()},
                       "body": json.loads(raw.decode("utf-8")) if raw else None}
                outer.requests.append(req)
                try:
                    outer.respond(self, req)
                except OSError:                  # 客户端先断开了（取消、超时）
                    pass
                self.close_connection = True

            do_GET = _any
            do_POST = _any

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            block_on_close = False

        self.server = Server(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


def start_stream(h, chunked=False, ctype="text/event-stream"):
    if chunked:
        h.protocol_version = "HTTP/1.1"
    h.send_response(200)
    h.send_header("Content-Type", ctype)
    if chunked:
        h.send_header("Transfer-Encoding", "chunked")
    h.send_header("Connection", "close")
    h.end_headers()


def write(h, text, chunked=False):
    b = text.encode("utf-8")
    if chunked:
        b = b"%x\r\n" % len(b) + b + b"\r\n"
    h.wfile.write(b)
    h.wfile.flush()


def data(obj):
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


def openai_events(text, reasoning=None, usage=None, step=5):
    out = [data({"choices": [{"index": 0, "delta": {"role": "assistant", "reasoning_content": reasoning}}]})] if reasoning else []
    for i in range(0, len(text), step):
        out.append(data({"choices": [{"index": 0, "delta": {"content": text[i:i + step]}}]}))
    if usage is not None:
        out.append(data({"choices": [], "usage": {"completion_tokens": usage}}))
    out.append("data: [DONE]\n\n")
    return out


def reply_openai(text, chunked=False, **kw):
    def respond(h, req):
        start_stream(h, chunked)
        for e in openai_events(text, **kw):
            write(h, e, chunked)
        if chunked:
            h.wfile.write(b"0\r\n\r\n")
    return respond


def reply_json(status, payload):
    def respond(h, req):
        b = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        h.send_response(status)
        h.send_header("Content-Type", "application/json")
        h.send_header("Content-Length", str(len(b)))
        h.end_headers()
        h.wfile.write(b)
    return respond


def redirect_to(status, location):
    def respond(h, req):
        h.send_response(status)
        h.send_header("Location", location)
        h.send_header("Content-Length", "0")
        h.end_headers()
    return respond


class HoldTCP:
    """只接受 TCP 连接、一个字节都不回（TLS 握手、代理的 CONNECT 都卡在这里）。accepted：第一个连接进来了。"""

    def __init__(self):
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(8)
        self.srv.settimeout(0.1)
        self.port = self.srv.getsockname()[1]
        self.accepted = threading.Event()
        self.stop = threading.Event()
        self.conns = []
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while not self.stop.is_set():
            try:
                c, _ = self.srv.accept()
            except (socket.timeout, OSError):
                continue
            self.conns.append(c)
            self.accepted.set()

    def close(self):
        self.stop.set()
        self.thread.join(5)
        for c in self.conns:
            c.close()
        self.srv.close()


class ApiBase(unittest.TestCase):
    def setUp(self):
        self.assertIs(ai.RUNNER, ai.run_engine)             # 这里测的是真 RUNNER
        real = _snapshot(REAL_CONFIG)
        self.addCleanup(lambda: self.assertEqual(_snapshot(REAL_CONFIG), real, "真实的 backend/config.json 被改了"))
        self.tmp = tempfile.mkdtemp(prefix="aiapi_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        env = mock.patch.dict(os.environ, {"OUTSETTER_CONFIG": self.cfg_path})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(settings.API_KEY_ENV, None)

    def fake(self, respond):
        f = FakeAPI(respond)
        self.addCleanup(f.close)
        return f

    def write_cfg(self, api=None):
        raw = {"_comment": "顶层说明", "autoclick": {"cdp_port": 9223},
               "v2": {"_comment": "v2 段说明", "db_path": "data/x.sqlite", "ai": {"timeout_s": 90, "api": api or {}}},
               "classic": {"_comment": "经典", "data_dir": "data/classic"}}
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, indent=2)
        return raw

    def read_cfg(self):
        with open(self.cfg_path, "r", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def cfg(base_url, protocol="openai", key=KEY, model="test-model", **kw):
        return {"protocol": protocol, "base_url": base_url, "model": model, "api_key": key, "max_tokens": None, **kw}

    def assert_no_key(self, text):
        self.assertNotIn(KEY, str(text))


# ================================================================ 地址、key、显示名
class TestHelpers(unittest.TestCase):
    def test_base_url_normalized(self):
        n = aiapi.normalize_base_url
        self.assertEqual(n(" https://api.deepseek.com/ "), "https://api.deepseek.com")
        self.assertEqual(n("https://api.deepseek.com"), "https://api.deepseek.com")          # 不自动补 /v1
        self.assertEqual(n("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1")
        self.assertEqual(n("https://open.bigmodel.cn/api/paas/v4/chat/completions/"), "https://open.bigmodel.cn/api/paas/v4")
        self.assertEqual(n("https://relay.example/v1/messages"), "https://relay.example")
        self.assertEqual(n(""), "")
        self.assertEqual(n("", "anthropic"), "https://api.anthropic.com")
        self.assertEqual(n("https://api.anthropic.com/v1/messages", "anthropic"), "https://api.anthropic.com")
        self.assertEqual(n("https://api.anthropic.com/v1/", "anthropic"), "https://api.anthropic.com")
        self.assertEqual(n("https://relay.example/anthropic", "anthropic"), "https://relay.example/anthropic")

    def test_presets_match_frontend(self):
        """网页「服务商」下拉框的预设（providers.ts）和这里的 PRESETS 是同一组：id 一样、域名一样。"""
        with open(os.path.join(paths.REPO_ROOT, "web", "src", "features", "ai", "providers.ts"), encoding="utf-8") as f:
            src = f.read()
        pairs = re.findall(r"id: '([a-z]+)',\s*label: '[^']*',\s*protocol: '[a-z]+',\s*baseUrl: '([^']*)'", src)
        pairs = [(i, u) for i, u in pairs if i != "custom"]
        self.assertEqual([i for i, _ in pairs], list(aiapi.PRESETS))
        for i, u in pairs:
            self.assertEqual(aiapi.host_of(u), aiapi.PRESETS[i][1], i)

    def test_key_hint_and_redact(self):
        self.assertEqual(aiapi.key_hint(KEY), "…WXYZ")
        self.assertEqual(aiapi.key_hint(""), "")
        self.assertEqual(aiapi.key_hint("abc"), "…")                 # 太短：不露出后 4 位
        self.assertEqual(aiapi.redact(f"bad key {KEY}!", KEY), "bad key …WXYZ!")

    def test_configured_and_label(self):
        ok, note = aiapi.configured({"base_url": "", "model": "m", "api_key": KEY})
        self.assertFalse(ok)
        self.assertEqual(note, aiapi.NOT_CONFIGURED)
        self.assertFalse(aiapi.configured({"base_url": "https://api.deepseek.com", "model": "m", "api_key": ""})[0])
        self.assertFalse(aiapi.configured({"base_url": "https://api.deepseek.com", "model": " ", "api_key": KEY})[0])
        self.assertTrue(aiapi.configured({"base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})[0])
        for local in ("http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:1234/v1"):
            self.assertTrue(aiapi.configured({"base_url": local, "model": "m", "api_key": ""})[0], local)   # 本机不要 key
        self.assertTrue(aiapi.configured({"protocol": "anthropic", "base_url": "", "model": "m", "api_key": KEY})[0])
        self.assertEqual(aiapi.label({"preset": "deepseek", "base_url": "https://api.deepseek.com"}), "DeepSeek")
        self.assertEqual(aiapi.label({"preset": "deepseek", "base_url": "https://relay.example/v1"}), "relay.example")
        self.assertEqual(aiapi.label({"preset": None, "base_url": "https://api.example.com/v1"}), "api.example.com")
        self.assertEqual(aiapi.label({"preset": "ollama", "base_url": "http://localhost:11434/v1"}), "Ollama")


# ================================================================ 流式请求
class TestStream(ApiBase):
    def run_chat(self, cfg, timeout=10, stall=5, emit=None, job=None):
        job = job or ai.AiJob("fill", emit=emit)
        return aiapi.stream_chat(cfg, "系统提示", "用户的话", timeout, stall, job), job

    def test_openai_stream_with_reasoning(self):
        f = self.fake(reply_openai("你好，这是回答。", reasoning="先想一想", usage=7))
        events = []
        r, job = self.run_chat(self.cfg(f.base + "/v1"), emit=lambda ev, d: events.append((ev, d)))
        self.assertEqual(r.text, "你好，这是回答。")
        self.assertEqual((r.engine, r.warm, r.output_tokens), ("api", False, 7))
        self.assertIsNotNone(r.first_token_ms)
        stages = [d["stage"] for ev, d in events if ev == "status"]
        self.assertLess(stages.index("thinking"), stages.index("writing"))         # 先「在想」再「在写」
        self.assertEqual("".join(d["text"] for ev, d in events if ev == "delta"), "你好，这是回答。")
        req = f.requests[0]
        self.assertEqual((req["method"], req["path"]), ("POST", "/v1/chat/completions"))
        self.assertEqual(req["headers"]["authorization"], f"Bearer {KEY}")
        self.assertEqual(set(req["body"]), {"model", "messages", "stream"})          # 不传 temperature 这类参数
        self.assertEqual(req["body"]["messages"], [{"role": "system", "content": "系统提示"}, {"role": "user", "content": "用户的话"}])
        self.assertIs(req["body"]["stream"], True)

    def test_openai_max_tokens_and_no_key(self):
        f = self.fake(reply_openai("OK"))
        self.run_chat(self.cfg(f.base + "/v1/", key="", max_tokens=300))
        req = f.requests[0]
        self.assertEqual(req["path"], "/v1/chat/completions")
        self.assertEqual(req["body"]["max_tokens"], 300)
        self.assertNotIn("authorization", req["headers"])                           # 没有 key 就不发 Authorization

    def test_chunked_and_keepalive_comments(self):
        def respond(h, req):
            start_stream(h, chunked=True)
            write(h, ": keep-alive\n\n", True)
            for e in openai_events("分块传输也能读", step=2):
                write(h, e, True)
            h.wfile.write(b"0\r\n\r\n")
        f = self.fake(respond)
        r, _ = self.run_chat(self.cfg(f.base))
        self.assertEqual(r.text, "分块传输也能读")

    def test_whole_json_reply(self):
        f = self.fake(reply_json(200, {"choices": [{"message": {"content": "整段返回"}}], "usage": {"completion_tokens": 3}}))
        r, _ = self.run_chat(self.cfg(f.base))
        self.assertEqual((r.text, r.output_tokens), ("整段返回", 3))

    def test_anthropic_stream(self):
        def respond(h, req):
            start_stream(h)
            for ev, obj in [("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 9}}}),
                            ("content_block_delta", {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "嗯"}}),
                            ("ping", {"type": "ping"}),
                            ("content_block_delta", {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "你好"}}),
                            ("content_block_delta", {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "，世界"}}),
                            ("message_delta", {"type": "message_delta", "usage": {"output_tokens": 5}}),
                            ("message_stop", {"type": "message_stop"})]:
                write(h, f"event: {ev}\n" + data(obj))
        f = self.fake(respond)
        events = []
        r, _ = self.run_chat(self.cfg(f.base, protocol="anthropic"), emit=lambda ev, d: events.append((ev, d)))
        self.assertEqual((r.text, r.output_tokens), ("你好，世界", 5))
        self.assertIn("thinking", [d["stage"] for ev, d in events if ev == "status"])
        req = f.requests[0]
        self.assertEqual(req["path"], "/v1/messages")
        self.assertEqual(req["headers"]["x-api-key"], KEY)
        self.assertEqual(req["headers"]["anthropic-version"], "2023-06-01")
        self.assertNotIn("authorization", req["headers"])
        self.assertEqual(req["body"], {"model": "test-model", "max_tokens": 4096, "system": "系统提示",
                                       "messages": [{"role": "user", "content": "用户的话"}], "stream": True})

    def test_anthropic_error_event(self):
        def respond(h, req):
            start_stream(h)
            write(h, "event: error\n" + data({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}))
        f = self.fake(respond)
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base, protocol="anthropic"))
        self.assertIn("Overloaded", cm.exception.message)

    def test_http_errors_are_chinese_without_key(self):
        cases = [(401, "API key 不对、过期或没有权限"), (403, "API key 不对、过期或没有权限"), (404, "接口地址或模型名不对"),
                 (402, "余额不足"), (429, "请求太频繁或额度用完"), (500, "服务商那边出错"), (503, "服务商那边出错")]
        for status, phrase in cases:
            with self.subTest(status=status):
                # 服务商的报错里带着完整的 key：转出来的中文报错里只能剩后 4 位
                f = self.fake(reply_json(status, {"error": {"message": f"Incorrect API key provided: {KEY}", "type": "x"}}))
                with self.assertRaises(ai.AIError) as cm:
                    self.run_chat(self.cfg(f.base))
                msg = cm.exception.message
                self.assertIn(phrase, msg)
                self.assertIn(f"HTTP {status}", msg)
                self.assertIn("Incorrect API key provided", msg)                       # 服务商自己的说明
                self.assertIn("…WXYZ", msg)
                self.assert_no_key(msg)
        f = self.fake(reply_json(400, {"error": {"message": "Insufficient Balance"}}))
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base))
        self.assertIn("余额不足", cm.exception.message)
        f = self.fake(reply_json(400, {"error": {"message": "x" * 2000}}))
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base))
        self.assertLess(len(cm.exception.message), 400)                                # 服务商的说明截到约 300 字

    def test_connection_refused(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()                                                                       # 这个端口现在没人听
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f"http://127.0.0.1:{port}/v1"))
        self.assertEqual(cm.exception.code, "api_connect")
        self.assertIn("连不上接口地址 127.0.0.1（连接被拒绝", cm.exception.message)
        self.assert_no_key(cm.exception.message)

    def test_stall(self):
        def respond(h, req):
            start_stream(h)
            write(h, openai_events("开头")[0])
            f.stop.wait(10)                                                             # 之后一个字节都不发
        f = self.fake(respond)
        t0 = time.monotonic()
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base), timeout=20, stall=0.5)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertEqual(cm.exception.code, "timeout")
        self.assertEqual(cm.exception.message, "AI 连续 0.5 秒没有任何动静（可能卡住了），已中止。点「再试一次」重新问")

    def test_total_timeout_with_trickle(self):
        def respond(h, req):
            start_stream(h)
            while not f.stop.wait(0.1):
                write(h, ": ping\n\n")                                                  # 一直有字节，但总时长超了
        f = self.fake(respond)
        t0 = time.monotonic()
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base), timeout=1, stall=5)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertEqual(cm.exception.message, "AI 超过 1 秒没有返回，已中止")

    def _cancel_after(self, job, ready, delay=0.2):
        mark = {}

        def go():
            ready.wait(5)
            time.sleep(delay)
            mark["t"] = time.monotonic()
            job.cancel()
        threading.Thread(target=go, daemon=True).start()
        return mark

    def test_cancel_mid_stream(self):
        def respond(h, req):
            start_stream(h)
            write(h, openai_events("写了一半")[0])
            f.stop.wait(10)
        f = self.fake(respond)
        first = threading.Event()
        job = ai.AiJob("fill", emit=lambda ev, d: ev == "delta" and first.set())
        mark = self._cancel_after(job, first)
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base), timeout=30, stall=30, job=job)
        self.assertEqual(cm.exception.code, "cancelled")
        self.assertLess(time.monotonic() - mark["t"], 2)

    def test_cancel_while_waiting_for_headers(self):
        got = threading.Event()

        def respond(h, req):
            got.set()
            f.stop.wait(10)                                                             # 连响应头都不发
        f = self.fake(respond)
        job = ai.AiJob("fill")
        mark = self._cancel_after(job, got)
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base), timeout=30, stall=30, job=job)
        self.assertEqual(cm.exception.code, "cancelled")
        self.assertLess(time.monotonic() - mark["t"], 2)

    def test_unexpected_error_is_redacted(self):
        f = self.fake(reply_openai("OK"))
        with mock.patch.object(aiapi, "_read_answer", side_effect=RuntimeError(f"意外 {KEY}")):
            with self.assertRaises(ai.AIError) as cm:
                self.run_chat(self.cfg(f.base))
        self.assertIn("意外 …WXYZ", cm.exception.message)
        self.assert_no_key(cm.exception.message)

    # ---- 截断、提前断开、标成 JSON 的 SSE
    def test_truncated_openai_stream(self):
        def respond(h, req):
            start_stream(h)
            write(h, data({"choices": [{"index": 0, "delta": {"content": "{\"patch\": [1, 2"}}]}))
            write(h, data({"choices": [{"index": 0, "delta": {}, "finish_reason": "length"}]}))
            write(h, "data: [DONE]\n\n")
        f = self.fake(respond)
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base))
        self.assertEqual((cm.exception.code, cm.exception.message), ("truncated", aiapi.TRUNCATED))
        self.assertIn("回答被截断了（达到 max_tokens 上限）", aiapi.TRUNCATED)

    def test_truncated_anthropic_stream(self):
        def respond(h, req):
            start_stream(h)
            for obj in [{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "一半"}},
                        {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 9}},
                        {"type": "message_stop"}]:
                write(h, data(obj))
        f = self.fake(respond)
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base, protocol="anthropic"))
        self.assertEqual(cm.exception.code, "truncated")

    def test_truncated_whole_json(self):
        for protocol, payload in (("openai", {"choices": [{"message": {"content": "半截"}, "finish_reason": "length"}]}),
                                  ("anthropic", {"content": [{"type": "text", "text": "半截"}], "stop_reason": "max_tokens"})):
            with self.subTest(protocol=protocol):
                f = self.fake(reply_json(200, payload))
                with self.assertRaises(ai.AIError) as cm:
                    self.run_chat(self.cfg(f.base, protocol=protocol))
                self.assertEqual(cm.exception.code, "truncated")

    def test_stream_ended_early(self):
        def openai_cut(h, req):
            start_stream(h)
            write(h, data({"choices": [{"index": 0, "delta": {"content": "写到一半"}}]}))   # 没有 [DONE]、没有 finish_reason

        def anthropic_cut(h, req):
            start_stream(h)
            write(h, data({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "写到一半"}}))
        for protocol, respond in (("openai", openai_cut), ("anthropic", anthropic_cut)):
            with self.subTest(protocol=protocol):
                f = self.fake(respond)
                with self.assertRaises(ai.AIError) as cm:
                    self.run_chat(self.cfg(f.base, protocol=protocol))
                self.assertEqual((cm.exception.code, cm.exception.message), ("api_incomplete", aiapi.ENDED_EARLY))

    def test_finish_reason_without_done_is_complete(self):
        def respond(h, req):
            start_stream(h)
            write(h, data({"choices": [{"index": 0, "delta": {"content": "完整的回答"}, "finish_reason": "stop"}]}))
        f = self.fake(respond)
        r, _ = self.run_chat(self.cfg(f.base))
        self.assertEqual(r.text, "完整的回答")

    def test_sse_labelled_as_json(self):
        def respond(h, req):
            start_stream(h, ctype="application/json")
            for e in openai_events("标成 JSON 的流"):
                write(h, e)
        f = self.fake(respond)
        r, _ = self.run_chat(self.cfg(f.base))
        self.assertEqual(r.text, "标成 JSON 的流")

    # ---- 卡住：第一个字节之前只看总时长
    def test_slow_first_byte_is_not_a_stall(self):
        def late_headers(h, req):
            f.stop.wait(1.0)                                                            # 推理模型先想了很久才回响应头
            reply_openai("想好了")(h, req)

        def late_body(h, req):
            start_stream(h)
            f.stop.wait(1.0)                                                            # 响应头之后很久才有第一个字节
            for e in openai_events("想好了"):
                write(h, e)
        for respond in (late_headers, late_body):
            with self.subTest(respond=respond.__name__):
                f = self.fake(respond)
                r, _ = self.run_chat(self.cfg(f.base), timeout=10, stall=0.3)
                self.assertEqual(r.text, "想好了")

    def test_keepalive_counts_as_activity(self):
        def respond(h, req):
            start_stream(h)
            write(h, ": keep-alive\n\n")
            for _ in range(5):
                f.stop.wait(0.2)
                write(h, ": keep-alive\n\n")                                            # 每 0.2 秒一个保活注释
            for e in openai_events("保活之后"):
                write(h, e)
        f = self.fake(respond)
        r, _ = self.run_chat(self.cfg(f.base), timeout=10, stall=0.5)
        self.assertEqual(r.text, "保活之后")

    def test_total_timeout_before_first_byte(self):
        def respond(h, req):
            f.stop.wait(10)                                                             # 连响应头都不发
        f = self.fake(respond)
        t0 = time.monotonic()
        with self.assertRaises(ai.AIError) as cm:
            self.run_chat(self.cfg(f.base), timeout=1, stall=0.2)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertEqual((cm.exception.code, cm.exception.message), ("timeout", "AI 超过 1 秒没有返回，已中止"))


# ================================================================ 不跟随跳转
class TestRedirect(ApiBase):
    def test_post_redirect_to_other_host_not_followed(self):
        other = self.fake(reply_openai("不应该到这里"))
        for status in aiapi.REDIRECT_CODES:
            with self.subTest(status=status):
                f = self.fake(redirect_to(status, other.base + "/v1/chat/completions?token=abc"))
                with self.assertRaises(ai.AIError) as cm:
                    aiapi.stream_chat(self.cfg(f.base + "/v1"), "s", "u", 10, 5, ai.AiJob("fill"))
                self.assertEqual(cm.exception.code, "api_redirect")
                self.assertEqual(cm.exception.message, f"接口地址发生了跳转（HTTP {status} → {other.base}）：请直接填跳转后的地址")
                self.assertEqual(len(f.requests), 1)
        self.assertEqual(other.requests, [])                                            # key 没有被带到另一个地址

    def test_post_redirect_same_host_not_followed(self):
        def respond(h, req):
            if req["path"].startswith("/v1/"):
                redirect_to(307, "/new/chat/completions")(h, req)
            else:
                reply_openai("不应该到这里")(h, req)
        f = self.fake(respond)
        with self.assertRaises(ai.AIError) as cm:
            aiapi.stream_chat(self.cfg(f.base + "/v1"), "s", "u", 10, 5, ai.AiJob("fill"))
        self.assertEqual(cm.exception.message, f"接口地址发生了跳转（HTTP 307 → {f.base}/new/chat/completions）：请直接填跳转后的地址")
        self.assertEqual([r["path"] for r in f.requests], ["/v1/chat/completions"])

    def test_get_models_redirect_not_followed(self):
        other = self.fake(reply_json(200, {"data": [{"id": "x"}]}))
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status, where="other"):
                f = self.fake(redirect_to(status, other.base + "/v1/models"))
                with self.assertRaises(ai.AIError) as cm:
                    aiapi.list_models(self.cfg(f.base + "/v1"))
                self.assertEqual(cm.exception.code, "api_redirect")
                self.assertIn(f"HTTP {status} → {other.base}）", cm.exception.message)
            with self.subTest(status=status, where="same"):
                f = self.fake(redirect_to(status, "/v1/models/"))
                with self.assertRaises(ai.AIError) as cm:
                    aiapi.list_models(self.cfg(f.base + "/v1"))
                self.assertEqual(cm.exception.code, "api_redirect")
                self.assertEqual(len(f.requests), 1)
        self.assertEqual(other.requests, [])

    def test_redirect_message_has_no_key_or_query(self):
        f = self.fake(redirect_to(302, f"https://elsewhere.example/v1/chat/completions?key={KEY}#x"))
        with self.assertRaises(ai.AIError) as cm:
            aiapi.stream_chat(self.cfg(f.base + "/v1"), "s", "u", 10, 5, ai.AiJob("fill"))
        self.assertEqual(cm.exception.message, "接口地址发生了跳转（HTTP 302 → https://elsewhere.example）：请直接填跳转后的地址")
        self.assert_no_key(cm.exception.message)

    def test_test_endpoint_reports_redirect(self):
        f = self.fake(redirect_to(301, "https://elsewhere.example/v1/chat/completions"))
        client = TestClient(app, base_url="http://127.0.0.1:8099")
        body = client.post("/v2/ai/test", json={"base_url": f.base + "/v1", "model": "m", "api_key": KEY}, headers=GUARD).json()
        self.assertEqual((body["ok"], body["error_code"]), (False, "api_redirect"))
        self.assertIn("接口地址发生了跳转（HTTP 301 → https://elsewhere.example）", body["error"])


# ================================================================ 连接中途取消
class TestCancelConnect(ApiBase):
    def hold(self):
        h = HoldTCP()
        self.addCleanup(h.close)
        return h

    def _run_and_cancel(self, target, ready, delay=0.6):
        """target() 在线程里跑；ready 之后再等 delay 秒取消，返回（结果或异常, 从取消到返回的秒数）。"""
        out = {}

        def go():
            try:
                out["r"] = target()
            except BaseException as e:  # noqa: BLE001
                out["r"] = e
            out["t"] = time.monotonic()
        t = threading.Thread(target=go, daemon=True)
        t.start()
        self.assertTrue(ready(), "没有走到要取消的那一步")
        time.sleep(delay)
        t0 = time.monotonic()
        self.cancel()
        t.join(10)
        self.assertFalse(t.is_alive(), "取消后请求没有返回")
        return out["r"], out["t"] - t0

    def test_cancel_during_tls_handshake_releases_slot(self):
        """对方接了 TCP 连接但不做 TLS 握手：取消要马上返回，同时占着的 AI 请求名额要还回去。"""
        h = self.hold()
        self.write_cfg({"protocol": "openai", "base_url": f"https://127.0.0.1:{h.port}/v1", "model": "m", "api_key": KEY})
        job = ai.AiJob("fill")
        self.cancel = job.cancel
        r, dt = self._run_and_cancel(lambda: ai.run_engine("api", "fill", "s", "u", 30, job), lambda: h.accepted.wait(5))
        self.assertIsInstance(r, ai.AIError)
        self.assertEqual(r.code, "cancelled")
        self.assertLess(dt, 1.0)
        got = [ai._SEM.acquire(timeout=0.5) for _ in range(2)]
        for g in got:
            if g:
                ai._SEM.release()
        self.assertEqual(got, [True, True])                                             # 两个名额都空着

    def test_cancel_during_proxy_connect(self):
        """经 HTTPS 代理时，代理接了连接但不回 CONNECT：取消也要马上返回。只连本机的假代理，不解析别的域名。"""
        h = self.hold()
        real = socket.getaddrinfo

        def only_local(host, *a, **kw):
            self.assertEqual(host, "127.0.0.1")
            return real(host, *a, **kw)
        proxy = {"HTTPS_PROXY": f"http://127.0.0.1:{h.port}", "NO_PROXY": ""}
        job = ai.AiJob("fill")
        self.cancel = job.cancel
        cfg = self.cfg("https://api.example.invalid/v1")
        with mock.patch.dict(os.environ, proxy), mock.patch("socket.getaddrinfo", side_effect=only_local):
            r, dt = self._run_and_cancel(lambda: aiapi.stream_chat(cfg, "s", "u", 30, 30, job), lambda: h.accepted.wait(5))
        self.assertIsInstance(r, ai.AIError)
        self.assertEqual(r.code, "cancelled")
        self.assertLess(dt, 1.0)

    def test_cancel_before_tcp_connect_returns(self):
        """TCP 连接一直没有结果（例如对方不回 SYN）：取消也要马上返回。"""
        started = threading.Event()

        def never(sock, addr):
            started.set()
            return 10035                                                                # 「还在连」

        job = ai.AiJob("fill")
        self.cancel = job.cancel
        with mock.patch.object(aiapi, "_start_connect", never), \
                mock.patch.object(aiapi, "_wait_connect", lambda s, t: time.sleep(t) or False):
            r, dt = self._run_and_cancel(lambda: aiapi.stream_chat(self.cfg("http://127.0.0.1:9/v1"), "s", "u", 30, 30, job),
                                         lambda: started.wait(5), delay=0.3)
        self.assertIsInstance(r, ai.AIError)
        self.assertEqual(r.code, "cancelled")
        self.assertLess(dt, 1.0)

    def test_tcp_connect_timeout(self):
        with mock.patch.object(aiapi, "_start_connect", lambda s, a: 10035), \
                mock.patch.object(aiapi, "_wait_connect", lambda s, t: time.sleep(t) or False):
            t0 = time.monotonic()
            with self.assertRaises(ai.AIError) as cm:
                aiapi.stream_chat(self.cfg("http://127.0.0.1:9/v1"), "s", "u", 1, 30, ai.AiJob("fill"))
        self.assertLess(time.monotonic() - t0, 3)
        self.assertEqual(cm.exception.code, "api_connect")
        self.assertIn("连接超时", cm.exception.message)


# ================================================================ key 的格式、报错里的 key
class TestKeySafety(ApiBase):
    def test_env_key_with_newline_is_not_sent(self):
        f = self.fake(reply_openai("OK"))
        self.write_cfg({"protocol": "openai", "base_url": f.base, "model": "m", "api_key": ""})
        bad = "sk-AAAA\nBBBB-1234"
        with mock.patch.dict(os.environ, {settings.API_KEY_ENV: bad}):
            a = settings.api_config()
            self.assertEqual(a["api_key"], bad)
            want = aiapi.BAD_KEY + f"（key 来自环境变量 {settings.API_KEY_ENV}）"
            self.assertEqual(aiapi.configured(a), (False, want))
            self.assertEqual(ai.status()["engines"][0]["note"], want)
            with self.assertRaises(ai.AIError) as cm:
                aiapi.stream_chat(a, "s", "u", 10, 5, ai.AiJob("fill"))
            self.assertEqual((cm.exception.code, cm.exception.message), ("bad_key", want))
            client = TestClient(app, base_url="http://127.0.0.1:8099")
            body = client.post("/v2/ai/test", json={"base_url": f.base, "model": "m"}, headers=GUARD).json()
            self.assertEqual((body["ok"], body["error_code"], body["error"]), (False, "bad_key", want))
            body = client.post("/v2/ai/models", json={"base_url": f.base}, headers=GUARD).json()
            self.assertEqual((body["ok"], body["error"]), (False, want))
            self.assertEqual(client.get("/v2/ai/config").json()["problem"], want)
        self.assertEqual(f.requests, [])                                                # 一个请求都没发出去

    def test_hand_edited_key_with_space_is_not_sent(self):
        f = self.fake(reply_openai("OK"))
        self.write_cfg({"protocol": "openai", "base_url": f.base, "model": "m", "api_key": "sk-hand edited-1234"})
        r = ai.fill("2024 年的", default_spec(), "api")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], aiapi.BAD_KEY)
        self.assertEqual(f.requests, [])

    def test_redact_escaped_forms(self):
        for key in ("sk-AAAA\nBBBB-1234", "sk-tab\there-5678", "sk-密钥-abcd1234", "sk-quote\"back\\slash-9999"):
            with self.subTest(key=key):
                texts = [f"Invalid header value {('Bearer ' + key).encode('utf-8', 'backslashreplace')!r}",
                         f"value {key!r}", json.dumps({"k": key}), json.dumps({"k": key}, ensure_ascii=False),
                         " ".join(key.split()), key]
                for t in texts:
                    out = aiapi.redact(t, key)
                    self.assertIn(aiapi.key_hint(key), out, t)
                    self.assertNotIn(key[:6], out, t)

    def test_redact_before_clip(self):
        """key 正好在截断的位置：先截短再替换的话会留下 key 的前半截。"""
        f = self.fake(reply_json(400, {"error": {"message": "x" * 290 + " " + KEY}}))
        with self.assertRaises(ai.AIError) as cm:
            aiapi.stream_chat(self.cfg(f.base), "s", "u", 10, 5, ai.AiJob("fill"))
        self.assertNotIn(KEY[:8], cm.exception.message)
        self.assertIn("…WXYZ", cm.exception.message)
        self.assertNotIn(KEY[:8], aiapi._provider_message(("y" * 290 + KEY).encode(), KEY))


# ================================================================ 接进 fill / ask
class TestEngineApi(ApiBase):
    def use_fake(self, respond, preset=None):
        f = self.fake(respond)
        self.write_cfg({"protocol": "openai", "preset": preset, "base_url": f.base + "/v1", "model": "test-model",
                        "api_key": KEY})
        return f

    def test_fill_job_via_api(self):
        out = json.dumps({"patch": patch_2024(["百合"]), "defaults_used": [], "note": None, "alternative": None},
                         ensure_ascii=False)
        f = self.use_fake(reply_openai(out, step=40))
        events = []
        job = ai.AiJob("fill", emit=lambda ev, d: events.append((ev, d)))
        r = ai.fill_job("2024 年的百合番角色，别太冷门", default_spec(), "api", job)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["total"], r["engine"], r["ai_calls"], r["warm"]), (9, "api", 1, False))
        self.assertIn("正在连接 127.0.0.1", [d["message"] for ev, d in events if ev == "status"])
        self.assertEqual(f.requests[0]["body"]["model"], "test-model")
        self.assert_no_key(json.dumps(r, ensure_ascii=False))

    def test_ask_job_via_api(self):
        self.use_fake(reply_openai(ask_text(GOOD_SQL), step=30))
        r = ai.ask_job("热度最高的 3 个角色", None, ai.AiJob("ask"))        # 不传 engine：默认就是 api
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["engine"], "api")
        self.assertEqual([row[0] for row in r["rows"]], [9, 5, 1])

    def test_provider_error_reaches_result(self):
        self.use_fake(reply_json(401, {"error": {"message": "invalid key"}}))
        r = ai.fill("2024 年的", default_spec(), "api")
        self.assertFalse(r["ok"])
        self.assertIn("API key 不对", r["error"])

    def test_not_configured(self):
        self.write_cfg({"base_url": "https://api.deepseek.com", "model": "", "api_key": KEY})
        self.assertEqual(ai.engine_ready("api"), (False, aiapi.NOT_CONFIGURED))
        r = ai.fill("2024 年的", default_spec(), "api")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], aiapi.NOT_CONFIGURED)
        st = ai.status()
        api = st["engines"][0]
        self.assertEqual((api["id"], api["available"], api["channel_ok"], api["note"]), ("api", False, False, aiapi.NOT_CONFIGURED))
        self.assertEqual(st["default"], "api")

    def test_status_labels_and_warm(self):
        self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "deepseek-flash", "api_key": KEY})
        engines = {e["id"]: e for e in ai.status()["engines"]}
        self.assertEqual(list(engines), ["api", "claude", "codex"])
        self.assertEqual((engines["api"]["label"], engines["api"]["model"]), ("DeepSeek", "deepseek-flash"))
        self.assertTrue(engines["api"]["available"] and engines["api"]["channel_ok"])
        self.assertEqual((engines["api"]["warm"], engines["api"]["slow"]), (False, False))
        self.assertEqual(engines["claude"]["label"], "Claude（本机命令行）")
        self.assertEqual(engines["codex"]["label"], "Codex（本机命令行）")
        self.assert_no_key(json.dumps(ai.status(), ensure_ascii=False))
        r = ai.warm(["fill"])
        self.assertEqual((r["warming"], r["note"]), ([], "API 不需要预热"))

    def test_ai_config_merges_api_defaults(self):
        self.write_cfg({"model": "only-model"})
        a = settings.ai_config()
        self.assertEqual(a["timeout_s"], 90)                                            # 配置里写了的
        self.assertEqual(a["stall_s"], 60)                                              # 没写的用默认值
        self.assertEqual(a["api"], {**settings.API_DEFAULTS, "model": "only-model"})
        self.assertEqual(a["default_engine"], "api")


# ================================================================ 设置接口
class TestConfigEndpoints(ApiBase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(app, base_url="http://127.0.0.1:8099")

    def put(self, body, headers=GUARD):
        return self.client.put("/v2/ai/config", json=body, headers=headers)

    def form(self, base_url="https://api.deepseek.com", **kw):
        return {"protocol": "openai", "preset": "deepseek", "base_url": base_url, "model": "deepseek-flash",
                "max_tokens": None, **kw}

    def test_get_never_returns_key(self):
        self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})
        r = self.client.get("/v2/ai/config")
        self.assertEqual(r.status_code, 200)
        self.assert_no_key(r.text)
        self.assertEqual(r.json(), {"protocol": "openai", "preset": "deepseek", "base_url": "https://api.deepseek.com",
                                    "model": "m", "max_tokens": None, "has_key": True, "key_hint": "…WXYZ",
                                    "key_from_env": False, "configured": True, "problem": None})
        self.assert_no_key(self.client.get("/v2/ai/status").text)

    def test_put_keeps_other_sections(self):
        before = self.write_cfg({})
        r = self.put(self.form("https://api.deepseek.com/chat/completions", api_key=f"  {KEY}\n"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assert_no_key(r.text)
        body = r.json()
        self.assertEqual((body["ok"], body["message"], body["key_cleared"]), (True, None, False))
        self.assertEqual(body["config"]["base_url"], "https://api.deepseek.com")         # 存的是整理过的地址
        self.assertEqual(body["config"]["key_hint"], "…WXYZ")
        after = self.read_cfg()
        for k in ("_comment", "autoclick", "classic"):
            self.assertEqual(after[k], before[k])
        self.assertEqual({k: after["v2"][k] for k in ("_comment", "db_path")}, {"_comment": "v2 段说明", "db_path": "data/x.sqlite"})
        self.assertEqual(after["v2"]["ai"]["timeout_s"], 90)
        self.assertEqual(after["v2"]["ai"]["api"], {"protocol": "openai", "preset": "deepseek",
                                                    "base_url": "https://api.deepseek.com", "model": "deepseek-flash",
                                                    "api_key": KEY, "max_tokens": None})
        self.assertNotIn("_config_path", after)
        self.assertNotIn("data_paths", after)
        self.assertEqual(os.listdir(self.tmp), ["config.json"])                          # 临时文件没留下

    def test_put_starts_from_example_when_missing(self):
        self.assertFalse(os.path.exists(self.cfg_path))
        r = self.put(self.form(api_key=KEY))
        self.assertEqual(r.status_code, 200, r.text)
        with open(paths.example_config_file(), "r", encoding="utf-8") as fh:
            example = json.load(fh)
        after = self.read_cfg()
        self.assertEqual(after["_comment"], example["_comment"])
        self.assertEqual(after["v2"]["_comment"], example["v2"]["_comment"])
        self.assertEqual(after["v2"]["ai"]["api"]["api_key"], KEY)

    def test_key_rules(self):
        self.write_cfg({})
        self.assertEqual(self.put(self.form(api_key=KEY)).status_code, 200)
        r = self.put(self.form(model="deepseek-pro"))                                    # 不传 key：不变
        self.assertEqual(r.json()["config"]["key_hint"], "…WXYZ")
        r = self.put(self.form(api_key=""))                                              # 空字符串也是不改
        self.assertTrue(r.json()["config"]["has_key"])
        r = self.put(self.form("https://api.moonshot.cn/v1", preset="moonshot"))         # 换了域名、请求里没带 key：清掉
        body = r.json()
        self.assertEqual(body["message"], "接口地址换了，原来的 API key 已清掉，请重新填")
        self.assertTrue(body["key_cleared"])
        self.assertFalse(body["config"]["has_key"])
        self.assertEqual(self.read_cfg()["v2"]["ai"]["api"]["api_key"], "")
        self.put(self.form("https://api.moonshot.cn/v1", preset="moonshot", api_key="sk-other-key-5678"))
        r = self.put(self.form("https://api.moonshot.cn/v1", preset="moonshot", clear_key=True))
        self.assertTrue(r.json()["key_cleared"])
        self.assertFalse(r.json()["config"]["has_key"])
        r = self.put(self.form("https://api.deepseek.com", api_key=KEY))                 # 换域名时请求里带了 key：存带来的 key
        self.assertIsNone(r.json()["message"])
        self.assertEqual(r.json()["config"]["key_hint"], "…WXYZ")

    def test_validation(self):
        self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})
        before = _snapshot(self.cfg_path)
        bad = [self.form(protocol="gemini"), self.form("ftp://x.example"), self.form(""), self.form("https://exa mple.com"),
               self.form(model=""), self.form(model="m" * 201), self.form(api_key="sk with space"),
               self.form(api_key="k" * 501), self.form(api_key="密钥"), self.form(max_tokens=0),
               self.form(max_tokens="100"), self.form(preset=123)]
        for b in bad:
            with self.subTest(body=b):
                r = self.put(b)
                self.assertEqual(r.status_code, 422, r.text)
                self.assertEqual(r.json()["ok"], False)
                self.assertTrue(r.json()["message"])
        self.assertEqual(self.put(["不是对象"]).status_code, 422)
        self.assertEqual(_snapshot(self.cfg_path), before)                               # 都没写
        self.assertEqual(self.put(self.form(protocol="anthropic", base_url="", model="claude-x")).status_code, 200)
        self.assertEqual(self.read_cfg()["v2"]["ai"]["api"]["base_url"], "https://api.anthropic.com")

    def test_env_key_wins(self):
        self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})
        env_key = "sk-from-env-99998888"
        with mock.patch.dict(os.environ, {settings.API_KEY_ENV: env_key}):
            self.assertEqual(settings.api_config()["api_key"], env_key)
            body = self.client.get("/v2/ai/config").json()
            self.assertEqual((body["key_from_env"], body["key_hint"]), (True, "…8888"))
            for b in (self.form(api_key="sk-new-key-0000"), self.form(clear_key=True)):
                r = self.put(b)
                self.assertEqual(r.status_code, 409)
                self.assertEqual(r.json()["error"], "key_from_env")
                self.assertIn(settings.API_KEY_ENV, r.json()["message"])
            self.assertEqual(self.put(self.form(model="m2")).status_code, 200)            # 别的字段照样能改
            saved = self.read_cfg()["v2"]["ai"]["api"]
            self.assertEqual((saved["model"], saved["api_key"]), ("m2", KEY))             # 环境变量的 key 不写进文件
        self.assertNotIn(env_key, json.dumps(self.read_cfg()))

    def test_write_guard(self):
        self.write_cfg({})
        before = _snapshot(self.cfg_path)
        for method, path in (("PUT", "/v2/ai/config"), ("POST", "/v2/ai/test"), ("POST", "/v2/ai/models")):
            with self.subTest(path=path):
                r = self.client.request(method, path, json=self.form(api_key=KEY))
                self.assertEqual((r.status_code, r.json()["error"]), (403, "missing_guard_header"))
                r = self.client.request(method, path, json=self.form(api_key=KEY),
                                        headers={**GUARD, "Origin": "https://evil.example"})
                self.assertEqual((r.status_code, r.json()["error"]), (403, "forbidden_origin"))
        self.assertEqual(_snapshot(self.cfg_path), before)

    def test_test_endpoint(self):
        f = self.fake(reply_openai("OK"))
        r = self.client.post("/v2/ai/test", json={"protocol": "openai", "base_url": f.base + "/v1", "model": "m",
                                                  "api_key": KEY}, headers=GUARD)
        body = r.json()
        self.assertEqual((body["ok"], body["reply"], body["error"]), (True, "OK", None))
        self.assertIsInstance(body["ms"], int)
        self.assertEqual(f.requests[0]["body"]["messages"][0]["content"], "只回复 OK")
        self.assertFalse(os.path.exists(self.cfg_path))                                 # 测试不保存
        # 没给 key：域名和已保存的一样 → 用已保存的 key
        self.write_cfg({"base_url": f.base + "/v1", "model": "m", "api_key": KEY})
        self.client.post("/v2/ai/test", json={"base_url": f.base + "/v1", "model": "m2"}, headers=GUARD)
        self.assertEqual(f.requests[1]["headers"]["authorization"], f"Bearer {KEY}")
        self.assertEqual(f.requests[1]["body"]["model"], "m2")
        # 域名不一样：已保存的 key 不发过去
        self.assertEqual(aiapi.form_config({"base_url": "http://localhost:9/v1", "model": "m"}, True)["api_key"], "")
        r = self.client.post("/v2/ai/test", json={"base_url": "http://x", "model": ""}, headers=GUARD).json()
        self.assertEqual((r["ok"], r["error"]), (False, "模型名要填"))

    def test_test_endpoint_reports_error(self):
        f = self.fake(reply_json(401, {"error": {"message": f"bad {KEY}"}}))
        body = self.client.post("/v2/ai/test", json={"base_url": f.base, "model": "m", "api_key": KEY}, headers=GUARD).json()
        self.assertFalse(body["ok"])
        self.assertIn("API key 不对", body["error"])
        self.assert_no_key(json.dumps(body, ensure_ascii=False))

    def test_models_endpoint(self):
        f = self.fake(reply_json(200, {"object": "list", "data": [{"id": "b-model"}, {"id": "a-model"}, {"id": "b-model"}]}))
        body = self.client.post("/v2/ai/models", json={"base_url": f.base + "/v1", "api_key": KEY}, headers=GUARD).json()
        self.assertEqual(body, {"ok": True, "models": ["a-model", "b-model"], "error": None})
        req = f.requests[0]
        self.assertEqual((req["method"], req["path"], req["headers"]["authorization"]), ("GET", "/v1/models", f"Bearer {KEY}"))
        body = self.client.post("/v2/ai/models", json={"protocol": "anthropic", "base_url": "", "api_key": KEY},
                                headers=GUARD).json()
        self.assertFalse(body["ok"])
        self.assertIn("Anthropic", body["error"])
        f2 = self.fake(reply_json(404, {"error": "not found"}))
        body = self.client.post("/v2/ai/models", json={"base_url": f2.base}, headers=GUARD).json()
        self.assertFalse(body["ok"])
        self.assertIn("HTTP 404", body["error"])

    # ---- 「同一个接口地址」= 协议、域名、端口都一样
    def test_scheme_or_port_change_clears_key(self):
        changed = ["http://api.deepseek.com", "https://api.deepseek.com:8443", "https://api.moonshot.cn/v1"]
        same = ["https://api.deepseek.com:443/v1", "https://API.DeepSeek.com/beta"]
        for url in changed + same:
            with self.subTest(url=url):
                self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})
                fc = aiapi.form_config({"base_url": url, "model": "m"}, True)
                body = self.put(self.form(url)).json()
                if url in changed:
                    self.assertEqual(fc["api_key"], "")                                 # 测试 / 列出模型也不带过去
                    self.assertEqual((body["message"], body["key_cleared"], body["config"]["has_key"]),
                                     (aiapi.KEY_CHANGED, True, False))
                    self.assertEqual(self.read_cfg()["v2"]["ai"]["api"]["api_key"], "")
                else:
                    self.assertEqual(fc["api_key"], KEY)
                    self.assertEqual((body["message"], body["key_cleared"], body["config"]["has_key"]), (None, False, True))

    def test_env_key_and_address_change(self):
        self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})
        with mock.patch.dict(os.environ, {settings.API_KEY_ENV: "sk-from-env-99998888"}):
            for url in ("https://api.moonshot.cn/v1", "http://api.moonshot.cn/v1", "https://api.moonshot.cn:8443/v1"):
                with self.subTest(url=url):
                    body = self.put(self.form(url, preset="moonshot")).json()
                    self.assertEqual(body["message"], aiapi.ENV_KEY_MOVES)
                    self.assertIn(settings.API_KEY_ENV, body["message"])
                    self.assertEqual((body["key_cleared"], body["config"]["has_key"], body["config"]["key_from_env"]),
                                     (False, True, True))                               # 实际用的 key 没变
            body = self.put(self.form("https://api.moonshot.cn:8443/v1", preset="moonshot", model="m3")).json()
            self.assertEqual((body["message"], body["key_cleared"]), (None, False))      # 地址没变：不提示
        self.assertEqual(self.read_cfg()["v2"]["ai"]["api"]["api_key"], "")             # 文件里存的、给上一个地址的 key 清掉了

    # ---- 同时保存
    def test_concurrent_saves_are_serialized(self):
        self.write_cfg({})
        self.assertEqual(self.put(self.form(api_key=KEY)).status_code, 200)
        real_save = settings.save_api_config
        state = {"in": 0, "max": 0}
        lock = threading.Lock()

        def slow_save(api):
            with lock:
                state["in"] += 1
                state["max"] = max(state["max"], state["in"])
            try:
                time.sleep(0.02)                                                        # 把「读 → 写」之间的空档拉长
                return real_save(api)
            finally:
                with lock:
                    state["in"] -= 1
        errors = []
        stop = threading.Event()

        def save(i):
            try:
                aiapi.update_config(self.form(model=f"m{i}"))
            except Exception as e:  # noqa: BLE001
                errors.append(repr(e))

        def read():
            while not stop.is_set():
                try:
                    settings.api_config()
                    aiapi.public_config()
                except Exception as e:  # noqa: BLE001
                    errors.append(repr(e))
                time.sleep(0.002)
        readers = [threading.Thread(target=read, daemon=True) for _ in range(3)]
        with mock.patch.object(settings, "save_api_config", slow_save):
            for t in readers:
                t.start()
            savers = [threading.Thread(target=save, args=(i,), daemon=True) for i in range(12)]
            for t in savers:
                t.start()
            for t in savers:
                t.join(30)
            stop.set()
            for t in readers:
                t.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(state["max"], 1)                                               # 同一时间只有一个在写
        api = self.read_cfg()["v2"]["ai"]["api"]
        self.assertEqual(api["api_key"], KEY)                                           # key 没丢
        self.assertIn(api["model"], {f"m{i}" for i in range(12)})
        self.assertEqual(os.listdir(self.tmp), ["config.json"])                          # 临时文件没留下

    def test_concurrent_saves_without_patch(self):
        self.write_cfg({})
        self.assertEqual(self.put(self.form(api_key=KEY)).status_code, 200)
        errors = []

        def save(i):
            try:
                aiapi.update_config(self.form(model=f"m{i}"))
            except Exception as e:  # noqa: BLE001
                errors.append(repr(e))
        ts = [threading.Thread(target=save, args=(i,), daemon=True) for i in range(16)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(self.read_cfg()["v2"]["ai"]["api"]["api_key"], KEY)
        self.assertEqual(os.listdir(self.tmp), ["config.json"])

    # ---- 接口地址的格式
    def test_url_with_userinfo_query_or_backslash_rejected(self):
        self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})
        before = _snapshot(self.cfg_path)
        cases = {"https://user:pw@api.example.com/v1": "接口地址里不要带用户名或密码（@ 和它前面的部分）",
                 "https://api.example.com@evil.example/v1": "接口地址里不要带用户名或密码（@ 和它前面的部分）",
                 "https://api.example.com\\v1": "接口地址里不能有反斜杠 \\",
                 "https://api.example.com/v1?api-version=1": "接口地址里不要带 ? 参数",
                 "https://api.example.com/v1#x": "接口地址里不要带 # 和后面的内容",
                 "https://api.example.com:99999/v1": "接口地址的端口不对",
                 "https://api.example.com:abc/v1": "接口地址的端口不对",
                 "https://api.exa\x01mple.com/v1": "接口地址里有不能用的字符"}
        for url, msg in cases.items():
            with self.subTest(url=url):
                self.assertEqual(aiapi.check_url(url), msg)
                r = self.put(self.form(url))
                self.assertEqual((r.status_code, r.json()["message"]), (422, msg))
                body = self.client.post("/v2/ai/test", json={"base_url": url, "model": "m", "api_key": KEY}, headers=GUARD).json()
                self.assertEqual((body["ok"], body["error"]), (False, msg))
        self.assertEqual(_snapshot(self.cfg_path), before)
        self.assertIsNone(aiapi.check_url("http://[::1]:1234/v1"))
        # 手改配置文件写进去的：输入条显示原因，请求不发出去
        self.write_cfg({"base_url": "https://api.example.com/v1?x=1", "model": "m", "api_key": KEY})
        ok, note = aiapi.configured(settings.api_config())
        self.assertEqual((ok, note), (False, "AI 接口地址有问题：接口地址里不要带 ? 参数，在「设置 → AI」里改"))

    def test_bad_characters_in_model_or_preset(self):
        self.write_cfg({"preset": "deepseek", "base_url": "https://api.deepseek.com", "model": "m", "api_key": KEY})
        before = _snapshot(self.cfg_path)
        for b, msg in ((self.form(model="m\ud800"), "模型名里有不能用的字符"), (self.form(model="m\x00x"), "模型名里有不能用的字符"),
                       (self.form(preset="deep\ud83dseek"), "服务商（preset）里有不能用的字符")):
            with self.subTest(body=b):
                raw = json.dumps(b).encode("ascii")                                     # 单独的代理码元只能用 \ud800 这种转义发
                r = self.client.put("/v2/ai/config", content=raw, headers={**GUARD, "Content-Type": "application/json"})
                self.assertEqual((r.status_code, r.json()["message"]), (422, msg))
        self.assertEqual(_snapshot(self.cfg_path), before)

    # ---- config.json 读不出来
    def test_corrupt_config_is_reported(self):
        for text in ("{ 不是 JSON", "[1, 2]"):
            with self.subTest(text=text):
                with open(self.cfg_path, "w", encoding="utf-8") as fh:
                    fh.write(text)
                before = _snapshot(self.cfg_path)
                r = self.client.get("/v2/ai/config")
                self.assertEqual((r.status_code, r.json()["error"]), (500, "config_invalid"))
                self.assertIn("读不出来（不是合法的 JSON），先修好或删掉它", r.json()["message"])
                r = self.put(self.form(api_key=KEY))
                self.assertEqual((r.status_code, r.json()["error"]), (500, "config_invalid"))
                self.assertIn("读不出来（不是合法的 JSON），没有保存。先修好或删掉它", r.json()["message"])
                self.assert_no_key(r.text)
                self.assertEqual(_snapshot(self.cfg_path), before)                       # 没有覆盖它
                api = ai.status()["engines"][0]                                           # 输入条说的是文件的问题，不说「还没设置」
                self.assertFalse(api["available"])
                self.assertIn("读不出来（不是合法的 JSON），先修好或删掉它", api["note"])
                self.assertEqual(ai.engine_ready("api"), (False, api["note"]))
        os.remove(self.cfg_path)
        self.assertEqual(ai.status()["engines"][0]["note"], aiapi.NOT_CONFIGURED)
        self.assertEqual(self.client.get("/v2/ai/config").status_code, 200)              # 文件不存在：用默认设置

    def test_config_label(self):
        self.assertEqual(settings.config_label(), self.cfg_path)
        with mock.patch.dict(os.environ, {"OUTSETTER_CONFIG": ""}):
            self.assertEqual(settings.config_label(), "backend/config.json")


if __name__ == "__main__":
    unittest.main()
