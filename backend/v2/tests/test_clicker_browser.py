# -*- coding: utf-8 -*-
"""点击器的浏览器层：房间页地址怎么认（url_matches）、提示框只替游戏房间页点确定。
全程不连 Chrome、不起 Playwright：用假的上下文 / 页面 / 提示框对象。"""
from __future__ import annotations

import asyncio
import unittest

from . import base  # noqa: F401  （设置合成库环境变量）
from backend.clicker.browser import BrowserManager, url_matches
from backend.clicker.service import DEFAULT_HOST_PATTERNS, ClickerOptions

DEFAULTS = list(DEFAULT_HOST_PATTERNS)


class TestUrlMatches(unittest.TestCase):
    def test_default_rules_match_room_pages(self):
        for url in ("https://anime-character-guessr.netlify.app/multiplayer/abc123",
                    "http://localhost:5173/multiplayer/room?x=1#h",
                    "http://127.0.0.1:5173/multiplayer/",
                    "https://ccb.baka.website/multiplayer/r1",
                    "https://ccbeta.baka.website/multiplayer/r1",
                    "https://ccb.baka.website:443/multiplayer/r1",             # 写出默认端口等于没写
                    "HTTPS://CCB.Baka.Website/Multiplayer/R1"):                # 主机、路径不分大小写
            self.assertTrue(url_matches(url, DEFAULTS), url)

    def test_other_sites_do_not_match(self):
        """规则文字出现在别的网站的地址里，不算游戏页。"""
        for url in ("https://evil.com/?u=ccb.baka.website/multiplayer/",         # 查询串里带着规则
                    "https://evil.com/ccb.baka.website/multiplayer/x",           # 路径里带着规则
                    "https://evil.com/#ccb.baka.website/multiplayer/",           # # 后面带着规则
                    "https://ccb.baka.website.evil.com/multiplayer/",            # 主机只是前缀
                    "https://xccb.baka.website/multiplayer/",                    # 主机只是后缀
                    "https://sub.ccb.baka.website/multiplayer/",                 # 子域名不是同一个主机
                    "https://ccb.baka.website@evil.com/multiplayer/",            # 用户名部分伪装成主机
                    "https://evil.com/@ccb.baka.website/multiplayer/",
                    "http://localhost:5173.evil.com/multiplayer/",
                    "https://anime-character-guessr.netlify.app.evil.com/multiplayer/"):
            self.assertFalse(url_matches(url, DEFAULTS), url)

    def test_port_and_path_are_strict(self):
        for url in ("http://localhost:51730/multiplayer/",                       # 端口只是前缀
                    "http://localhost:5174/multiplayer/",
                    "http://localhost/multiplayer/",                             # 没写端口 = 80，不是 5173
                    "https://ccb.baka.website:8443/multiplayer/x",
                    "https://ccb.baka.website/",                                 # 路径不在前缀下
                    "https://ccb.baka.website/multiplayer",                      # 规则以 / 结尾：不带最后的 / 不算
                    "https://ccb.baka.website/other/multiplayer/"):
            self.assertFalse(url_matches(url, DEFAULTS), url)

    def test_non_http_pages_never_match(self):
        for url in ("", None, "about:blank", "chrome://newtab/", "file:///ccb.baka.website/multiplayer/",
                    "data:text/html,ccb.baka.website/multiplayer/", "javascript:alert(1)", "ftp://ccb.baka.website/multiplayer/",
                    "http://[bad/multiplayer/"):
            self.assertFalse(url_matches(url, DEFAULTS), url)
            self.assertFalse(url_matches(url, ["", "about:blank", "chrome://newtab/"]), url)

    def test_config_styles(self):
        """config 里能写的几种规则写法。"""
        self.assertTrue(url_matches("https://ccb.baka.website/any/path", ["ccb.baka.website"]))           # 只写主机：整站
        self.assertTrue(url_matches("http://ccb.baka.website/", ["ccb.baka.website"]))                    # 没写协议：http / https 都行
        self.assertFalse(url_matches("https://sub.ccb.baka.website/", ["ccb.baka.website"]))
        self.assertFalse(url_matches("https://ccb.baka.website:8080/", ["ccb.baka.website"]))             # 没写端口 = 默认端口
        self.assertTrue(url_matches("https://ccb.baka.website/multiplayer/x", ["https://ccb.baka.website/multiplayer/"]))
        self.assertFalse(url_matches("http://ccb.baka.website/multiplayer/x", ["https://ccb.baka.website/multiplayer/"]))
        self.assertTrue(url_matches("http://localhost:3000/room/1", ["localhost:3000"]))
        self.assertFalse(url_matches("http://localhost:3001/room/1", ["localhost:3000"]))
        self.assertTrue(url_matches("http://[::1]:5173/multiplayer/a", ["[::1]:5173/multiplayer/"]))
        self.assertTrue(url_matches("https://ccb.baka.website/Multiplayer/x", ["CCB.Baka.Website/multiplayer/"]))
        # 路径前缀按目录边界比
        rule = ["ccb.baka.website/multiplayer"]
        self.assertTrue(url_matches("https://ccb.baka.website/multiplayer", rule))
        self.assertTrue(url_matches("https://ccb.baka.website/multiplayer/x", rule))
        self.assertFalse(url_matches("https://ccb.baka.website/multiplayer2/x", rule))
        # 多条规则：任意一条对上就行
        self.assertTrue(url_matches("http://localhost:3000/a", ["ccb.baka.website", "localhost:3000"]))

    def test_unusable_rules_match_nothing(self):
        """没有主机的规则（只写了路径）、写错的规则：不匹配任何地址，也不报错。"""
        url = "https://ccb.baka.website/multiplayer/x"
        for rule in ("/multiplayer/", "/", "", "   ", "://", "ftp://ccb.baka.website/", "localhost:99999/x", "localhost:abc/x",
                     None, 123, ["ccb.baka.website"]):
            self.assertFalse(url_matches(url, [rule]), rule)
        self.assertFalse(url_matches(url, []))

    def test_url_pattern_and_url_patterns_both_work(self):
        """url_pattern（单个）和 url_patterns（列表）写的规则，加上默认规则，一起生效。"""
        o = ClickerOptions.from_cfg({"url_pattern": "localhost:3000/multiplayer/", "url_patterns": ["my.host.test/play/"]})
        self.assertEqual(o.host_patterns[0], "localhost:3000/multiplayer/")
        for url in ("http://localhost:3000/multiplayer/x", "https://my.host.test/play/1", "https://ccb.baka.website/multiplayer/x"):
            self.assertTrue(url_matches(url, o.host_patterns), url)
        self.assertFalse(url_matches("http://localhost:3000/other", o.host_patterns))


