# -*- coding: utf-8 -*-
"""/v2/solo 接口：单人版「猜猜呗」的只读辅助接口。风格照 backend/v2/router.py（_guard + with_snapshot）。

- GET  /v2/solo/search                    容错搜索角色 / 作品（别名、同音字、错字；索引没建好时退回严格规则）
- POST /v2/solo/pool                      方案 -> 题库全部角色 id
- POST /v2/solo/feedback                  猜 + 答案 -> 猜猜呗游戏的反馈（给测试和调试用；对局用的接口在 session_router.py）
- GET  /v2/solo/work_characters/{sid}     某部作品的全部角色
- POST /v2/solo/card                      角色 id -> 前端 CharacterCardV2 吃的 CandidateV2

全部只读：不写 data/，不碰库。
"""
from __future__ import annotations

import functools
from typing import Any, Dict

from fastapi import APIRouter, Body, Query

from .. import engine
from ..router import _add_has_anime, _err, _guard, _spec_from
from ..spec import parse_spec
from ..store import (C_GENDER, C_HEAT, C_NAME, HUB, P_NAPP, REL_NAME, S_HEAT, S_NAME, S_TYPE, S_YEAR, with_snapshot)
from .feedback import GENDER_SYMBOL, SoloError, check_mode, solo_feedback
from .search import SEARCH

router = APIRouter(prefix="/v2/solo", tags=["单人版"])

# 项目默认：作品标签数 6（猜猜呗游戏默认是 4）、角色标签数 4
DEFAULT_MODE = "anime"
DEFAULT_SUBJECT_TAG_NUM = 6
DEFAULT_CHARACTER_TAG_NUM = 4


def _solo(fn):
    """SoloError（角色不存在 / 参数不对）翻成 {ok:false, error, message}。要放在 _guard 里面。"""
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except SoloError as e:
            return _err(e.status, e.code, e.message)
    return wrapper


def _int_field(body: Dict[str, Any], key: str, label: str, default: Any = None) -> int:
    v = body.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int):
        raise SoloError(422, "bad_field", f"{label}（{key}）要是整数")
    return v


# ---------------------------------------------------------------- 搜索（容错）
@router.get("/search")
@_guard
@_solo
def solo_search(kind: str = Query(...), q: str = Query(""), limit: int = Query(12, ge=1, le=50)):
    """容错搜索角色 / 作品（见 search.py 和 fuzzy.py）。kind=character|work，不看 mode：角色是全库，作品是全部可见作品。
    返回 {items: [{id, value, label, count, matched, match}], fuzzy}；fuzzy=false 表示容错索引还没建好，这次用的是严格规则（和 /v2/suggest 一样）。
    q 去掉空白后为空 → items 为空。kind 不对 → 422 bad_kind。"""
    if kind not in ("character", "work"):
        raise SoloError(422, "bad_kind", "kind 只能是 character 或 work")
    return with_snapshot(lambda snap: SEARCH.search(snap, kind, q, limit))


# ---------------------------------------------------------------- 题库
@router.post("/pool")
@_guard
@_solo
def solo_pool(body: Any = Body(...)):
    """入参同 /v2/evaluate（SpecV2，或 {spec: SpecV2}）。返回题库全部角色 id（升序）和人数。
    方案里有没生效的部分时 errors 非空，题库是不完整的——调用方自己决定要不要拦。"""
    spec = _spec_from(body)
    ev = engine.evaluate(spec)
    ids = ev.pool_sorted
    prof = ev.mp.prof
    empty = [c for c in ids if not (prof.get(c) and prof[c][P_NAPP])]
    return {"total": len(ids), "ids": ids, "empty_grid_ids": empty, "mode": spec.game.mode,
            "tag_count": spec.game.tag_count, "errors": ev.errors, "warnings": ev.warnings}


# ---------------------------------------------------------------- 反馈
@router.post("/feedback")
@_guard
@_solo
def solo_feedback_ep(body: Dict[str, Any] = Body(...)):
    """{guess_id, answer_id, mode?, subject_tag_num?, character_tag_num?}（缺省 anime / 6 / 4）。返回 feedback.solo_feedback 的结果。"""
    guess_id = _int_field(body, "guess_id", "猜的角色")
    answer_id = _int_field(body, "answer_id", "答案角色")
    mode = check_mode(body.get("mode", DEFAULT_MODE))
    n = body.get("subject_tag_num", DEFAULT_SUBJECT_TAG_NUM)
    ctn = body.get("character_tag_num", DEFAULT_CHARACTER_TAG_NUM)

    def run(snap):
        return solo_feedback(snap, mode, guess_id, answer_id, n, ctn, mp=HUB.mode(snap, mode))
    return with_snapshot(run)


# ---------------------------------------------------------------- 某部作品的角色
@router.get("/work_characters/{subject_id}")
@_guard
@_solo
def solo_work_characters(subject_id: int, mode: str = Query(DEFAULT_MODE)):
    """作品下的全部角色（库里角色宇宙内的）：主角在前，再按热度（收藏数）降序，同热度 id 升序。
    n_app 是这个角色在 mode 模式下的登场作品数（0 = 游戏里格子是空的）。"""
    check_mode(mode)

    def run(snap):
        brief = snap.subject_brief([subject_id]).get(subject_id)
        if brief is None:
            raise SoloError(404, "not_found", f"作品 {subject_id} 不在库里")
        mp = HUB.mode(snap, mode)
        items = []
        for cid, rc, _ord in snap.s_apps.get(subject_id, ()):
            c = snap.C.get(cid)
            if c is None:
                continue
            p = mp.prof.get(cid)
            items.append({"id": cid, "name": c[C_NAME], "relation": REL_NAME.get(rc, "客串"), "relation_code": rc,
                          "heat": c[C_HEAT], "gender": GENDER_SYMBOL[c[C_GENDER]],
                          "n_app": int(p[P_NAPP] or 0) if p else 0})
        items.sort(key=lambda it: (0 if it["relation_code"] == 1 else 1, -it["heat"], it["id"]))
        s = snap.S.get(subject_id)
        subject = {"id": subject_id, "name": s[S_NAME] if s else brief["name"], "type": s[S_TYPE] if s else brief["type"],
                   "year": s[S_YEAR] if s else brief["year"], "heat": s[S_HEAT] if s else brief["heat"]}
        return {"subject": subject, "mode": mode, "total": len(items), "items": items}
    return with_snapshot(run)


# ---------------------------------------------------------------- 卡片
@router.post("/card")
@_guard
@_solo
def solo_card(body: Dict[str, Any] = Body(...)):
    """{spec, char_id} -> CandidateV2（同 /v2/candidates 的每一项，含 has_anime）。spec 决定模式和作品标签数；
    角色不在题库里也能返回（ranges 为空）。"""
    cid = _int_field(body, "char_id", "角色")
    spec = parse_spec(body.get("spec"))

    def run(snap):
        if cid not in snap.C:
            raise SoloError(404, "not_found", f"角色 {cid} 不在角色库里")
        ev = engine.evaluate(spec)
        item = engine.build_item(ev, cid)
        _add_has_anime(ev.snap, [item])
        return item
    return with_snapshot(run)
