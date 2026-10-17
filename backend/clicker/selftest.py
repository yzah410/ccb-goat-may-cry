# -*- coding: utf-8 -*-
"""离线自检（不需要浏览器 / 网络）：python -m backend.clicker.selftest

覆盖真实页面上很难自然触发的分支：响应缺失时退到 React key、key 缺失时退到图片 id、
都没有时按文本（唯一命中才点，重名拒绝）、响应与页面顺序不一致时不信响应、图片 URL 正则（含镜像域名）。

不连浏览器的用例（用假对象）：
  关服时正在跑的单次任务被中止并落到 state=closed；自动模式也会停下；
  取消：取消后 busy 保持 true 直到协程真正结束；卡住时进入 stuck、自动重置浏览器连接，期间拒绝新任务；
  断线：按异常类型 + 连接状态判断，读页面状态返回结构化错误，断线走 reset() 清掉旧引用。
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import socket
import sys
import threading
import time
import urllib.error
from types import SimpleNamespace

from .bgm import aliases_of, char_id_from_img, subject_id_from_img
from .browser import FlowError, page_role, score_page
from .locate import (PageSearch, ResponseTracker, Target, keyword_candidates, more_clicks_for,
                     subject_types_for)

_fails = 0


def check(name: str, cond: bool) -> None:
    global _fails
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        _fails += 1


def item(i, key=None, img=None, name=None, cn=None, load_more=False, subject_type=None):
    return {"i": i, "key": key, "img": img, "name": name, "cn": cn, "loadMore": load_more,
            "subjectType": subject_type, "selected": False, "noImage": img is None}


def snap(items):
    return {"present": True, "items": items}


def main() -> int:
    print("[正则]")
    check("角色图 id（lain）", char_id_from_img("https://lain.bgm.tv/pic/crt/g/39/01/9169_crt_anidb.jpg") == 9169)
    check("角色图 id（带 ?r=）", char_id_from_img("https://lain.bgm.tv/pic/crt/g/90/6e/20836_crt_RaJ3E.jpg?r=1375764500") == 20836)
    check("角色图 id（线上镜像域名）", char_id_from_img("https://bangumi.baka.website/pic/crt/g/fa/f7/11816_crt_Y1G15.jpg") == 11816)
    check("作品封面 id（/r/100/ 缩略）", subject_id_from_img("https://lain.bgm.tv/r/100/pic/cover/l/e5/69/265_Z5Uou.jpg") == 265)
    check("空 URL", char_id_from_img(None) is None and subject_id_from_img("") is None)

    print("[关键词 / 更多次数 / 作品类型]")
    t = Target(char_id=37064, name="レイ", name_cn="雷伊", aliases=["魔人雷伊", "Lei"], ds_name="雷伊", ds_name_jp="レイ")
    kws = [k for _, k in keyword_candidates(t)]
    check("关键词顺序：原名 → 原名+中文 → 中文 → 别名，去重", kws == ["レイ", "レイ 雷伊", "雷伊", "魔人雷伊", "Lei"])
    check("第 10 项不用点更多", more_clicks_for(9) == 0)
    check("第 11 项点 1 次", more_clicks_for(10) == 1)
    check("第 48 项点 8 次", more_clicks_for(47) == 8)
    check("弹窗作品类型四类全开", subject_types_for() == [1, 2, 4, 6])
    check("别名拆分", aliases_of({"infobox": [{"key": "别名", "value": [{"k": "昵称", "v": "亚瑟王、骑士王"}, {"v": "Altria"}]}]})
          == ["亚瑟王", "骑士王", "Altria"])

    print("[识别依据的优先级]")
    tr = ResponseTracker()
    ps = PageSearch(page=None, tracker=tr, log=lambda *a: None)
    items = [item(0, "9169", "x/crt/g/39/01/9169_crt_a.jpg", "レイ", "レイ"),
             item(1, "20836", "x/crt/g/90/6e/20836_crt_b.jpg", "レイ", "雷伊"),
             item(2, "37064", "x/crt/g/a0/5c/37064_crt_c.jpg", "レイ", "雷伊"),
             item(3, load_more=True)]
    tr.char_pages["レイ"] = {0: [9169, 20836, 37064]}
    f = ps.identify(snap(items), 37064, "char", "レイ")
    check("有响应 → resp_id，第 3 项", bool(f) and f.evidence == "resp_id" and f.pos == 2)
    tr.char_pages.clear()
    f = ps.identify(snap(items), 37064, "char", "レイ")
    check("无响应（缓存命中）→ react_key", bool(f) and f.evidence == "react_key" and f.pos == 2)
    items_nokey = [dict(x, key=None) for x in items]
    f = ps.identify(snap(items_nokey), 37064, "char", "レイ")
    check("无 key → img_id", bool(f) and f.evidence == "img_id" and f.pos == 2)
    tr.char_pages["レイ"] = {0: [9169, 37064, 20836]}   # 与页面顺序不一致
    f = ps.identify(snap(items), 37064, "char", "レイ")
    check("响应顺序与页面不一致 → 不信响应，用 key", bool(f) and f.evidence == "react_key" and f.pos == 2 and bool(f.warnings))
    tr.char_pages.clear()
    f = ps.identify(snap(items), 99999, "char", "レイ")
    check("有 id 线索但目标不在 → None（不退到文本瞎点）", f is None)

    bare = [item(0, None, None, "レイ", "零"), item(1, None, None, "レイ", "雷伊"), item(2, None, None, "ユイ", "结衣")]
    t2 = Target(char_id=20836, name="レイ", name_cn="雷伊")
    f = ps.identify(snap(bare), 20836, "char", "レイ", t=t2)
    check("完全没有 id 线索 + 文本唯一命中 → text（带 warning）", bool(f) and f.evidence == "text" and f.pos == 1 and bool(f.warnings))
    bare2 = [item(0, None, None, "レイ", "雷伊"), item(1, None, None, "レイ", "雷伊")]
    try:
        ps.identify(snap(bare2), 20836, "char", "レイ", t=t2)
        check("文本重名且无预测 → 拒绝（抛 ambiguous_text）", False)
    except FlowError as e:
        check("文本重名且无预测 → 拒绝（抛 ambiguous_text）", e.code == "ambiguous_text")
    f = ps.identify(snap(bare2), 20836, "char", "レイ", t=t2, planned_index=1)
    check("文本重名但离线预测给出位置 → 按预测选（带 warning）", bool(f) and f.pos == 1 and f.evidence == "text")

    print("[作品列表]")
    subj = [item(0, "316025", "x/r/100/pic/cover/l/ce/15/316025_G.jpg", subject_type="游戏"),
            item(1, "265", "x/r/100/pic/cover/l/e5/69/265_Z.jpg", subject_type="动漫")]
    f = ps.identify(snap(subj), 265, "subject", "新世纪福音战士")
    check("作品按 key 找到第 2 项", bool(f) and f.pos == 1)
    subj_nokey = [dict(x, key=None) for x in subj]
    f = ps.identify(snap(subj_nokey), 265, "subject", "新世纪福音战士")
    check("作品无 key → 封面图 id", bool(f) and f.evidence == "img_id" and f.pos == 1)

    print("[选页打分]")
    host_lobby = {"joined": True, "hasPlayerList": True, "isHost": True, "isGameStarted": False, "visible": False}
    guesser = {"joined": True, "hasPlayerList": True, "isHost": False, "isGameStarted": True,
               "gameSearch": {"disabled": False}, "visible": True}
    check("角色判定", page_role(host_lobby) == "host_lobby" and page_role(guesser) == "guesser"
          and page_role({"joined": False}) == "not_joined" and page_role({"joined": True, "popup": {}}) == "setter")
    check("host 模式偏好房主页", score_page("host", host_lobby, False) > score_page("host", guesser, False))

    test_cancel_semantics()
    test_shutdown()
    test_disconnect_classify()

    print(f"\n{'全部通过' if _fails == 0 else f'{_fails} 项失败'}")
    return 1 if _fails else 0


# ---------------------------------------------------------------------------
# 关服 / 取消 / 断线的离线用例
# ---------------------------------------------------------------------------
def _wait_until(cond, timeout: float = 5.0, step: float = 0.02) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return True
        time.sleep(step)
    return bool(cond())


def _new_service(grace: float = 0.4):
    from .service import ClickerService
    with contextlib.redirect_stdout(io.StringIO()):
        # 端口 9 上没有 Chrome；用假 _exec 代替真实流程，不会碰浏览器
        return ClickerService({"autoclick": {"cdp_port": 9, "cancel_grace_s": grace}})


def test_cancel_semantics() -> None:
    """取消后 busy 保持 true，协程真正结束才落到 error；卡住时 stuck + 自动重置连接 + 拒绝新任务。"""
    from .models import LocateResult, OncePayload

    print("取消的语义")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        svc = _new_service(grace=0.4)

        # ① 正常可取消的任务：cancel_async 等它真的停下，返回 cancelled
        async def slow_exec(req, ctl=None):
            svc.set_state("typing")
            await asyncio.sleep(30)
            return LocateResult(ok=True, mode=req.mode, char_id=req.char_id)

        svc._exec = slow_exec
        r = svc.once(OncePayload(mode="host", char_id=1))
        _wait_until(lambda: svc.status()["state"] == "typing")
        res1 = asyncio.run(svc.cancel_async(wait_s=2.0))
        st1 = svc.status()

        # ② 卡住的任务：收到取消后迟迟不结束，直到「浏览器连接被重置」
        release = threading.Event()
        resets = []

        async def stubborn_exec(req, ctl=None):
            svc.set_state("selecting")
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                while not release.is_set():          # 模拟卡在没响应的页面上的 Playwright 调用
                    await asyncio.sleep(0.02)
                raise

        async def fake_reset(reason, hard=False):
            resets.append(hard)
            threading.Timer(0.5, release.set).start()   # 重置后 0.5 秒旧调用才失败，留出观察 stuck 的时间

        svc._exec = stubborn_exec
        svc.browser.reset = fake_reset
        r2 = svc.once(OncePayload(mode="host", char_id=2))
        _wait_until(lambda: svc.status()["state"] == "selecting")
        c1 = svc.cancel()
        st_cancelling = svc.status()
        rej_once = svc.once(OncePayload(mode="host", char_id=3))
        try:
            svc.start_auto("host")
            auto_rejected = False
        except RuntimeError:
            auto_rejected = True
        _wait_until(lambda: svc.status()["state"] == "stuck", timeout=3)
        st_stuck = svc.status()
        rej_stuck = svc.once(OncePayload(mode="host", char_id=4))
        c2 = svc.cancel()                              # 卡住时再点取消：再重置一次
        _wait_until(lambda: not svc.status()["busy"], timeout=5)
        st_end = svc.status()

        # ③ 旧任务真正结束后能接新任务
        async def quick_exec(req, ctl=None):
            svc.set_state("done")
            return LocateResult(ok=True, mode=req.mode, char_id=req.char_id, summary="ok")

        svc._exec = quick_exec
        r5 = svc.once(OncePayload(mode="host", char_id=5))
        _wait_until(lambda: not svc.status()["busy"])
        st5 = svc.status()
        svc.shutdown()

    check("可取消的任务：接口返回 cancelled", r.accepted and res1 == "cancelled")
    check("取消后状态落到 error / 已取消，busy=false", st1["state"] == "error" and not st1["busy"]
          and st1["last_error"] == "已取消" and (st1["last_result"] or {}).get("error") == "已取消")
    check("卡住的任务：cancel 返回 cancelling，busy 仍为 true、state=cancelling",
          r2.accepted and c1 == "cancelling" and st_cancelling["busy"] and st_cancelling["state"] == "cancelling")
    check("取消中拒绝新的单次任务（提示正在取消）", not rej_once.accepted and "正在取消" in (rej_once.message or ""))
    check("取消中拒绝启动自动模式", auto_rejected)
    check("宽限期后进入 stuck，并自动重置浏览器连接（hard=True）",
          st_stuck["state"] == "stuck" and st_stuck["busy"] and resets[:1] == [True])
    check("stuck 时拒绝新任务（提示卡住）", not rej_stuck.accepted and "卡住" in (rej_stuck.message or ""))
    check("stuck 时再点取消：返回 stuck 并再重置一次", c2 == "stuck" and len(resets) >= 2)
    check("旧协程真正结束后：busy=false、state=error、last_error 说明卡过",
          not st_end["busy"] and st_end["state"] == "error" and "已取消" in (st_end["last_error"] or "")
          and "重置浏览器连接" in (st_end["last_error"] or ""))
    check("之后能接新任务并正常完成", r5.accepted and st5["state"] == "done" and not st5["busy"])


def test_shutdown() -> None:
    """关服：先中止并等待单次任务，再断开浏览器、停 loop；任务落到 state=closed。"""
    from .models import LocateResult, OncePayload

    print("关服")
    with contextlib.redirect_stdout(io.StringIO()):
        svc = _new_service(grace=0.4)
        seen = []

        async def slow_exec(req, ctl=None):
            svc.set_state("confirming")
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                seen.append("cancelled")
                raise
            return LocateResult(ok=True, mode=req.mode, char_id=req.char_id)

        svc._exec = slow_exec
        svc.once(OncePayload(mode="host", char_id=1))
        _wait_until(lambda: svc.status()["state"] == "confirming")
        t0 = time.time()
        svc.shutdown()
        dt = time.time() - t0
        st = svc.status()
        after = svc.once(OncePayload(mode="host", char_id=2))
        loop_alive = svc._runner.thread.is_alive()

        # 自动模式在跑时关服：自动模式也要停下（端口 9 没有 Chrome，自动模式会一直在「等 Chrome」里转）
        svc2 = _new_service(grace=0.4)
        svc2.start_auto("host")
        _wait_until(lambda: bool(svc2.status()["auto"]["waiting_for"]), timeout=5)
        svc2.shutdown()
        st2 = svc2.status()

    check(f"关服时任务被取消并等它结束（{dt:.2f}s）", seen == ["cancelled"] and dt < 3.0)
    check("任务落到 state=closed，busy=false，last_error / last_result 写明服务关闭",
          st["state"] == "closed" and not st["busy"] and "服务关闭" in (st["last_error"] or "")
          and "服务关闭" in ((st["last_result"] or {}).get("error") or ""))
    check("关服后拒绝新任务", not after.accepted and "已关闭" in (after.message or ""))
    check("clicker-loop 线程已停", not loop_alive)
    check("自动模式也停下，stop_reason=服务关闭", not st2["auto"]["running"] and st2["auto"]["stop_reason"] == "服务关闭"
          and not svc2._runner.thread.is_alive())


def test_disconnect_classify() -> None:
    """断线判定：异常类型 + Browser.is_connected() + 驱动是否活着；probe 结构化；断线走 reset。"""
    from .browser import PWTargetClosed, PWTimeout, BrowserManager, _http_error_code

    print("断线判定 / 结构化 probe / 显式重连")
    check("HTTP 探测：端口没人听 → refused", _http_error_code(urllib.error.URLError(ConnectionRefusedError())) == "refused")
    check("HTTP 探测：超时 → timeout", _http_error_code(socket.timeout("timed out")) == "timeout")
    if PWTargetClosed is None:
        check("本机 Playwright 有 TargetClosedError 类型（1.41+）", False)
        return

    class FakeBrowser:
        def __init__(self):
            self.alive, self.closed = True, 0

        def is_connected(self):
            return self.alive

        async def close(self):
            self.closed += 1

    class FakePage:
        def __init__(self, exc=None, data=None):
            self.exc, self.data = exc, data

        async def evaluate(self, js, *a):
            if self.exc is not None:
                raise self.exc
            return self.data

    class FakePW:
        """假的 Playwright 对象：on_error_future 已完成 = 驱动进程已经没了。"""
        def __init__(self, dead):
            fut = SimpleNamespace(done=lambda: dead)
            self._impl_obj = SimpleNamespace(_connection=SimpleNamespace(_closed_error=None,
                                                                          _transport=SimpleNamespace(on_error_future=fut)))
            self.stopped = False

        async def stop(self):
            self.stopped = True

    logs = []

    async def run():
        from .browser import FlowError
        out = {}
        bm = BrowserManager("127.0.0.1", 9, {"host": []}, lambda lv, m: logs.append((lv, m)))
        fb = FakeBrowser()
        bm._browser = fb
        tc = PWTargetClosed("Target page, context or browser has been closed")
        out["tc_alive"] = await bm.classify(tc)
        out["timeout"] = await bm.classify(PWTimeout("Timeout 3000ms exceeded"))
        out["other"] = await bm.classify(ValueError("boom"))
        out["text"] = await bm.classify(Exception("Connection closed while reading from the driver"))
        r = await bm.probe_ex(FakePage(exc=tc))
        out["probe_ex_closed"] = (r.data, r.error, r.detail.startswith("TargetClosedError"))
        try:
            await bm.probe(FakePage(exc=tc))
            out["probe_closed"] = "no raise"
        except FlowError as e:
            out["probe_closed"] = e.code
        out["probe_timeout"] = await bm.probe(FakePage(exc=asyncio.TimeoutError()))
        out["probe_ok"] = await bm.probe(FakePage(data={"joined": True}))
        out["ref_kept"] = bm._browser is fb and bm.resets == 0
        fb.alive = False                                    # 浏览器断了
        out["tc_dead"] = await bm.classify(tc)
        try:
            await bm.probe(FakePage(exc=tc))
            out["probe_dead"] = "no raise"
        except FlowError as e:
            out["probe_dead"] = e.code
        out["ref_cleared"] = bm._browser is None and fb.closed == 1 and bm.resets == 1
        # 驱动进程没了：Browser 仍说连着，但 connected 要是 False；reset(hard) 连驱动一起丢掉
        fb2 = FakeBrowser()
        bm._browser, bm._pw = fb2, FakePW(dead=True)
        out["driver_dead_connected"] = bm.connected
        out["driver_dead_kind"] = await bm.classify(ValueError("任何异常"))
        await bm.reset("测试", hard=bm.driver_dead())
        out["driver_reset"] = bm._browser is None and bm._pw is None and fb2.closed == 1
        return out

    o = asyncio.run(run())
    check("「目标已关闭」+ 浏览器还连着 → page_closed", o["tc_alive"] == "page_closed")
    check("超时 → timeout；其他异常 → error", o["timeout"] == "timeout" and o["other"] == "error")
    check("驱动断开的普通 Exception → 按文字兜底判为 disconnected", o["text"] == "disconnected")
    check("probe_ex 返回结构化错误", o["probe_ex_closed"] == (None, "page_closed", True))
    check("probe：标签页关了直接抛 page_closed；暂时读不到返回 None；读到返回 dict",
          o["probe_closed"] == "page_closed" and o["probe_timeout"] is None and o["probe_ok"] == {"joined": True})
    check("标签页关了不重置连接", o["ref_kept"])
    check("「目标已关闭」+ 浏览器已断开 → disconnected", o["tc_dead"] == "disconnected")
    check("probe 遇到断线：抛 browser_disconnected，并走 reset 清掉旧 browser 引用",
          o["probe_dead"] == "browser_disconnected" and o["ref_cleared"])
    check("驱动进程没了：connected=false、任何异常都判为 disconnected", o["driver_dead_connected"] is False
          and o["driver_dead_kind"] == "disconnected")
    check("reset(hard) 连 Playwright 驱动一起丢掉", o["driver_reset"])


if __name__ == "__main__":
    sys.exit(main())