class FakePage:
    def __init__(self, url):
        self.url = url


class BrokenUrlPage:
    @property
    def url(self):
        raise RuntimeError("页面已经关了")


class FakeDialog:
    def __init__(self, page, message="确定要离开吗？", type="confirm"):
        self.page, self.message, self.type = page, message, type
        self.accepted = self.dismissed = 0

    async def accept(self):
        self.accepted += 1

    async def dismiss(self):
        self.dismissed += 1


class FakeContext:
    def __init__(self):
        self.handlers = {}

    def on(self, event, fn):
        self.handlers[event] = fn


class TestDialogsOnlyForGamePages(unittest.TestCase):
    def setUp(self):
        self.logs = []
        self.bm = BrowserManager("127.0.0.1", 9, {"host": DEFAULTS}, lambda lv, m: self.logs.append((lv, m)))
        self.ctx = FakeContext()
        self.bm._watch_context(self.ctx)

    def fire(self, d):
        asyncio.run(self.ctx.handlers["dialog"](d))

    def test_listener_is_registered_on_the_context(self):
        """上下文上必须有监听：没有的话 Playwright 会替用户把所有标签页的提示框都取消掉。"""
        self.assertIn("dialog", self.ctx.handlers)

    def test_game_page_dialog_is_accepted_and_recorded(self):
        page = FakePage("https://ccb.baka.website/multiplayer/r1")
        d = FakeDialog(page, "房间已关闭", "alert")
        self.fire(d)
        self.assertEqual((d.accepted, d.dismissed), (1, 0))
        self.assertEqual(self.bm.dialogs_since(0, page), ["房间已关闭"])
        self.assertTrue(any("已自动点确定" in m for _, m in self.logs))

    def test_other_pages_are_left_alone(self):
        pages = [FakePage("https://bank.example.com/transfer"),
                 FakePage("https://evil.com/?u=ccb.baka.website/multiplayer/"),
                 FakePage("https://ccb.baka.website.evil.com/multiplayer/"),
                 FakePage("https://ccb.baka.website/"),                      # 同一个站，但不是房间页
                 FakePage("about:blank"), FakePage(""), None, BrokenUrlPage()]
        for i, page in enumerate(pages):
            d = FakeDialog(page, "私密提示 token=abc123")
            self.fire(d)
            self.assertEqual((d.accepted, d.dismissed), (0, 0), i)                             # 既不点确定，也不取消
        self.assertEqual(len(self.bm.dialogs), 0)                                              # 也不记录
        warn = [m for lv, m in self.logs if lv == "warn"]
        self.assertEqual(len(warn), len(pages))
        for m in warn:
            self.assertIn("没有自动点确定", m)
            self.assertNotIn("abc123", m)                                                       # 别的网站弹的内容不写进日志
        self.assertTrue(any("bank.example.com" in m for m in warn))                             # 只说是哪个站

    def test_accept_failure_is_swallowed(self):
        class Boom(FakeDialog):
            async def accept(self):
                raise RuntimeError("对话框已经被处理")
        self.fire(Boom(FakePage("https://ccb.baka.website/multiplayer/r1"), "x", "alert"))
        self.assertEqual(len(self.bm.dialogs), 1)


if __name__ == "__main__":
    unittest.main()
