# -*- coding: utf-8 -*-
"""写请求守卫（backend/writeguard.py）和它在 backend/app.py 里的挂法。

用真正的 backend.app（合成库）：放行的例子只用不碰浏览器、不烧 AI 额度的接口
（/v2/evaluate 只读计算，/v2/lists 是 GET）；会启停点击器、调 AI 的接口只做被拒绝的例子——
被拒绝时请求到不了处理函数。
"""
from __future__ import annotations

import json
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from . import base
from backend.app import app
from backend.v2.storage import LISTS
from backend.v2.router import router as v2_router
from backend.writeguard import check_write_request

LOCAL = "http://127.0.0.1:5175"
EVIL = "https://evil.example"
GUARD = {"X-Outsetter": "1"}
SPEC = base.spec([base.one(base.rng(rank_to=2))])

client = TestClient(app, base_url="http://127.0.0.1:8099")


def _lists_named(name):
    return [d for d in LISTS.all() if d.get("name") == name]


def post(path, *, headers=None, **kw):
    return client.post(path, headers=headers or {}, **kw)


class TestRejected(unittest.TestCase):
    def test_external_origin_post_rejected(self):
        r = post("/v2/evaluate", headers={"Origin": EVIL, **GUARD}, json={"spec": SPEC})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "forbidden_origin")
        self.assertNotIn("access-control-allow-origin", r.headers)

    def test_origin_null_and_lookalike_hosts_rejected(self):
        for origin in ("null", "http://127.0.0.1.evil.example", "http://localhost@evil.example",
                       "https://127.0.0.1:5175", "http://127.0.0.1:5175/", "chrome-extension://abcdef"):
            with self.subTest(origin=origin):
                r = post("/v2/evaluate", headers={"Origin": origin, **GUARD}, json={"spec": SPEC})
                self.assertEqual(r.status_code, 403)

    def test_post_without_content_type_rejected_and_nothing_written(self):
        """不带 Content-Type 的 POST（简单请求，不触发预检）：后端会按 JSON 解析请求体，守卫要在这之前拒掉。"""
        payload = json.dumps({"name": "csrf-probe", "kind": "tag", "items": ["x"]}).encode()
        r = post("/v2/lists", headers={"Origin": EVIL}, content=payload)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(_lists_named("csrf-probe"), [])

    def test_guard_matters_on_unguarded_app(self):
        """对照：没有守卫的同一组路由，同样的请求真的会写出清单。"""
        bare = TestClient(FastAPI(), base_url="http://127.0.0.1:8099")
        bare.app.include_router(v2_router)
        payload = json.dumps({"name": "csrf-probe-bare", "kind": "tag", "items": ["x"]}).encode()
        try:
            r = bare.post("/v2/lists", headers={"Origin": EVIL}, content=payload)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(len(_lists_named("csrf-probe-bare")), 1)
        finally:
            for it in _lists_named("csrf-probe-bare"):
                LISTS.delete(it["id"])

    def test_missing_custom_header_rejected(self):
        for headers in ({}, {"Origin": LOCAL}):
            with self.subTest(headers=headers):
                r = post("/v2/evaluate", headers=headers, json={"spec": SPEC})
                self.assertEqual(r.status_code, 403)
                self.assertEqual(r.json()["error"], "missing_guard_header")
                self.assertIn("X-Outsetter", r.json()["message"])

    def test_wrong_header_value_rejected(self):
        r = post("/v2/evaluate", headers={"X-Outsetter": "0"}, json={"spec": SPEC})
        self.assertEqual(r.status_code, 403)

    def test_cross_site_fetch_metadata_rejected(self):
        r = post("/v2/evaluate", headers={"Sec-Fetch-Site": "cross-site", **GUARD}, json={"spec": SPEC})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "forbidden_origin")

    def test_body_less_posts_from_forms_rejected(self):
        """没有请求体的写接口：普通表单就能打，必须靠守卫挡（Origin 是表单提交时浏览器自动带的）。"""
        for path in ("/autoclick/cancel", "/autoclick/auto/stop", "/v2/autoclick/auto/start", "/v2/ai/warm", "/v2/ai/cancel"):
            with self.subTest(path=path):
                r = post(path, headers={"Origin": EVIL}, content=b"")
                self.assertEqual(r.status_code, 403)
                r = post(path, headers={"Origin": EVIL, "Content-Type": "application/x-www-form-urlencoded"}, content=b"a=1")
                self.assertEqual(r.status_code, 403)

    def test_other_write_methods_rejected(self):
        for method in ("put", "patch", "delete", "post"):
            with self.subTest(method=method):
                r = getattr(client, method)("/v2/lists/l_t", headers={"Origin": EVIL, **GUARD})
                self.assertEqual(r.status_code, 403)
        self.assertIsNotNone(LISTS.get("l_t"))

    def test_streaming_endpoints_rejected_before_streaming(self):
        for path in ("/v2/ai/ask/stream", "/v2/ai/fill/stream", "/v2/ai/ask/fix/stream"):
            with self.subTest(path=path):
                r = post(path, headers={"Origin": EVIL}, content=b"{}")
                self.assertEqual(r.status_code, 403)
                self.assertIn("application/json", r.headers["content-type"])


