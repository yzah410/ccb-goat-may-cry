# -*- coding: utf-8 -*-
"""/v2/solo 对局接口：会话、开局、猜测、超时、投降、改评级、Bangumi 在线搜索。

逻辑都在 session.py（SoloService）；这里只解析请求、套 _guard / _solo、把库快照交给逻辑层。
会改状态的接口都是同步 def（FastAPI 放进线程池跑）；bgm_search 要等网络，所以是 async def。
错误统一 {ok:false, error, message}，见 README「对局接口」。
"""
from __future__ import annotations

import asyncio
import functools
import traceback
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Query

from .. import sqlsafe
from ..router import _err, _guard
from ..spec import SpecError, parse_spec
from ..storage import StorageError
from ..store import NoDatabase, with_snapshot
from .feedback import SoloError, check_mode
from .router import _int_field, _solo
from .session import SOLO

router = APIRouter(prefix="/v2/solo", tags=["单人版"])

BGM_TIMEOUT_SEC = 8.0
BGM_SUBJECT_TYPES = {"anime": [2], "book": [1], "game": [4], "real": [6], "all": [1, 2, 4, 6]}


def _no_leak(fn):
    """意料之外的异常：只告诉前端异常类型，详细信息（可能带着答案的 id，比如 KeyError(1234)）只打在后端日志里。
    _guard 兜底的 500 会把 str(e) 原样发出去，对局接口不能走那条路。要放在 _solo 里面、函数外面。"""
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except (SoloError, NoDatabase, SpecError, StorageError, sqlsafe.SqlError):
            raise                           # 这几类有自己的翻译（_solo / _guard），而且信息是安全的
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            raise SoloError(500, "internal", f"后端出错：{type(e).__name__}（详情见后端日志）")
    return wrapper


def _str_field(body: Dict[str, Any], key: str, label: str) -> str:
    v = body.get(key)
    if not isinstance(v, str) or not v:
        raise SoloError(422, "bad_field", f"{label}（{key}）要是非空文字")
    return v


# ---------------------------------------------------------------- 会话
@router.post("/session")
@_guard
@_solo
@_no_leak
def solo_session(body: Dict[str, Any] = Body(...)):
    """{spec, plan_name?, practice?: work|char, new_every?: 0–20}。求值 spec 建一个会话；题库为空 422 empty_pool。
    practice 不传或 null = work；传了就必须是 work / char，别的值（包括 ""、0、false）一律 422 bad_practice。"""
    spec = parse_spec(body.get("spec"))
    plan_name = body.get("plan_name")
    if plan_name is not None and not isinstance(plan_name, str):
        raise SoloError(422, "bad_field", "方案名（plan_name）要是文字或 null")
    practice = body.get("practice")
    if practice is None:
        practice = "work"
    new_every = body.get("new_every")
    return with_snapshot(lambda snap: SOLO.create_session(snap, spec, plan_name, practice, new_every))


# ---------------------------------------------------------------- 一局
@router.post("/round/start")
@_guard
@_solo
@_no_leak
def solo_round_start(body: Dict[str, Any] = Body(...)):
    """{session_id, subject_tag_num?, character_tag_num?, good_sec?, time_limit_sec?, work_bonus_sec?}。
    开一局（作废没结束的上一局）。work_bonus_sec：0–10，默认 2；结束行是「搜作品选的」的间隔，分界线多给这么多秒。"""
    sid = _str_field(body, "session_id", "会话")
    return with_snapshot(lambda snap: SOLO.start_round(
        snap, sid, body.get("subject_tag_num"), body.get("character_tag_num"), body.get("good_sec"),
        body.get("time_limit_sec"), body.get("work_bonus_sec")))


@router.post("/round/guess")
@_guard
@_solo
@_no_leak
def solo_round_guess(body: Dict[str, Any] = Body(...)):
    """{session_id, round_id, guess_id, via?} -> {row, status, end}。
    via："name"（按名字搜到的；不传或 null 也是它）或 "work"（搜作品后从作品的角色列表里选的），别的值 422 bad_via。"""
    sid = _str_field(body, "session_id", "会话")
    rid = _str_field(body, "round_id", "局")
    gid = _int_field(body, "guess_id", "猜的角色")
    via = body.get("via")
    return with_snapshot(lambda snap: SOLO.guess(snap, sid, rid, gid, via))


