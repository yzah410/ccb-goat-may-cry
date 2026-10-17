# -*- coding: utf-8 -*-
"""定位角色：先离线规划（Bangumi API），再在真实页面里按 id 找到那一项。

识别「这一项是不是目标」的依据，按可信度排序：
  1. resp_id   —— 监听游戏自己发出的搜索请求的响应，拿到 id 数组，按顺序对上第 N 项；
  2. react_key —— 结果项 DOM 上的 React fiber key 就是角色/作品 id（游戏代码 key={character.id}）；
                  游戏的 cached-axios 对重复关键词不发请求（收不到响应），这时 1 失效、2 仍然有效；
  3. img_id    —— 头像 URL 里带 id（.../crt/g/xx/xx/<id>_crt_...；作品封面 .../cover/l/xx/xx/<sid>_...），无图角色没有；
  4. text      —— 只按名字文本匹配，记 warning；重名时拒绝瞎点。
路径：
  A. char_search —— 在搜索框输入关键词，结果不够就点「更多」（每次 +5 条），按 id 找；
  B. subject     —— 输入作品名 →「搜作品」→ 按 subject id 点作品 → 在该作品的主角/配角列表里按 id 找。
关键词多策略：原名 → 原名+中文名 → 中文名 → 别名 → 本地库名字；由离线规划挑「要点『更多』次数最少」的那个。
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from .bgm import (BgmClient, BgmError, aliases_of, char_id_from_img, cn_name_of,
                  subject_id_from_img)
from .browser import FlowError
from .js import JS_ITEM_IDENTITY, JS_SEARCH_SNAPSHOT
from .models import PlanOption

INITIAL_LIMIT = 10      # 游戏首屏 10 条
MORE_LIMIT = 5          # 每点一次「更多」+5 条
DEBOUNCE_S = 0.5        # 输入防抖 500ms（SearchBar.jsx）
BUSY_TEXTS = ("在搜了...", "加载中...", "Searching...", "Loading...")

Log = Callable[[str, str], None]


def more_clicks_for(index: Optional[int]) -> int:
    if index is None or index < INITIAL_LIMIT:
        return 0
    return (index - INITIAL_LIMIT) // MORE_LIMIT + 1


def subject_types_for() -> List[int]:
    """复刻游戏 getPossibleSubjectTypes()：出题弹窗不传 gameSettings → 四类全开。"""
    return [1, 2, 4, 6]


# ---------------------------------------------------------------------------
# 目标角色
# ---------------------------------------------------------------------------
@dataclass
class Target:
    char_id: int
    name: Optional[str] = None          # Bangumi 原名（结果项第一行）
    name_cn: Optional[str] = None       # 简体中文名（结果项第二行；没有时游戏显示原名）
    aliases: List[str] = field(default_factory=list)
    ds_name: Optional[str] = None       # 本地库 name（中文优先）
    ds_name_jp: Optional[str] = None    # 本地库 name_jp
    work_hint: Optional[str] = None
    ds_work_names: List[str] = field(default_factory=list)   # 本地库里该角色的登场作品名（收藏多的在前）
    has_image: Optional[bool] = None
    detail_ok: bool = False

    def label(self) -> str:
        main = self.name_cn or self.ds_name or self.name or "?"
        if self.name and self.name != main:
            return f"{main}（{self.name}，id={self.char_id}）"
        return f"{main}（id={self.char_id}）"


def keyword_candidates(t: Target) -> List[Tuple[str, str]]:
    seen: set = set()
    out: List[Tuple[str, str]] = []

    def add(label: str, kw: Optional[str]) -> None:
        kw = (kw or "").strip()
        if not kw or kw in seen or len(kw) > 40:
            return
        seen.add(kw)
        out.append((label, kw))

    add("name", t.name)
    if t.name and t.name_cn and t.name_cn != t.name:
        add("name+cn", f"{t.name} {t.name_cn}")
    add("cn", t.name_cn)
    for a in t.aliases[:4]:
        add("alias", a)
    add("ds_name_jp", t.ds_name_jp)
    add("ds_name", t.ds_name)
    return out


# ---------------------------------------------------------------------------
# 离线规划
# ---------------------------------------------------------------------------
class Planner:
    def __init__(self, bgm: BgmClient, log: Log, max_more: int = 40, prefer_subject_after: int = 3,
                 max_subjects: int = 4, budget_s: float = 10.0):
        self.bgm = bgm
        self.budget_s = budget_s
        self.log = log
        self.max_more = max_more
        self.prefer_subject_after = prefer_subject_after
        self.max_subjects = max_subjects

    async def resolve(self, char_id: int, ds_info: Dict[str, Any], char_name: Optional[str],
                      work_hint: Optional[str]) -> Target:
        t = Target(char_id=int(char_id), ds_name=ds_info.get("name"), ds_name_jp=ds_info.get("name_jp"),
                   work_hint=work_hint, ds_work_names=list(ds_info.get("work_names") or []))
        detail = None
        try:
            detail = await self.bgm.get_character(t.char_id)
            if detail is None and not (t.ds_name or t.ds_name_jp or char_name):
                raise FlowError(f"Bangumi 上没有 id={t.char_id} 的角色（接口返回 404），本地库里也没有", code="no_such_char")
        except BgmError as e:
            self.log("warn", f"查 Bangumi 角色详情失败，退回本地库名字：{e}")
        if detail:
            t.detail_ok = True
            t.name = detail.get("name") or t.ds_name_jp
            t.name_cn = cn_name_of(detail)
            t.aliases = aliases_of(detail)
            t.has_image = bool((detail.get("images") or {}).get("grid"))
        else:
            t.name = t.ds_name_jp or char_name or t.ds_name
            t.name_cn = t.ds_name if t.ds_name and t.ds_name != t.name else None
        return t

    async def plan(self, t: Target, *, allow_subject: bool, types: List[int]) -> List[PlanOption]:
        """离线规划。典型情况只发 1 个请求（原名就在前 10）；难的情况并发深翻 + 并发算作品路径，总预算 budget_s 秒。"""
        opts: List[PlanOption] = []
        kws = keyword_candidates(t)
        max_index = INITIAL_LIMIT + MORE_LIMIT * self.max_more - 1

        def mk(label: str, kw: str, idx: int) -> PlanOption:
            mc = more_clicks_for(idx)
            return PlanOption(path="char_search", keyword=kw, keyword_label=label, index=idx, more_clicks=mc,
                              cost=round(1.6 + 0.8 * mc, 2))

        api_ok = True
        try:
            # 第 1 步：只查首选关键词的第一页（绝大多数角色到此为止：原名通常就在前 10）
            if kws:
                idx, _ = await self.bgm.find_character_index(kws[0][1], t.char_id, 19)
                if idx is not None:
                    opts.append(mk(kws[0][0], kws[0][1], idx))
            # 第 2 步：首选不在前 10 → 其余关键词的第一页并发查
            if not any(o.more_clicks == 0 for o in opts) and len(kws) > 1:
                rest = kws[1:]
                res = await asyncio.gather(*(self.bgm.find_character_index(kw, t.char_id, 19) for _, kw in rest),
                                           return_exceptions=True)
                for (label, kw), r in zip(rest, res):
                    if isinstance(r, BaseException):
                        if isinstance(r, BgmError):
                            raise r
                        continue
                    if r[0] is not None:
                        opts.append(mk(label, kw, r[0]))
        except BgmError as e:
            api_ok = False
            self.log("warn", f"离线规划失败（Bangumi API 不通），改为在页面里逐页按 id 翻找：{e}")

        best = min(opts, key=lambda o: o.more_clicks, default=None)
        # 第 3 步：都不在前 10 → 并发做两件事：各关键词往深处翻 + 算「先搜作品」路径
        if api_ok and (best is None or best.more_clicks > 0):
            found_kw = {o.keyword for o in opts}
            deep_kws = [(label, kw) for label, kw in kws if kw not in found_kw][:4]

            async def deep() -> List[PlanOption]:
                out: List[PlanOption] = []
                rs = await asyncio.gather(*(self.bgm.find_character_index(kw, t.char_id, max_index)
                                            for _, kw in deep_kws), return_exceptions=True)
                for (label, kw), r in zip(deep_kws, rs):
                    if not isinstance(r, BaseException) and r[0] is not None:
                        out.append(mk(label, kw, r[0]))
                return out

            async def subj() -> List[PlanOption]:
                if not allow_subject:
                    return []
                return await self.plan_subject(t, types)

            try:
                both = await asyncio.wait_for(asyncio.gather(deep(), subj(), return_exceptions=True),
                                              timeout=self.budget_s)
                for r in both:
                    if isinstance(r, list):
                        opts += r
                    elif isinstance(r, BaseException):
                        self.log("warn", f"离线规划的一部分失败：{r}")
            except asyncio.TimeoutError:
                self.log("warn", f"离线规划超过 {self.budget_s:.0f} 秒，先用已算出的结果")
        # 排序：「更多」次数不超过阈值的直接搜角色最优先；其余按估算耗时
        opts.sort(key=lambda o: (0 if (o.path == "char_search" and o.more_clicks <= self.prefer_subject_after) else 1,
                                 o.cost))
        # 规划不出来 → 兜底：
        #   API 不通：按关键词顺序在页面里逐页找（每个关键词最多 max_more 次「更多」）；
        #   API 通、但已确认各关键词前 N 条都没有、也没有作品路径：页面数据和 API 一样，深翻也白翻 → 只用首选关键词快速核对 2 页
        if not any(o.index is not None for o in opts):
            if api_ok:
                self.log("warn", f"离线确认：各关键词前 {max_index + 1} 条里都没有 id={t.char_id}，也没有可用的作品路径")
                if kws:
                    opts.append(PlanOption(path="char_search", keyword=kws[0][1], keyword_label=kws[0][0], index=None,
                                           more_clicks=2, cost=99.0,
                                           note="离线已确认找不到，页面里只快速核对前 20 条"))
            else:
                for label, kw in kws[:4]:
                    opts.append(PlanOption(path="char_search", keyword=kw, keyword_label=label, index=None,
                                           more_clicks=self.max_more, cost=99.0,
                                           note="离线没算出位置（API 不通），页面里按 id 逐页翻找"))
        return opts

    async def plan_subject(self, t: Target, types: List[int]) -> List[PlanOption]:
        subs = await self.bgm.character_subjects(t.char_id)
        cand = [s for s in subs if s.get("staff") in ("主角", "配角") and s.get("type") in types]
        hint = (t.work_hint or "").strip()
        ds_names = t.ds_work_names

        def order(s: dict) -> Tuple[int, int, int]:
            names = {s.get("name_cn") or "", s.get("name") or ""}
            h = 0 if hint and any(hint == n or (hint in n) for n in names if n) else 1
            try:
                d = next(i for i, n in enumerate(ds_names) if n in names)
            except StopIteration:
                d = 999
            return (h, d, 0 if s.get("type") == 2 else 1)

        cand.sort(key=order)
        cand = cand[: self.max_subjects]
        char_lists = await asyncio.gather(*(self.bgm.subject_characters(int(s["id"])) for s in cand),
                                          return_exceptions=True)

        async def one(s: dict, chars: Any) -> Optional[PlanOption]:
            if isinstance(chars, BaseException):
                return None
            sid = int(s["id"])
            ids = [int(c["id"]) for c in chars]
            if t.char_id not in ids:
                return None
            cidx = ids.index(t.char_id)
            kws: List[Tuple[str, str]] = []
            if hint:
                kws.append(("work_hint", hint))
            for lab, v in (("subject_cn", s.get("name_cn")), ("subject_name", s.get("name"))):
                if v and v.strip() and v.strip() not in [k for _, k in kws]:
                    kws.append((lab, v.strip()))
            for lab, kw in kws:
                res = await self.bgm.search_subjects(kw, types)
                sids = [int(x["id"]) for x in res]
                if sid in sids:
                    return PlanOption(
                        path="subject", keyword=kw, keyword_label=lab, index=cidx, subject_id=sid,
                        subject_name=s.get("name_cn") or s.get("name"), subject_index=sids.index(sid),
                        cost=round(3.0 + 0.03 * len(ids), 2),
                        note=f"作品在「搜作品」第 {sids.index(sid) + 1} 项；角色在该作品主角/配角列表第 {cidx + 1} 项（共 {len(ids)} 人）")
            return None

        got = await asyncio.gather(*(one(s, c) for s, c in zip(cand, char_lists)), return_exceptions=True)
        return [g for g in got if isinstance(g, PlanOption)][:2]


# ---------------------------------------------------------------------------
# 响应监听：把游戏自己的搜索响应记下来（id 顺序 = 页面顺序）
# ---------------------------------------------------------------------------
class ResponseTracker:
    RE_SUBJ_CHARS = re.compile(r"/v0/subjects/(\d+)/characters(?:\?|$)")

    def __init__(self) -> None:
        self.char_pages: Dict[str, Dict[int, List[int]]] = {}
        self.subject_search: Dict[str, List[int]] = {}
        self.subject_chars: Dict[int, List[int]] = {}
        self.count = 0

    async def on_response(self, resp: Any) -> None:
        try:
            url = resp.url
            if "/v0/" not in url:
                return
            req = resp.request
            method = req.method
            if "/v0/search/characters" in url and method == "POST":
                q = parse_qs(urlparse(url).query)
                off = int((q.get("offset") or ["0"])[0])
                kw = (json.loads(req.post_data or "{}") or {}).get("keyword", "")
                body = await resp.json()
                self.char_pages.setdefault(kw.strip(), {})[off] = [int(c["id"]) for c in body.get("data") or []]
            elif "/v0/search/subjects" in url and method == "POST":
                kw = (json.loads(req.post_data or "{}") or {}).get("keyword", "")
                body = await resp.json()
                self.subject_search[kw.strip()] = [int(s["id"]) for s in body.get("data") or []]
            elif method == "GET":
                m = self.RE_SUBJ_CHARS.search(url)
                if not m:
                    return
                body = await resp.json()
                if isinstance(body, list):
                    self.subject_chars[int(m.group(1))] = [int(c["id"]) for c in body
                                                           if c.get("relation") in ("主角", "配角")]
            else:
                return
            self.count += 1
        except Exception:
            pass    # 响应体取不到（跨域预检、页面跳走）就当没看见，靠 React key / 图片兜底

    def char_ids(self, kw: str) -> Optional[List[int]]:
        pages = self.char_pages.get(kw.strip())
        if not pages or 0 not in pages:
            return None
        out = list(pages[0])
        off = len(pages[0])
        while off in pages and pages[off]:
            out += pages[off]
            off += len(pages[off])
        return out


# ---------------------------------------------------------------------------
# 页面里的搜索框
# ---------------------------------------------------------------------------
@dataclass
class Found:
    dom_index: int          # 在 .search-result-item 列表里的下标（点击用）
    pos: int                # 在结果里的 0 基位置（不含「更多」）
    evidence: str
    detail: str
    warnings: List[str] = field(default_factory=list)


class PageSearch:
    def __init__(self, page: Any, tracker: ResponseTracker, log: Log,
                 search_timeout: float = 12.0, subject_timeout: float = 25.0,
                 on_blocked: Optional[Callable[[], Any]] = None):
        self.page = page
        self.on_blocked = on_blocked    # 点击被遮罩挡住时调用（关掉游戏弹窗）
        self.tracker = tracker
        self.log = log
        self.search_timeout = search_timeout
        self.subject_timeout = subject_timeout
        self.more_clicks_done = 0

    # ---- 基础 ----
    async def snap(self) -> dict:
        s = await self.page.evaluate(JS_SEARCH_SNAPSHOT)
        if not s.get("present"):
            raise FlowError("出题弹窗不见了（被关闭或已提交）", code="popup_gone", recoverable=True)
        return s

    async def root(self) -> Any:
        return self.page.locator(".set-answer-popup").first

    async def items_locator(self) -> Any:
        return (await self.root()).locator(".search-dropdown .search-result-item")

    @staticmethod
    def _busy(s: dict) -> bool:
        if s.get("loading"):
            return True
        for b in (s.get("charBtn"), s.get("subjBtn")):
            if b and b.get("text") in BUSY_TEXTS:
                return True
        return (s.get("loadMoreText") or "") in BUSY_TEXTS

    async def set_query(self, kw: str) -> None:
        s = await self.snap()
        if s.get("inputDisabled"):
            raise FlowError("出题弹窗的搜索框是禁用状态，暂时不能输入（本局可能已经开始或结束）", code="search_disabled",
                            recoverable=True)
        inp = (await self.root()).locator("input.search-input").first
        if (s.get("inputValue") or "") != "":
            await inp.fill("")
            # 清空后游戏会立刻清掉下拉；等它消失，避免把旧结果当新结果
            for _ in range(15):
                s2 = await self.snap()
                if not s2.get("items"):
                    break
                await asyncio.sleep(0.05)
        await inp.fill(kw)

    async def clear(self) -> None:
        try:
            inp = (await self.root()).locator("input.search-input").first
            await inp.fill("")
        except Exception:
            pass

    async def wait_list(self, kind: str, kw: str = "", timeout: Optional[float] = None) -> dict:
        """等结果列表稳定。kind: char（角色结果）/ subject（作品结果）/ subject_chars（作品下的角色列表）。"""
        timeout = timeout or (self.subject_timeout if kind == "subject_chars" else self.search_timeout)
        t0 = time.time()
        sig_prev: Any = None
        stable_since = 0.0
        saw_busy = False
        s: dict = {}
        while True:
            s = await self.snap()
            busy = self._busy(s)
            saw_busy = saw_busy or busy
            entries = [x for x in s.get("items") or [] if not x.get("loadMore")]
            if kind == "char":
                ok = bool(entries) and all(x.get("subjectType") is None for x in entries) and not s.get("header")
            elif kind == "subject":
                ok = bool(entries) and all(x.get("subjectType") is not None for x in entries)
            else:
                ok = bool(s.get("header")) and bool(entries) and all(x.get("subjectType") is None for x in entries)
            now = time.time()
            if ok and not busy:
                sig = tuple((x.get("key"), x.get("img"), x.get("name")) for x in entries)
                if sig != sig_prev:
                    sig_prev, stable_since = sig, now
                elif now - stable_since >= 0.25:
                    return s
            elif not busy and not entries and kind in ("char", "subject"):
                # 可能是「没有结果」：看响应，或者等过了防抖 + 一段时间仍然空
                if kind == "char" and self.tracker.char_pages.get(kw.strip(), {}).get(0) == []:
                    return s
                if kind == "subject" and self.tracker.subject_search.get(kw.strip()) == []:
                    return s
                if (saw_busy and now - t0 > DEBOUNCE_S + 0.3) or now - t0 > DEBOUNCE_S + 2.5:
                    return s
            if now - t0 > timeout:
                if busy:
                    raise FlowError(f"搜索请求 {timeout:.0f} 秒还没返回（网络慢，或 Bangumi 接口被墙；游戏自己 5 秒超时后会重试 3 次）",
                                    code="search_timeout", recoverable=True)
                return s
            await asyncio.sleep(0.08)

    # ---- 识别 ----
    def identify(self, s: dict, target_id: int, kind: str, ctx_key: Any, t: Optional[Target] = None,
                 planned_index: Optional[int] = None,
                 subject_name: Optional[Tuple[str, str]] = None) -> Optional[Found]:
        entries = [x for x in s.get("items") or [] if not x.get("loadMore")]
        if kind == "char":
            resp = self.tracker.char_ids(str(ctx_key))
        elif kind == "subject":
            resp = self.tracker.subject_search.get(str(ctx_key).strip())
        else:
            resp = self.tracker.subject_chars.get(int(ctx_key)) if ctx_key is not None else None
        img_of = subject_id_from_img if kind == "subject" else char_id_from_img
        warnings: List[str] = []
        use_resp = resp is not None and len(resp) == len(entries)
        if use_resp:
            for e, r in zip(entries, resp):
                if e.get("key") is not None and e["key"] != str(r):
                    use_resp = False
                    warnings.append("响应里的 id 顺序和页面对不上（可能又刷新了），改用 React key")
                    break
        tid = int(target_id)
        # 1) 响应 id
        if use_resp and tid in resp:
            pos = resp.index(tid)
            e = entries[pos]
            agree = "React key 一致" if e.get("key") == str(tid) else "React key 缺失"
            return Found(e["i"], pos, "resp_id", f"搜索响应第 {pos + 1} 项 id={tid}（{agree}）", warnings)
        # 2) React key
        for pos, e in enumerate(entries):
            if e.get("key") == str(tid):
                return Found(e["i"], pos, "react_key", f"结果第 {pos + 1} 项的 React key={tid}", warnings)
        # 3) 图片 URL
        for pos, e in enumerate(entries):
            if img_of(e.get("img")) == tid:
                return Found(e["i"], pos, "img_id", f"结果第 {pos + 1} 项的图片 URL 含 id={tid}", warnings)
        # 4) 文本：只有在页面上**完全没有** id 线索时才允许（有线索却没找到 = 目标确实不在这页）
        has_id_signal = use_resp or any(e.get("key") for e in entries) or any(img_of(e.get("img")) for e in entries)
        if has_id_signal:
            return None
        if kind == "subject":
            if not subject_name:
                return None
            cn, nm = subject_name
            hits = [(pos, e) for pos, e in enumerate(entries) if (cn and e.get("cn") == cn) or (nm and e.get("name") == nm)]
        else:
            if t is None:
                return None
            hits = [(pos, e) for pos, e in enumerate(entries)
                    if e.get("name") == t.name and (e.get("cn") in (t.name_cn, t.name) or not t.name_cn)]
        if len(hits) == 1:
            pos, e = hits[0]
            warnings.append("页面上拿不到任何 id 线索，只能按名字文本匹配（唯一命中）")
            return Found(e["i"], pos, "text", f"结果第 {pos + 1} 项名字完全一致", warnings)
        if len(hits) > 1 and planned_index is not None and any(p == planned_index for p, _ in hits):
            e = entries[planned_index]
            warnings.append(f"按名字有 {len(hits)} 个同名项，按离线预测的第 {planned_index + 1} 项选择（无法用 id 核验）")
            return Found(e["i"], planned_index, "text", "同名项里取离线预测的位置", warnings)
        if len(hits) > 1:
            raise FlowError(f"有 {len(hits)} 个同名结果且页面上没有 id 线索，拒绝瞎点", code="ambiguous_text")
        return None

    # ---- 点击 ----
    async def click_entry(self, dom_index: int, expect_id: int, kind: str) -> None:
        """点之前最后核验一次那个元素还是不是目标，避免列表刚好刷新导致点错。"""
        loc = (await self.items_locator()).nth(dom_index)
        ident = await loc.evaluate(JS_ITEM_IDENTITY)
        img_of = subject_id_from_img if kind == "subject" else char_id_from_img
        if ident.get("loadMore"):
            raise FlowError("列表刚刚变了（要点的位置变成了「更多」）", code="stale_list", recoverable=True)
        k = ident.get("key")
        if k is not None and k != str(expect_id):
            raise FlowError(f"列表刚刚变了（第 {dom_index + 1} 项现在是 id={k}）", code="stale_list", recoverable=True)
        iid = img_of(ident.get("img"))
        if k is None and iid is not None and iid != int(expect_id):
            raise FlowError(f"列表刚刚变了（第 {dom_index + 1} 项图片 id={iid}）", code="stale_list", recoverable=True)
        for attempt in range(2):
            try:
                await loc.scroll_into_view_if_needed(timeout=3000)
                await loc.click(timeout=4000)
                return
            except Exception as e:
                first = str(e).splitlines()[0][:80]
                if attempt == 0 and self.on_blocked is not None and await self.on_blocked():
                    self.log("warn", f"点击被遮罩挡住（{first}），已关遮罩，重试")
                    continue
                self.log("warn", f"鼠标点击失败（{first}），改用键盘 ↓×{dom_index + 1} + 回车")
                break
        inp = (await self.root()).locator("input.search-input").first
        await inp.focus()
        for _ in range(dom_index + 1):
            await self.page.keyboard.press("ArrowDown")
            await asyncio.sleep(0.03)
        s = await self.snap()
        sel = [x for x in s.get("items") or [] if x.get("selected")]
        if not sel or sel[0]["i"] != dom_index:
            raise FlowError("键盘选中的项不是目标，放弃这次点击", code="keyboard_mismatch", recoverable=True)
        await self.page.keyboard.press("Enter")

    async def load_more(self, s: dict) -> Optional[dict]:
        items = s.get("items") or []
        lm = next((x for x in items if x.get("loadMore")), None)
        if not lm:
            return None
        n_before = len([x for x in items if not x.get("loadMore")])
        await (await self.items_locator()).nth(lm["i"]).click(timeout=5000)
        self.more_clicks_done += 1
        t0 = time.time()
        while time.time() - t0 < self.search_timeout:
            await asyncio.sleep(0.1)
            s2 = await self.snap()
            if self._busy(s2):
                continue
            n_after = len([x for x in s2.get("items") or [] if not x.get("loadMore")])
            has_lm = any(x.get("loadMore") for x in s2.get("items") or [])
            if n_after > n_before or not has_lm:
                await asyncio.sleep(0.15)
                return await self.snap()
        raise FlowError("点了「更多」但新结果一直没出来（网络慢？）", code="more_timeout", recoverable=True)

    # ---- 两条路径 ----
    async def find_by_char_search(self, t: Target, kw: str, max_more: int,
                                  planned_index: Optional[int]) -> Tuple[Optional[Found], str]:
        """返回 (Found 或 None, 没找到的原因)。"""
        s = await self.snap()
        await self.set_query(kw)
        # 如果当前是「搜作品」模式，要点一下「搜角色」切回来（按钮在有输入后才可点）
        if (s.get("subjBtn") or {}).get("active") or (s.get("placeholder") or "").endswith("作品..."):
            root = await self.root()
            btn = root.locator(".search-box > button.search-button").first
            for _ in range(20):
                if await btn.is_enabled():
                    break
                await asyncio.sleep(0.05)
            await btn.click(timeout=3000)
        s = await self.wait_list("char", kw)
        entries = [x for x in s.get("items") or [] if not x.get("loadMore")]
        if not entries:
            return None, f"关键词「{kw}」没有搜索结果"
        more = 0
        while True:
            f = self.identify(s, t.char_id, "char", kw, t=t, planned_index=planned_index)
            if f:
                return f, ""
            if not any(x.get("loadMore") for x in s.get("items") or []):
                n = len([x for x in s.get("items") or [] if not x.get("loadMore")])
                return None, f"关键词「{kw}」的 {n} 条结果全部翻完，没有 id={t.char_id}"
            if more >= max_more:
                return None, f"关键词「{kw}」点了 {more} 次「更多」仍未出现，超过上限"
            s2 = await self.load_more(s)
            if s2 is None:
                return None, "「更多」按钮消失"
            s = s2
            more += 1

    async def find_by_subject(self, t: Target, subject_kw: str, subject_id: int,
                              subject_name: Optional[Tuple[str, str]] = None) -> Tuple[Optional[Found], str]:
        s = await self.snap()
        sb = s.get("subjBtn") or {}
        if not sb:
            return None, "没有「搜作品」按钮"
        if sb.get("disabledMode"):
            return None, "房间设置里关闭了「搜作品」"
        await self.set_query(subject_kw)
        root = await self.root()
        btn = root.locator(".subject-search-wrapper > button.search-button").first
        for _ in range(40):
            if await btn.is_enabled():
                break
            await asyncio.sleep(0.05)
        await btn.click(timeout=3000)
        s = await self.wait_list("subject", subject_kw)
        f = self.identify(s, subject_id, "subject", subject_kw, subject_name=subject_name)
        if not f:
            n = len([x for x in s.get("items") or [] if not x.get("loadMore")])
            return None, f"「搜作品」{subject_kw} 的 {n} 条结果里没有作品 id={subject_id}"
        await self.click_entry(f.dom_index, subject_id, "subject")
        s = await self.wait_list("subject_chars", timeout=self.subject_timeout)
        if not s.get("header"):
            return None, "点了作品，但作品角色列表没出来（网络慢？）"
        f2 = self.identify(s, t.char_id, "subject_chars", subject_id, t=t)
        if not f2:
            n = len([x for x in s.get("items") or [] if not x.get("loadMore")])
            return None, f"作品 id={subject_id} 的 {n} 个主角/配角里没有 id={t.char_id}"
        f2.detail = f"作品（{f.evidence}：{f.detail}）→ 角色（{f2.detail}）"
        f2.warnings = f.warnings + f2.warnings
        return f2, ""
