# -*- coding: utf-8 -*-
"""业务流程：host 出题 / auto 常驻循环。

host（出题）：页面里没开出题弹窗就自动「有人想出题？→ 点自己那行的『选择』」→ 在弹窗里定位目标 → 点选
            → 按 id 核验弹窗里选中的就是目标 → 点「确认」→ 等弹窗关闭、本局开始。
auto：后端常驻循环，每轮从当前方案抽一题；每局出一题，出完等本局结束再出下一题。
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, List, Optional, Tuple

from .bgm import char_id_from_img
from .browser import FlowError, page_role
from .locate import (Found, PageSearch, ResponseTracker, Target, more_clicks_for,
                     subject_types_for)
from .models import LocateResult, PlanOption

if TYPE_CHECKING:  # pragma: no cover
    from .service import ClickerService

EVIDENCE_CN = {
    "resp_id": "游戏搜索响应里的 id",
    "react_key": "结果项的 React key（= 角色 id）",
    "img_id": "头像图片地址里的 id",
    "text": "名字文本（无法按 id 核验）",
    "planned": "离线预测（Bangumi API，未在页面里验证）",
}


@dataclass
class Request:
    mode: str
    char_id: Optional[int] = None
    char_name: Optional[str] = None
    work_hint: Optional[str] = None
    dry_run: bool = False
    in_page: bool = True
    confirm: bool = True
    open_popup: bool = True
    auto: bool = False
    clicked: bool = False       # 流程里已经点下了结果项


@dataclass
class PageSession:
    page: Any
    tracker: ResponseTracker
    svc: Any = None
    t0: float = 0.0
    _handlers: List[Tuple[str, Any]] = field(default_factory=list)

    @property
    def dialogs(self) -> List[str]:
        """本次操作开始后，这个标签页弹出过的提示框文字（由 BrowserManager 统一接住并自动点确定）。"""
        return self.svc.browser.dialogs_since(self.t0, self.page)

    def detach(self) -> None:
        for ev, h in self._handlers:
            try:
                self.page.remove_listener(ev, h)
            except Exception:
                pass
        self._handlers.clear()


def attach(svc: "ClickerService", page: Any) -> PageSession:
    sess = PageSession(page=page, tracker=ResponseTracker(), svc=svc, t0=time.time())
    page.on("response", sess.tracker.on_response)
    sess._handlers = [("response", sess.tracker.on_response)]
    return sess


async def probe(svc: "ClickerService", page: Any) -> dict:
    p = await svc.browser.probe(page)
    if p is None:
        raise FlowError("读不到页面状态（页面在刷新或已关闭）", code="probe_failed", recoverable=True)
    return p


async def wait_probe(svc: "ClickerService", page: Any, cond, timeout: float, interval: float = 0.12) -> Optional[dict]:
    t0 = time.time()
    while time.time() - t0 < timeout:
        p = await svc.browser.probe(page)
        if p is not None and cond(p):
            return p
        await asyncio.sleep(interval)
    return None


def summarize(r: LocateResult) -> str:
    ev = EVIDENCE_CN.get(r.evidence or "", r.evidence or "?")
    if r.path == "subject":
        s = f"搜作品「{r.keyword}」→ 作品「{r.subject_name or r.subject_id}」→ 角色列表第 {r.nth} 项"
    else:
        s = f"搜角色「{r.keyword}」→ 第 {r.nth} 项"
        if r.more_clicks:
            s += f"（点了 {r.more_clicks} 次「更多」）"
    return s + f"；依据：{ev}"


# ---------------------------------------------------------------------------
# host：打开出题弹窗
# ---------------------------------------------------------------------------
async def close_blocking_overlays(svc: "ClickerService", page: Any, p: Optional[dict] = None) -> int:
    """关掉挡住点击的游戏弹窗（结算弹窗 / 欢迎弹窗 / 「Bangumi 被墙」提示）。设置弹窗不动。返回关掉的个数。

    网络慢到游戏自己的请求超时时，游戏会弹「Bangumi 被墙」提示（z-index 9999），盖住出题弹窗的「确认」。
    """
    if p is None:
        p = await svc.browser.probe(page) or {}
    closed = 0
    for ov in (p.get("overlays") or [])[:4]:
        if not ov.get("closable") or ov.get("settings"):
            continue
        try:
            await page.locator(".popup-overlay:not(:has(.settings-popup)) .popup-close").first.click(timeout=2000)
            closed += 1
            text = (ov.get("text") or "").replace("\n", " ")[:50]
            level = "warn" if any(k in text for k in ("Bangumi", "bgm", "连接", "网络")) else "info"
            svc.log(level, f"关掉了挡住点击的游戏弹窗：「{text}」")
            await asyncio.sleep(0.25)
        except Exception:
            break
    return closed


async def open_host_popup(svc: "ClickerService", page: Any, p: dict) -> dict:
    if p.get("popup"):
        return p
    if not p.get("joined"):
        raise FlowError("这个标签页还在「创建/加入房间」界面，先手动进房间", code="not_joined")
    if not p.get("hasPlayerList"):
        raise FlowError("这个页面不是多人房间页（没有玩家列表）", code="not_room")
    if p.get("isGameStarted"):
        raise FlowError("本局还在进行中，等这一局结束后才能出题", code="game_running", recoverable=True)
    if not p.get("isHost"):
        raise FlowError("这个标签页不是房主，没法指定出题人（如果房主指定了你出题，出题弹窗会自己弹出来）", code="not_host")
    if p.get("answerSetterId") and p.get("answerSetterId") != p.get("myId"):
        who = next((x.get("username") for x in p.get("players") or [] if x.get("id") == p.get("answerSetterId")), "?")
        raise FlowError(f"已经指定了别人出题（{who}），正在等他", code="other_setter", recoverable=True)
    await close_blocking_overlays(svc, page, p)
    mb = p.get("manualBtn")
    if not mb:
        raise FlowError("找不到「有人想出题？」按钮", code="no_manual_btn", recoverable=True)
    # 出题模式开没开：以按钮上的 active 类为准（DOM 永远是最新的；fiber props 只作参考）
    if not mb.get("active"):
        if mb.get("disabled"):
            players = p.get("players") or []
            if len(players) < 2:
                why = "房间里只有你一个人（至少要 2 人）"
            else:
                unready = [x.get("username") for x in players if not x.get("isHost") and not x.get("ready") and not x.get("disconnected")]
                why = ("还有人没准备：" + "、".join(map(str, unready))) if unready else "全员都是旁观者"
            raise FlowError(f"「有人想出题？」现在不可点：{why}", code="not_ready", recoverable=True)
        # 这个按钮是开关：只在「没开」时点，避免把已开的出题模式关掉
        await page.locator(".manual-mode-button").first.click(timeout=3000)
        p2 = await wait_probe(svc, page, lambda q: bool((q.get("manualBtn") or {}).get("active")) or bool(q.get("popup")), 3.0)
        if not p2:
            raise FlowError("点了「有人想出题？」但没进入出题模式", code="manual_failed", recoverable=True)
        p = p2
        svc.log("info", "已进入出题模式（「有人想出题？」）")
    if p.get("popup"):
        return p
    # 找自己那一行：tr 的 React key = socket id；出题模式下房主那行不显示「房主」字样，按文字找会失败
    my = p.get("myId")
    row = next((r for r in p.get("rows") or [] if my and r.get("key") == my), None)
    if row is None:
        host_name = next((x.get("username") for x in p.get("players") or [] if x.get("isHost")), None)
        if host_name:
            svc.log("warn", "按 socket id 没对上自己那行，改按房主用户名找")
            loc = page.locator(".score-table tbody > tr", has_text=host_name).locator("button.ready-button").first
        else:
            raise FlowError("在玩家列表里找不到自己那一行", code="no_self_row")
    else:
        loc = page.locator(".score-table tbody > tr").nth(int(row["i"])).locator("button.ready-button").first
    await loc.click(timeout=3000)
    p3 = await wait_probe(svc, page, lambda q: bool(q.get("popup")), 6.0)
    if not p3:
        raise FlowError("点了自己那行的「选择」，但出题弹窗没出现（服务器没响应？）", code="popup_not_opened", recoverable=True)
    svc.log("info", "出题弹窗已打开")
    return p3


# ---------------------------------------------------------------------------
# 核心：一次完整流程
# ---------------------------------------------------------------------------
async def run_flow(svc: "ClickerService", req: Request) -> LocateResult:
    t_start = time.time()
    res = LocateResult(ok=False, dry_run=req.dry_run, mode=req.mode)  # type: ignore[arg-type]
    cid, hint = await svc.resolve_char_id(req.char_id, req.char_name, req.work_hint)
    res.char_id = cid
    svc.set_state("locating")
    t = await svc.planner.resolve(cid, await svc.ds_info(cid), req.char_name, hint)
    svc.set_target(t)
    svc.log("info", f"目标：{t.label()}" + (f"，作品提示：{hint}" if hint else ""))

    # ---- 找页面 ----
    page = None
    p: Optional[dict] = None
    offline_reason: Optional[str] = None
    if req.dry_run and not req.in_page:
        offline_reason = "请求指定只做离线预测"
    else:
        try:
            page, p, role = await svc.browser.pick_page(req.mode)
            svc.set_page(page.url, role)
            if svc.opts.bring_to_front and not req.dry_run:
                try:
                    await page.bring_to_front()   # 后台标签页的定时器会被节流，防抖 500ms 可能拖到 1 秒以上
                except Exception:
                    pass
        except FlowError as e:
            if not req.dry_run:
                raise
            offline_reason = str(e)

    if page is not None and p is not None:
        if not req.dry_run and await close_blocking_overlays(svc, page, p):
            p = await probe(svc, page)
        if not p.get("popup"):
            if req.dry_run:
                offline_reason = "出题弹窗没开（验证不会替你开弹窗）"
            elif not req.open_popup:
                raise FlowError("出题弹窗没开（open_popup=false）", code="popup_closed")
            else:
                p = await open_host_popup(svc, page, p)

    # ---- 规划 ----
    allow_subject, types = True, subject_types_for()
    t_plan = time.time()
    plan = await svc.planner.plan(t, allow_subject=allow_subject, types=types)
    res.plan = plan
    svc.log("debug", f"计时：准备 {(t_plan - t_start):.1f}s，离线规划 {(time.time() - t_plan):.1f}s")
    best = next((o for o in plan if o.index is not None), None)
    if best:
        svc.log("info", f"离线规划：{_plan_text(best)}（共 {len(plan)} 条候选）")

    if offline_reason is not None:
        res.source = "api"
        res.warnings.append(f"没在页面里验证：{offline_reason}")
        if best is None:
            res.error = "离线预测也没找到这个角色（Bangumi 搜索前若干页都没有）"
            res.summary = res.error
        else:
            _fill_from_plan(res, best)
            res.ok = True
            res.summary = summarize(res)
        res.elapsed_ms = int((time.time() - t_start) * 1000)
        return res

    # ---- 页面里定位 ----
    assert page is not None
    sess = attach(svc, page)
    box: Optional[PageSearch] = None
    try:
        box = PageSearch(page, sess.tracker, svc.log,
                         search_timeout=svc.opts.search_timeout_s, subject_timeout=svc.opts.subject_timeout_s,
                         on_blocked=lambda: close_blocking_overlays(svc, page))
        t_loc = time.time()
        found, used = await _locate(svc, box, t, plan)
        svc.log("debug", f"计时：页面定位 {(time.time() - t_loc):.1f}s")
        res.path = used.path
        res.keyword = used.keyword
        res.keyword_label = used.keyword_label
        res.index = found.pos
        res.nth = found.pos + 1
        res.more_clicks = box.more_clicks_done
        res.subject_id = used.subject_id
        res.subject_name = used.subject_name
        res.evidence = found.evidence  # type: ignore[assignment]
        res.evidence_detail = found.detail
        res.source = "page"
        res.warnings += found.warnings
        svc.set_strategy(f"{used.path}/{found.evidence}")
        if found.evidence == "text":
            svc.log("warn", "只能按名字文本定位（没有 id 线索）：" + "；".join(found.warnings))
        svc.log("info", "定位成功：" + summarize(res) + f"（{found.detail}）")

        if req.dry_run:
            await box.clear()
            res.ok = True
            res.summary = summarize(res)
            return res

        # ---- 点击 + 核验 ----
        svc.set_state("selecting")
        t_click = time.time()
        await box.click_entry(found.dom_index, t.char_id, "char")
        res.clicked = True
        req.clicked = True
        await _verify_host_selection(svc, page, t, res)
        if req.confirm:
            svc.set_state("confirming")
            await _confirm_host(svc, page, sess, res)
        res.ok = True
        res.summary = summarize(res)
        svc.log("debug", f"计时：点击+核验{'+确认' if req.confirm else ''} {(time.time() - t_click):.1f}s")
        return res
    finally:
        sess.detach()
        if req.dry_run and box is not None and not res.ok:
            # 验证中途失败 / 被取消：把打进搜索框的关键词清掉，别留在用户页面上
            try:
                await asyncio.shield(box.clear())
            except asyncio.CancelledError:
                raise       # 清理途中又被取消：取消优先，别吞掉取消
            except Exception:
                pass
        res.elapsed_ms = int((time.time() - t_start) * 1000)


def _plan_text(o: PlanOption) -> str:
    if o.path == "subject":
        return f"搜作品「{o.keyword}」→ 作品第 {(o.subject_index or 0) + 1} 项 → 角色第 {(o.index or 0) + 1} 项"
    if o.index is None:
        return f"搜角色「{o.keyword}」（位置未知，页面里逐页找）"
    return f"搜角色「{o.keyword}」→ 第 {o.index + 1} 项" + (f"，需点 {o.more_clicks} 次「更多」" if o.more_clicks else "")


def _fill_from_plan(res: LocateResult, o: PlanOption) -> None:
    res.path = o.path
    res.keyword = o.keyword
    res.keyword_label = o.keyword_label
    res.index = o.index
    res.nth = (o.index + 1) if o.index is not None else None
    res.more_clicks = o.more_clicks
    res.subject_id = o.subject_id
    res.subject_name = o.subject_name
    res.evidence = "planned"
    res.evidence_detail = o.note or _plan_text(o)


async def _locate(svc: "ClickerService", box: PageSearch, t: Target, plan: List[PlanOption]) -> Tuple[Found, PlanOption]:
    reasons: List[str] = []
    tried = 0
    for o in plan:
        if tried >= svc.opts.max_paths:
            break
        tried += 1
        svc.set_state("typing")
        svc.bump_attempts()
        try:
            if o.path == "char_search":
                # 位置未知的兜底项：more_clicks 就是翻页预算（API 不通时 = 上限；API 通但前 N 条确认没有时只快速核对 2 页）
                budget = o.more_clicks if o.index is None else min(svc.opts.max_more_clicks, o.more_clicks + 3)
                f, why = await box.find_by_char_search(t, o.keyword, budget, o.index)
            else:
                assert o.subject_id is not None
                f, why = await box.find_by_subject(t, o.keyword, o.subject_id, (o.subject_name or "", ""))
        except FlowError as e:
            if e.code in ("popup_gone", "search_disabled", "ambiguous_text"):
                raise
            f, why = None, str(e)
        if f is None and "秒还没返回" in (why or ""):
            # 网络问题换关键词也没用，直接报
            raise FlowError(why, code="search_timeout", recoverable=True)
        if f is not None:
            if o.path == "char_search" and o.index is not None and f.pos != o.index:
                f.warnings.append(f"页面里的位置（第 {f.pos + 1} 项）和离线预测（第 {o.index + 1} 项）不同，已按 id 以页面为准")
            return f, o
        reasons.append(why)
        svc.log("info", f"此路不通：{why}")
    raise FlowError("所有路径都没找到目标：" + "；".join(reasons[-4:]), code="not_found")


async def _verify_host_selection(svc: "ClickerService", page: Any, t: Target, res: LocateResult) -> None:
    def ok(q: dict) -> bool:
        # 先看选中区的头像 URL（DOM，永远最新）；没有头像的角色再看 SetAnswerPopup 的 selectedCharacter state
        pop = q.get("popup") or {}
        img_id = char_id_from_img(pop.get("selectedImg"))
        if img_id is not None:
            return img_id == t.char_id
        sel = pop.get("selected") or {}
        return sel.get("id") is not None and int(sel["id"]) == t.char_id

    q = await wait_probe(svc, page, ok, 3.0, 0.1)
    if q:
        res.verified = True
        svc.log("info", "已核验：出题弹窗里选中的就是目标（按 id）")
        return
    q = await probe(svc, page)
    pop = q.get("popup") or {}
    sel = pop.get("selected") or {}
    if pop and sel.get("id") is None and not pop.get("selectedImg") and pop.get("selectedText"):
        # 没有 fiber 也没有图片：只能看文字
        if t.name and t.name in (pop.get("selectedText") or ""):
            res.warnings.append("选中后只能按名字文字核验（拿不到 id）")
            svc.log("warn", "选中后只能按名字文字核验（拿不到 id）")
            return
    raise FlowError(f"点完后弹窗里选中的不是目标（选中 id={sel.get('id')}，目标 id={t.char_id}）",
                    code="wrong_selection", recoverable=True)


async def _confirm_host(svc: "ClickerService", page: Any, sess: PageSession, res: LocateResult) -> None:
    btn = page.locator(".set-answer-popup .submit-button").first
    for attempt in range(2):
        q = await wait_probe(svc, page, lambda x: bool((x.get("popup") or {}).get("confirmEnabled")) or not x.get("popup"), 5.0)
        if q and not q.get("popup"):
            break
        if not q:
            raise FlowError("「确认」按钮一直不可点", code="confirm_disabled", recoverable=True)
        n_dialogs = len(sess.dialogs)
        try:
            await btn.click(timeout=4000)
        except Exception as e:
            svc.log("warn", f"「确认」点不动（{str(e).splitlines()[0][:80]}），关遮罩后重试")
            await close_blocking_overlays(svc, page)
            try:
                await btn.click(timeout=3000)
            except Exception:
                svc.log("warn", "鼠标仍点不动，改用键盘：聚焦「确认」按钮后按回车")
                await btn.focus()
                await page.keyboard.press("Enter")
        svc.log("info", "已点「确认」，等待提交（游戏会再拉一遍角色详情）")
        t0 = time.time()
        while time.time() - t0 < svc.opts.confirm_timeout_s:
            x = await svc.browser.probe(page)
            if x is not None and not x.get("popup"):
                break
            if x is not None and (x.get("popup") or {}).get("confirmText") == "确认" and time.time() - t0 > 1.0:
                break   # 提交结束但弹窗还在 = 失败（游戏会 alert 或静默吞掉网络错误）
            await asyncio.sleep(0.15)
        x = await probe(svc, page)
        if not x.get("popup"):
            res.confirmed = True
            break
        msg = sess.dialogs[-1] if len(sess.dialogs) > n_dialogs else "（游戏没给提示，多半是拉角色详情时网络失败）"
        svc.log("warn", f"提交没成功：{msg}；{'重试一次' if attempt == 0 else '放弃'}")
    if not res.confirmed:
        raise FlowError("点了「确认」但出题没成功（网络问题？）", code="confirm_failed", recoverable=True)
    started = await wait_probe(svc, page, lambda x: bool(x.get("isGameStarted") or x.get("answerSetterView")), 6.0)
    if started:
        svc.log("info", "出题成功，本局已开始 ✅")
    else:
        res.warnings.append("弹窗已关闭，但 6 秒内没看到本局开始（服务器慢？）")
        svc.log("warn", "弹窗已关闭，但 6 秒内没看到本局开始")


# ---------------------------------------------------------------------------
# auto 常驻循环
# ---------------------------------------------------------------------------
async def _sleep_or_stop(stop: asyncio.Event, s: float) -> bool:
    try:
        await asyncio.wait_for(stop.wait(), timeout=s)
        return True
    except asyncio.TimeoutError:
        return False


async def auto_loop(svc: "ClickerService", mode: str, stop: asyncio.Event) -> None:
    backoff = 1.0
    consecutive_fail = 0
    svc.log("info", "自动模式开始（出题）")
    while not stop.is_set():
        try:
            page, p, role = await svc.browser.pick_page(mode)
            svc.set_page(page.url, role)
            backoff = 1.0
        except FlowError as e:
            svc.auto_wait(str(e))
            if await _sleep_or_stop(stop, backoff):
                break
            backoff = min(backoff * 1.6, 10.0)
            continue
        except Exception as e:
            # 按异常类型 + 连接状态判断是不是断线（断线时 recover 已走 reset 清掉旧连接）；
            # 看不出是什么的异常也重置一次连接再来
            kind = await svc.browser.recover(e, "自动模式选标签页时")
            first = (str(e).splitlines() or [""])[0][:120]
            svc.log("warn", f"自动模式：选标签页出错（{kind}）{type(e).__name__}: {first}")
            if kind != "disconnected":
                await svc.browser.reset(f"自动模式遇到未知异常（{type(e).__name__}）", hard=svc.browser.driver_dead())
            if await _sleep_or_stop(stop, 2.0):
                break
            continue

        mbtn = p.get("manualBtn") or {}
        can_go = role == "setter" or (
            role == "host_lobby" and not p.get("isGameStarted") and not p.get("answerSetterId")
            and bool(mbtn) and (bool(mbtn.get("active")) or not mbtn.get("disabled")))
        if not can_go:
            if role in ("setter_ingame", "guesser", "observer") or p.get("isGameStarted"):
                svc.auto_wait("本局进行中，等结束后出下一题")
                wait = 0.3
            elif role == "host_lobby" and p.get("answerSetterId"):
                svc.auto_wait("已指定别人出题，等他出完")
                wait = 0.5
            elif role == "host_lobby":
                svc.auto_wait("等其他玩家准备（「有人想出题？」还不可点）")
                wait = 0.5
            else:
                svc.auto_wait(f"当前标签页不是房主（{role}）")
                wait = 1.5
            if await _sleep_or_stop(stop, wait):
                break
            continue

        # ---- 抽题 ----
        q = await svc.draw()
        if q is None:
            svc.auto_wait("抽题失败（方案为空？）")
            if await _sleep_or_stop(stop, 3.0):
                break
            continue
        cid, name, hint = q
        svc.auto_wait(None)
        res = await svc.run_auto_round(Request(mode=mode, char_id=cid, char_name=name, work_hint=hint, auto=True))
        ok = bool(res.ok)
        if ok:
            consecutive_fail = 0
            # 出题成功 → 等本局开始再等它结束（结束后立刻抢下一题）
            svc.auto_wait("本局进行中，等结束后出下一题")
        else:
            consecutive_fail += 1
            pause = min(1.0 * consecutive_fail, 8.0)
            if await _sleep_or_stop(stop, pause):
                break
    svc.log("info", "自动模式已停止")