class TestAllowed(unittest.TestCase):
    def test_local_frontend_request_passes(self):
        for origin in (LOCAL, "http://localhost:5173", "http://127.0.0.1"):
            with self.subTest(origin=origin):
                r = post("/v2/evaluate", headers={"Origin": origin, **GUARD}, json={"spec": SPEC})
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.json()["total"], 9)
                self.assertEqual(r.headers["access-control-allow-origin"], origin)

    def test_script_without_origin_passes_with_header(self):
        r = post("/v2/evaluate", headers=GUARD, json={"spec": SPEC})
        self.assertEqual(r.status_code, 200)

    def test_local_origin_wins_over_cross_site_metadata(self):
        """从 localhost 打开前端、后端地址写 127.0.0.1 时，浏览器把请求标成 cross-site，但 Origin 是本机页面，照常放行。"""
        r = post("/v2/evaluate", headers={"Origin": "http://localhost:5175", "Sec-Fetch-Site": "cross-site", **GUARD},
                 json={"spec": SPEC})
        self.assertEqual(r.status_code, 200)
        r = post("/v2/evaluate", headers={"Origin": LOCAL, "Sec-Fetch-Site": "same-site", **GUARD}, json={"spec": SPEC})
        self.assertEqual(r.status_code, 200)

    def test_get_unaffected(self):
        for headers in ({}, {"Origin": EVIL}, {"Origin": LOCAL}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                r = client.get("/v2/lists", headers=headers)
                self.assertEqual(r.status_code, 200)
        # 外部来源的 GET 也拿不到 CORS 头（网页读不到响应）
        self.assertNotIn("access-control-allow-origin", client.get("/v2/lists", headers={"Origin": EVIL}).headers)

    def test_rejection_is_readable_by_local_page(self):
        """本机页面收到 403 时带 CORS 头，前端读得到「缺少请求头」这句话，而不是笼统的网络错误。"""
        r = post("/v2/evaluate", headers={"Origin": LOCAL}, json={"spec": SPEC})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.headers["access-control-allow-origin"], LOCAL)


class TestCors(unittest.TestCase):
    def preflight(self, origin, headers="content-type,x-outsetter"):
        return client.options("/v2/evaluate", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": headers})

    def test_preflight_from_local_page_allows_guard_header(self):
        r = self.preflight(LOCAL)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["access-control-allow-origin"], LOCAL)
        allowed = r.headers["access-control-allow-headers"].lower()
        self.assertIn("x-outsetter", allowed)
        self.assertIn("content-type", allowed)

    def test_preflight_from_external_page_rejected(self):
        """带自定义头的请求要先预检；外部网页的预检过不了，所以它发不出带 X-Outsetter 的请求。"""
        r = self.preflight(EVIL)
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("access-control-allow-origin", r.headers)

    def test_no_credentials_allowed(self):
        self.assertNotIn("access-control-allow-credentials", self.preflight(LOCAL).headers)
        r = post("/v2/evaluate", headers={"Origin": LOCAL, **GUARD}, json={"spec": SPEC})
        self.assertNotIn("access-control-allow-credentials", r.headers)

    def test_unlisted_request_header_rejected_in_preflight(self):
        self.assertEqual(self.preflight(LOCAL, "content-type,x-outsetter,authorization").status_code, 400)


class TestCheckFunction(unittest.TestCase):
    def test_safe_methods_never_checked(self):
        for m in ("GET", "HEAD", "OPTIONS", "get"):
            self.assertIsNone(check_write_request(m, ["https://evil.example"], ["cross-site"], []))

    def test_write_methods_case_insensitive(self):
        self.assertIsNotNone(check_write_request("post", [], [], []))
        self.assertIsNotNone(check_write_request("DELETE", [], [], []))
        self.assertIsNone(check_write_request("post", [], [], ["1"]))

    def test_any_bad_origin_value_rejects(self):
        self.assertIsNotNone(check_write_request("POST", [LOCAL, EVIL], [], ["1"]))


class TestWiring(unittest.TestCase):
    def test_guard_sits_inside_cors_inside_trusted_host(self):
        names = [m.cls.__name__ for m in app.user_middleware]       # 从外到内
        self.assertEqual(names, ["TrustedHostMiddleware", "CORSMiddleware", "WriteGuardMiddleware"])

    def test_cors_config(self):
        cors = next(m for m in app.user_middleware if m.cls.__name__ == "CORSMiddleware")
        self.assertFalse(cors.kwargs.get("allow_credentials", False))
        self.assertIn("X-Outsetter", cors.kwargs["allow_headers"])


if __name__ == "__main__":
    unittest.main()