@router.post("/round/timeout")
@_guard
@_solo
@_no_leak
def solo_round_timeout(body: Dict[str, Any] = Body(...)):
    """{session_id, round_id} -> {row, status, end: null}。"""
    return SOLO.timeout(_str_field(body, "session_id", "会话"), _str_field(body, "round_id", "局"))


@router.post("/round/surrender")
@_guard
@_solo
@_no_leak
def solo_round_surrender(body: Dict[str, Any] = Body(...)):
    """{session_id, round_id} -> {end}。评级 again。"""
    sid = _str_field(body, "session_id", "会话")
    rid = _str_field(body, "round_id", "局")
    return with_snapshot(lambda snap: SOLO.surrender(snap, sid, rid))


@router.post("/round/regrade")
@_guard
@_solo
@_no_leak
def solo_round_regrade(body: Dict[str, Any] = Body(...)):
    """{session_id, round_id, grade} -> {round_id, grade, grade_auto, next_gap, progress}。只能改最近结束的那一局。"""
    return SOLO.regrade(_str_field(body, "session_id", "会话"), _str_field(body, "round_id", "局"), body.get("grade"))


# ---------------------------------------------------------------- Bangumi 在线搜索
_bgm_client = None


def get_bgm_client():
    """进程里共用一个客户端（带 30 分钟缓存和长连接池）。测试里替换这个函数就能 mock 掉网络。"""
    global _bgm_client
    if _bgm_client is None:
        from ...clicker.bgm import BgmClient          # 惰性导入：只有用到在线搜索才载入
        _bgm_client = BgmClient(timeout=BGM_TIMEOUT_SEC, retries=2)
    return _bgm_client


def _bgm_label(name: str, name_cn: Optional[str], extra: str = "") -> str:
    base = f"{name_cn}（{name}）" if name_cn and name_cn != name else (name_cn or name)
    return f"{base}{extra}"


def _annotate_bgm(kind: str, raw: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把 Bangumi 的结果整理成 {id, name, name_cn, in_library, label}；in_library 看本地库有没有这个 id。"""
    from ...clicker.bgm import cn_name_of

    def run(snap):
        out = []
        for it in raw:
            try:
                iid = int(it.get("id"))
            except (TypeError, ValueError):
                continue
            name = (it.get("name") or "").strip() or str(iid)
            if kind == "character":
                name_cn = cn_name_of(it)
                in_lib = iid in snap.C
                extra = ""
            else:
                name_cn = (it.get("name_cn") or "").strip() or None
                in_lib = iid in snap.S
                d = it.get("date") or ""
                extra = f"（{d[:4]}）" if len(d) >= 4 and d[:4].isdigit() else ""
            out.append({"id": iid, "name": name, "name_cn": name_cn, "in_library": in_lib,
                        "label": _bgm_label(name, name_cn, extra)})
        return out
    return with_snapshot(run)


@router.get("/bgm_search")
async def solo_bgm_search(kind: str = Query(...), q: str = Query(""), mode: str = Query("anime"),
                          limit: int = Query(10, ge=1, le=50)):
    """Bangumi 在线搜索（用来搜别名）。kind=character|subject；subject 的类型按 mode 定。
    返回数组，每项 {id, name, name_cn, in_library, label}。连不上 / 超时 8 秒 → 502 bgm_unavailable。"""
    if kind not in ("character", "subject"):
        return _err(422, "bad_kind", "kind 只能是 character 或 subject")
    try:
        check_mode(mode)
    except SoloError as e:
        return _err(e.status, e.code, e.message)
    q = (q or "").strip()
    if not q:
        return []
    try:
        client = get_bgm_client()
        if kind == "character":
            res = await asyncio.wait_for(client.search_characters(q, limit=limit), BGM_TIMEOUT_SEC)
            raw = list((res or {}).get("data") or [])
        else:
            res = await asyncio.wait_for(client.search_subjects(q, BGM_SUBJECT_TYPES[mode]), BGM_TIMEOUT_SEC)
            raw = list(res or [])
    except Exception:  # noqa: BLE001  超时、断网、Bangumi 返回错误：统一当作连不上
        return _err(502, "bgm_unavailable", "Bangumi 连不上，可以关掉在线搜索用本地搜索")
    raw = raw[:limit]
    out = await asyncio.to_thread(_guard(_solo(_no_leak(lambda: _annotate_bgm(kind, raw)))))
    return out
