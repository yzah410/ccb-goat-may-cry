# -*- coding: utf-8 -*-
"""/v2 接口。一个 APIRouter，在 app.py 里 include_router。

所有处理函数都是同步 def：FastAPI 会放进线程池跑，算得慢也不会卡住其他接口。
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import engine, schema_doc, sqlsafe, tiers
from .maps import MAPS, validate as validate_tagnote
from .spec import SpecError, default_spec, parse_spec, spec_to_dict
from .storage import LISTS, PLANS, StorageError
from .store import (C_HEAT, C_NAME, HUB, MODE_IDS, MODES, REL_NAME, S_COUNTS, S_HEAT, S_NAME, S_NSFW, S_TYPE,
                    S_VISIBLE, S_YEAR,
                    NoDatabase, TYPE_NAME, with_snapshot)

router = APIRouter(prefix="/v2", tags=["出题器"])
tiers.load()  # 标签分档：读 data/tag_tiers.json 并生效（没有这个文件就用默认分档）


# ---------------------------------------------------------------- 错误处理
def _err(status: int, code: str, message: str, **extra) -> JSONResponse:
    body = {"ok": False, "error": code, "message": message}
    body.update(extra)
    return JSONResponse(status_code=status, content=body)


def _guard(fn):
    """把常见异常翻成中文 JSON：没库 503、方案不对 422、清单 / 方案存储问题 400/404/409、其它 500。"""
    import functools

    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except NoDatabase as e:
            return _err(503, "no_db", str(e), candidates=e.candidates)
        except SpecError as e:
            return _err(422, "bad_spec", "方案格式不对：" + "；".join(e.messages), detail=e.messages)
        except StorageError as e:
            return _err(e.status, "storage", e.message)
        except sqlsafe.SqlError as e:
            return _err(400, "sql", e.message, detail=e.detail)
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            return _err(500, "internal", f"后端出错：{type(e).__name__}: {e}")
    return wrapper


def _spec_from(body: Any) -> Any:
    if isinstance(body, dict) and "spec" in body:
        return parse_spec(body.get("spec"))
    return parse_spec(body)


def _json_or(text: Optional[str]) -> Any:
    if text is None:
        return None
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return text


# ---------------------------------------------------------------- 标签笔记 / 导图库
@router.post("/tagnote")
@_guard
def v2_tagnote(body: Any = Body(...)):
    from . import tagnote
    from .canvas import make_canvas_store

    spec = _spec_from(body)
    options = body if isinstance(body, dict) else {}
    tag_mode = options.get("tag_mode", "map")
    if tag_mode not in tagnote.TAG_MODES:
        return _err(422, "bad_tag_mode", "tag_mode 只能是 map 或 full")
    title = options.get("title")
    if title is None:
        title = (spec.meta.name if spec.meta else None) or "标签笔记"
    if not isinstance(title, str) or not title.strip():
        return _err(422, "bad_title", "title 必须是非空字符串")

    def run(snap):
        ev = engine.evaluate(spec)
        if ev.errors:
            return _err(409, "spec_has_errors",
                        "方案里有没生效的部分，先修好再导出：" + "；".join(e["message"] for e in ev.errors),
                        errors=ev.errors)
        # full 也按最早作品合并，但不建分岔树；大池先拦截，避免做无用布局计算。
        works = tagnote.works_from_store(make_canvas_store(ev), ev.pool, tag_mode="full")
        if not works:
            return _err(409, "empty_pool", "候选池没有可导出的作品")
        if len(works) > tagnote.MAX_WORKS:
            return _err(409, "too_many_works", "作品太多，请缩小范围后再导出",
                        count=len(works), limit=tagnote.MAX_WORKS)
        return tagnote.tagnote_from_eval(ev, title, tag_mode=tag_mode,
                                         mode=spec.game.mode, tag_count=spec.game.tag_count)
    return with_snapshot(run)


def _tagnote_download(data):
    from urllib.parse import quote
    from . import tagnote_note
    data = validate_tagnote(data)
    filename = quote(tagnote_note.note_filename(data["collection"]["title"]), safe="")
    return Response(content=tagnote_note.make_note(data), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename*=UTF-8''" + filename})


@router.post("/tagnote/note")
@_guard
def v2_tagnote_note(body: Dict[str, Any] = Body(...)):
    return _tagnote_download(body.get("data"))


@router.get("/maps")
@_guard
def v2_maps():
    return {"items": MAPS.all()}


@router.get("/maps/{map_id}")
@_guard
def v2_map_get(map_id: str):
    data = MAPS.get(map_id)
    if data is None:
        return _err(404, "not_found", "导图不存在")
    return data


@router.post("/maps")
@_guard
def v2_map_create(body: Dict[str, Any] = Body(...)):
    return JSONResponse(status_code=201, content=MAPS.create(body.get("data")))


@router.patch("/maps/{map_id}")
@_guard
def v2_map_patch(map_id: str, body: Dict[str, Any] = Body(...)):
    return MAPS.patch(map_id, body)


@router.delete("/maps/{map_id}")
@_guard
def v2_map_delete(map_id: str):
    if not MAPS.delete(map_id):
        return _err(404, "not_found", "导图不存在")
    return Response(status_code=204)


@router.get("/maps/{map_id}/note")
@_guard
def v2_map_note(map_id: str):
    data = MAPS.get(map_id)
    if data is None:
        return _err(404, "not_found", "导图不存在")
    return _tagnote_download(data)


@router.get("/map_samples")
@_guard
def v2_map_samples():
    """样例导图：{total: 一共几张, remaining: 还有几张没载入}。"""
    from . import map_samples
    return map_samples.status()


@router.post("/map_samples/load")
@_guard
def v2_map_samples_load():
    """把还没载入的样例导图全部复制进导图库；库里已有同 id 的图跳过，不覆盖。"""
    from . import map_samples
    return map_samples.load_all()


def _seed_samples() -> None:
    """后端启动：首次运行、导图库是空的时放进几张默认的样例导图。出错只打印，不影响启动。"""
    from . import map_samples
    try:
        n = map_samples.seed_defaults()
    except Exception as e:  # noqa: BLE001
        print(f"[样例导图] 首次运行复制默认样例失败：{e}", flush=True)
        return
    if n:
        print(f"[样例导图] 首次运行，放进了 {n} 张默认样例", flush=True)


router.add_event_handler("startup", _seed_samples)


# ---------------------------------------------------------------- 状态 / 元数据
@router.get("/status")
def v2_status():
    """不阻塞：数据加载到哪一步了（phase: idle / loading / ready / no_db / error）。"""
    return HUB.status()


@router.get("/meta")
@_guard
def v2_meta():
    base = {"modes": MODES, "default_spec": default_spec(), "tag_count_range": [0, 10],
            "subject_types": [{"id": k, "label": v} for k, v in TYPE_NAME.items()],
            "draw_methods": [{"id": "per_character", "label": "每个角色机会均等"},
                             {"id": "per_work", "label": "先抽作品、再抽角色"},
                             {"id": "range_share", "label": "按范围占比"}]}
    try:
        snap = HUB.current()
    except NoDatabase as e:
        return {**base, "db": None, "db_error": str(e), "status": HUB.status()}
    m = snap.meta
    counts = dict(snap.counts)
    db = {
        "path": snap.path, "dump_name": m.get("dump_name"), "built_at": m.get("built_at"), "today": snap.today,
        "schema_version": m.get("schema_version"),
        "counts": counts,
        "tags_api_subjects": _json_or(m.get("tags_api_subjects")),
        "tags_dump_subjects": _json_or(m.get("tags_dump_subjects")),
        "modes_available": sorted((counts.get("profile_modes") or {}).keys()),
    }
    return {**base, "db": db, "status": HUB.status()}


# ---------------------------------------------------------------- 标签分档 / 公式
@router.get("/tiers")
@_guard
def v2_tiers_get():
    """configured: false = 还没选过公式（前端弹开局问卷）。defaults = 默认分档；fixed = 来源 / 播放形式 / 制作公司（不能放进分档）。"""
    return tiers.snapshot()


@router.put("/tiers")
@_guard
def v2_tiers_put(body: Any = Body(...)):
    """存分档和公式：{formula: null | {chars: [{id, name}] 2–3 个}, tiers: {G_1..G_4: [标签]}}。存完马上生效。"""
    return tiers.save(body)


# ---------------------------------------------------------------- 求值 / 候选 / 抽题 / 统计
@router.post("/evaluate")
@_guard
def v2_evaluate(body: Any = Body(...)):
    t0 = time.perf_counter()
    spec = _spec_from(body)
    ev = engine.evaluate(spec)
    ms = (time.perf_counter() - t0) * 1000
    out = ev.to_response(elapsed_ms=ms, cached=ms + 0.5 < ev.elapsed_ms)
    out["spec"] = spec_to_dict(spec)
    return out


@router.post("/candidates")
@_guard
def v2_candidates(body: Dict[str, Any] = Body(...)):
    spec = parse_spec(body.get("spec"))
    page = max(1, int(body.get("page") or 1))
    page_size = max(1, min(100, int(body.get("page_size") or 20)))
    sort = body.get("sort") or "heat"
    if sort not in ("heat", "name", "random"):
        sort = "heat"
    q = body.get("q") or None
    seed = body.get("seed")

    def run(snap):
        ev = engine.evaluate(spec)
        ids = engine.candidate_ids(ev, sort=sort, q=q, seed=int(seed or 0))
        start = (page - 1) * page_size
        items = [engine.build_item(ev, cid) for cid in ids[start:start + page_size]]
        _add_has_anime(ev.snap, items)
        return {"total": len(ids), "page": page, "page_size": page_size, "items": items,
                "pool_total": len(ev.pool), "sort": sort}
    return with_snapshot(run)


@router.post("/generate_canvas")
@_guard
def v2_generate_canvas(body: Any = Body(...)):
    """当前草稿求出的完整候选池；复用 canvas_logic 的分类和同作品去重规则。"""
    from ..canvas_logic import generate_canvas_data
    from ..canvas_gen import CanvasGenerator
    from .canvas import make_canvas_store

    spec = _spec_from(body)

    def run(snap):
        ev = engine.evaluate(spec)
        if ev.errors:
            return _err(409, "spec_has_errors",
                        "方案里有没生效的部分，先修好再导出：" + "；".join(e["message"] for e in ev.errors),
                        errors=ev.errors)
        ds = make_canvas_store(ev)
        tree = generate_canvas_data(ds, sorted(ev.pool), False)
        data = CanvasGenerator().process(tree)
        return Response(content=json.dumps(data, ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"Content-Disposition": "attachment; filename=candidates.canvas"})
    return with_snapshot(run)


def _add_has_anime(snap, items: List[Dict[str, Any]]) -> None:
    """has_anime（给前端的标签列规则）：动画模式画像 fallback = 0 且 n_app > 0。一页只查一次（只查这一页的 id）。
    放在 item 顶层和 item.character 里（同一个值）。"""
    ha = snap.has_anime([it["char_id"] for it in items if it.get("char_id") is not None])
    for it in items:
        v = bool(ha.get(it.get("char_id"), False))
        it["has_anime"] = v
        if isinstance(it.get("character"), dict):
            it["character"]["has_anime"] = v


@router.post("/draw")
@_guard
def v2_draw(body: Dict[str, Any] = Body(...)):
    spec = parse_spec(body.get("spec") if "spec" in body else body)
    seed = body.get("seed") if "spec" in body else None
    if seed is None:
        seed = spec.draw.seed

    def run(snap):
        ev = engine.evaluate(spec)
        if ev.errors:
            return _err(409, "spec_has_errors",
                        "方案里有没生效的部分，先修好再抽题：" + "；".join(e["message"] for e in ev.errors),
                        errors=ev.errors)
        cid, rid, work, used = engine.draw(ev, seed, spec.draw.method)
        if cid is None:
            return engine.empty_draw(used, len(ev.pool))
        item = engine.build_item(ev, cid, bound_sid=work, use_bound=True)
        item.update({"range_id": rid, "pool_total": len(ev.pool), "seed": used, "method": spec.draw.method})
        _add_has_anime(ev.snap, [item])
        return item
    return with_snapshot(run)


@router.post("/stats")
@_guard
def v2_stats(body: Any = Body(...)):
    spec = _spec_from(body)

    def run(snap):
        ev = engine.evaluate(spec)
        key = "stats:" + engine._cache_key(spec)
        with snap.cache_lock:
            hit = snap.cache.get(key)
        if hit is not None:
            return {**hit, "cached": True}
        res = engine.compute_stats(ev)
        snap.cache_put(key, res)
        return res
    return with_snapshot(run)


# ---------------------------------------------------------------- 角色详情
@router.get("/character/{cid}")
@_guard
def v2_character(cid: int, mode: str = "anime", n: int = Query(6, ge=0, le=10)):
    if mode not in MODE_IDS:
        return _err(422, "bad_mode", f"模式只能是 {' / '.join(MODE_IDS)}")

    def run(snap):
        if cid not in snap.C:
            return _err(404, "not_found", f"角色 {cid} 不在角色库里")
        mp = HUB.mode(snap, mode)
        ti = mp.tag_index(n)
        conn = snap.connect()
        try:
            row = conn.execute("SELECT id, name, name_cn, display_name, gender, heat, comments, role FROM character WHERE id=?",
                               (cid,)).fetchone()
            scores = conn.execute("SELECT rank, tag, score FROM profile_tag WHERE mode=? AND character_id=? ORDER BY rank",
                                  (mode, cid)).fetchall() if "profile_tag" in snap.tables else []
        finally:
            conn.close()
        has_anime = bool(snap.has_anime([cid]).get(cid, False))
        character = {"id": row[0], "name": row[1], "name_cn": row[2], "display_name": row[3] or row[1],
                     "gender": row[4], "gender_symbol": engine.GENDER_SYMBOL.get(row[4] if row[4] in ("男", "女") else None, "?"),
                     "heat": row[5], "comments": row[6], "role": row[7], "has_anime": has_anime}
        grid = engine.grid_of(snap, mp, ti, cid)
        apps = []
        for sid, rc in snap.c_apps.get(cid, ()):
            s = snap.S.get(sid)
            if not s:
                continue
            apps.append({"subject_id": sid, "name": s[S_NAME], "type": s[S_TYPE], "year": s[S_YEAR],
                         "relation": REL_NAME.get(rc, "客串"), "heat": s[S_HEAT], "nsfw": bool(s[S_NSFW]),
                         "counts": bool(s[S_COUNTS])})
        apps.sort(key=lambda a: (-a["heat"], a["subject_id"]))
        p = mp.prof.get(cid)
        cut = p[5] if p else None
        shown = len(grid["tags"])
        prof_apps = []
        for sid in mp.apps.get(cid, ()):
            s = snap.S.get(sid)
            prof_apps.append({"subject_id": sid, "name": s[S_NAME] if s else str(sid), "year": s[S_YEAR] if s else None})
        return {
            "character": character, "has_anime": has_anime, "grid": grid, "appearances": apps,
            "vas": list(snap.vas()[0].get(cid, ())),
            "char_tags": list(snap.char_tags()[0].get(cid, ())),
            "tag_scores": [{"rank": r, "tag": t, "score": sc, "shown": r < shown} for r, t, sc in scores],
            "cut": cut, "profile_apps": prof_apps, "ext_tags": snap.ext_tags(cid),
            "best_work": engine._work_ref(snap, snap.best_work(cid)),
        }
    return with_snapshot(run)


# ---------------------------------------------------------------- 自动补全
def _rank_matches(q: str, items, limit: int):
    """items: [(value, count, search_key, extra)]；前缀匹配（含完全相同）在前、包含匹配在后，同档按 count 降序。"""
    qn = (q or "").strip().casefold()
    if not qn:
        pool = sorted(items, key=lambda x: -x[1])
        return pool[:limit]
    prefix, contains = [], []
    for it in items:
        keys = it[2].split("|") if it[2] else [it[0].casefold()]
        if any(k.startswith(qn) for k in keys):
            prefix.append(it)
        elif any(qn in k for k in keys):
            contains.append(it)
    out = []
    for grp in (prefix, contains):
        grp.sort(key=lambda x: -x[1])
        out.extend(grp)
        if len(out) >= limit:
            break
    return out[:limit]


@router.get("/suggest")
@_guard
def v2_suggest(kind: str = Query(..., pattern="^(game_tag|work_tag|meta_tag|char_tag|va|work|character)$"),
               q: str = "", mode: str = "anime", limit: int = Query(20, ge=1, le=200), n: int = Query(6, ge=0, le=10)):
    if mode not in MODE_IDS:
        mode = "anime"

    def run(snap):
        if kind == "game_tag":
            mp = HUB.mode(snap, mode)
            ti = mp.tag_index(n)
            items = [(t, len(s), t.casefold(), None) for t, s in ti.by_tag.items()]
            return [{"value": v, "label": v, "count": c} for v, c, _, _ in _rank_matches(q, items, limit)]
        if kind == "work_tag":
            items = [(t, c, t.casefold(), None) for t, c in snap.work_tag_counts().items()]
            return [{"value": v, "label": v, "count": c} for v, c, _, _ in _rank_matches(q, items, limit)]
        if kind == "meta_tag":
            items = [(t, c, t.casefold(), None) for t, c in snap.meta_tag_counts().items()]
            return [{"value": v, "label": v, "count": c} for v, c, _, _ in _rank_matches(q, items, limit)]
        if kind == "char_tag":
            items = [(t, c, t.casefold(), None) for t, c in snap.char_tag_counts().items()]
            return [{"value": v, "label": v, "count": c} for v, c, _, _ in _rank_matches(q, items, limit)]
        if kind == "va":
            cn = snap.va_cn()
            items = [(t, c, (t + "|" + cn[t]).casefold() if t in cn else t.casefold(), cn.get(t))
                     for t, c in snap.va_counts().items()]
            return [{"value": v, "label": f"{v}（{x}）" if x else v, "count": c}
                    for v, c, _, x in _rank_matches(q, items, limit)]
        if kind == "work":
            names = snap.subject_search_names()
            S = snap.S
            items = [(S[sid][S_NAME], S[sid][S_HEAT], names.get(sid, ""), sid) for sid in S if S[sid][S_VISIBLE]]
            out = []
            for v, c, _, sid in _rank_matches(q, items, limit):
                s = S[sid]
                label = f"{v}（{s[S_YEAR] or '年份不明'} · {TYPE_NAME.get(s[S_TYPE], s[S_TYPE])}）"
                out.append({"value": v, "label": label, "count": c, "id": sid})
            return out
        # character
        names = snap.char_search_names()
        C = snap.C
        items = [(C[cid][C_NAME], C[cid][C_HEAT], names.get(cid, ""), cid) for cid in C]
        out = []
        for v, c, _, cid in _rank_matches(q, items, limit):
            w = snap.best_work(cid)
            wn = snap.S[w][S_NAME] if w in snap.S else None
            out.append({"value": v, "label": f"{v}（{wn}）" if wn else v, "count": c, "id": cid})
        return out
    return with_snapshot(run)


# ---------------------------------------------------------------- 清单
def _resolve_list_items(data: Dict[str, Any]) -> Dict[str, Any]:
    """角色 / 作品清单：只有名字的项，库里能唯一对上就补上 id。库不在就跳过。"""
    kind = data.get("kind")
    if kind not in ("character", "work"):
        return {"resolved": 0, "ambiguous": [], "unresolved": []}
    try:
        snap = HUB.current()
    except NoDatabase:
        return {"resolved": 0, "ambiguous": [], "unresolved": [], "note": "还没有数据库，没有按名字对号"}
    resolved, ambiguous, unresolved = 0, [], []
    for it in data.get("items") or []:
        if it.get("id") is not None:
            if not it.get("name"):
                if kind == "character" and it["id"] in snap.C:
                    it["name"] = snap.C[it["id"]][C_NAME]
                elif kind == "work" and it["id"] in snap.S:
                    it["name"] = snap.S[it["id"]][S_NAME]
            continue
        hits = snap.find_chars_by_name(it["name"]) if kind == "character" else snap.find_subjects_by_name(it["name"])
        if len(hits) == 1:
            it["id"] = hits[0]
            resolved += 1
        elif len(hits) > 1:
            it["id"] = hits[0]
            resolved += 1
            ambiguous.append({"name": it["name"], "candidates": hits[:5], "picked": hits[0]})
        else:
            unresolved.append(it["name"])
    return {"resolved": resolved, "ambiguous": ambiguous, "unresolved": unresolved}


@router.get("/lists")
@_guard
def v2_lists():
    return LISTS.all()


@router.post("/lists")
@_guard
def v2_list_create(body: Dict[str, Any] = Body(...)):
    from .storage import normalize_items
    data = dict(body)
    data["items"] = normalize_items(data.get("kind") or "tag", data.get("items"))
    report = _resolve_list_items(data)
    saved = LISTS.save(data, list_id=body.get("id") or None, create_only=bool(body.get("id")))
    return {**saved, "resolve_report": report}


@router.get("/lists/{list_id}")
@_guard
def v2_list_get(list_id: str):
    d = LISTS.get(list_id)
    if d is None:
        return _err(404, "not_found", f"清单「{list_id}」不存在")
    return d


@router.put("/lists/{list_id}")
@_guard
def v2_list_put(list_id: str, body: Dict[str, Any] = Body(...)):
    from .storage import normalize_items
    data = dict(body)
    old = LISTS.get(list_id) or {}
    data.setdefault("kind", old.get("kind") or "tag")
    data.setdefault("name", old.get("name"))
    data["items"] = normalize_items(data.get("kind") or "tag", data.get("items", old.get("items")))
    report = _resolve_list_items(data)
    saved = LISTS.save(data, list_id=list_id)
    return {**saved, "resolve_report": report}


@router.delete("/lists/{list_id}")
@_guard
def v2_list_delete(list_id: str):
    if not LISTS.delete(list_id):
        return _err(404, "not_found", f"清单「{list_id}」不存在")
    return {"ok": True}


# ---------------------------------------------------------------- 方案
@router.get("/plans")
@_guard
def v2_plans():
    return PLANS.all()


@router.get("/plans/{name}")
@_guard
def v2_plan_get(name: str):
    d = PLANS.get(name)
    if d is None:
        return _err(404, "not_found", f"方案「{name}」不存在")
    return d


@router.post("/plans/{name}")
@_guard
def v2_plan_save(name: str, body: Dict[str, Any] = Body(...)):
    spec = _spec_from(body)
    saved = PLANS.save(name, spec_to_dict(spec))
    return saved


@router.delete("/plans/{name}")
@_guard
def v2_plan_delete(name: str):
    if not PLANS.delete(name):
        return _err(404, "not_found", f"方案「{name}」不存在")
    return {"ok": True}


# ---------------------------------------------------------------- 问数据（SQL）
@router.get("/sql/schema")
@_guard
def v2_sql_schema():
    try:
        snap = HUB.current()
    except NoDatabase:
        return schema_doc.build_schema(None)

    def run(snap):
        key = "schema"
        with snap.cache_lock:
            hit = snap.cache.get(key)
        if hit is not None:
            return hit
        conn = snap.connect()
        try:
            res = schema_doc.build_schema(conn)
        finally:
            conn.close()
        with snap.cache_lock:
            snap.cache[key] = res
        return res
    return with_snapshot(run)


@router.post("/sql")
@_guard
def v2_sql(body: Dict[str, Any] = Body(...)):
    sql = body.get("sql") or ""
    limit = body.get("limit") or sqlsafe.MAX_ROWS

    def run(snap):
        conn = snap.connect()
        try:
            return sqlsafe.run_query(conn, sql, limit=int(limit), lists=LISTS.all())
        finally:
            conn.close()
    return with_snapshot(run)


# ---------------------------------------------------------------- AI
@router.get("/ai/status")
@_guard
def v2_ai_status():
    from . import ai
    return ai.status()


# ---- API 通道的设置（v2.ai.api）。任何接口都不返回 API key 本身。
@router.get("/ai/config")
@_guard
def v2_ai_config_get():
    """{protocol, preset, base_url, model, max_tokens, has_key, key_hint（…后 4 位）, key_from_env, configured, problem}。
    config.json 存在但读不出来时返回 500 config_invalid（不能当成空设置给网页，网页会以为还没设置）。"""
    from . import aiapi
    broken = aiapi.config_file_error()
    if broken:
        return _err(500, "config_invalid", broken)
    return aiapi.public_config()


@router.put("/ai/config")
@_guard
def v2_ai_config_put(body: Any = Body(...)):
    """{protocol, preset, base_url, model, max_tokens, api_key?, clear_key?} → 写进 config.json 的 v2.ai.api（其余配置原样保留）。
    返回 {ok, message（接口地址换了、key 被清掉时的说明）, key_cleared, config（同 GET）}。key 的规则见 aiapi.update_config。"""
    from . import aiapi
    try:
        return aiapi.update_config(body)
    except aiapi.ConfigError as e:
        return _err(e.status, e.code, e.message)


@router.post("/ai/test")
@_guard
def v2_ai_test(body: Optional[Dict[str, Any]] = Body(default=None)):
    """「测试」：用表单里的 protocol / base_url / model / api_key（可以还没保存）发一个很短的请求。
    没给 api_key 时用已保存的 key（只在接口地址的协议、域名、端口都没变时）。返回 {ok, ms, reply, error, error_code}。"""
    from . import aiapi
    try:
        a = aiapi.form_config(body, need_model=True)
    except aiapi.ConfigError as e:
        return {"ok": False, "ms": 0, "reply": None, "error": e.message, "error_code": e.code}
    return aiapi.ping(a)


@router.post("/ai/models")
@_guard
def v2_ai_models(body: Optional[Dict[str, Any]] = Body(default=None)):
    """「列出模型」（只对 openai 协议）：GET {base_url}/models。参数同 /ai/test（model 可以不填）。
    返回 {ok, models: [模型名…], error}。"""
    from . import ai, aiapi
    try:
        a = aiapi.form_config(body, need_model=False)
        names = aiapi.list_models(a)
    except aiapi.ConfigError as e:
        return {"ok": False, "models": [], "error": e.message, "error_code": e.code}
    except ai.AIError as e:
        return {"ok": False, "models": [], "error": e.message, "error_code": e.code}
    return {"ok": True, "models": names, "error": None}


@router.post("/ai/fill")
@_guard
def v2_ai_fill(body: Dict[str, Any] = Body(...)):
    from . import ai
    return ai.fill(text=body.get("text") or "", spec_raw=body.get("spec"), engine_id=body.get("engine"))


@router.post("/ai/ask")
@_guard
def v2_ai_ask(body: Dict[str, Any] = Body(...)):
    from . import ai
    return ai.ask(question=body.get("question") or "", engine_id=body.get("engine"))


@router.post("/ai/ask/fix")
@_guard
def v2_ai_ask_fix(body: Dict[str, Any] = Body(...)):
    """「让 AI 改」：{question, sql, error, engine?} → 和 /ai/ask 一样的返回（改好的 SQL 照样自动跑）。"""
    from . import ai
    return ai.ask_fix(question=body.get("question") or "", sql=body.get("sql") or "", error=body.get("error") or "",
                      engine_id=body.get("engine"))


# ---- 流式（SSE）：open {job_id} → status {stage, message, ms} / delta {text} … → result {同非流式的返回} | error {code, message}
_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _sse(kind: str, work, client_id: Any) -> StreamingResponse:
    from . import ai
    return StreamingResponse(ai.sse_events(kind, work, job_id=str(client_id) if client_id else None),
                             media_type="text/event-stream", headers=_SSE_HEADERS)


@router.post("/ai/fill/stream")
async def v2_ai_fill_stream(body: Dict[str, Any] = Body(...)):
    """当前方案本身不合格 → 422（和非流式一样，不开流）；其余错误都在流里（result.ok = false 或 error 事件）。"""
    from . import ai
    spec_raw = body.get("spec")
    if not ai.spec_too_long(spec_raw):             # 太大的方案不先解析：fill_job 会在流里报 too_long
        try:
            parse_spec(spec_raw if spec_raw is not None else default_spec())
        except SpecError as e:
            return _err(422, "bad_spec", "方案格式不对：" + "；".join(e.messages), detail=e.messages)
    text, engine_id = body.get("text") or "", body.get("engine")
    return _sse("fill", lambda job: ai.fill_job(text, spec_raw, engine_id, job), body.get("client_id"))


@router.post("/ai/ask/stream")
async def v2_ai_ask_stream(body: Dict[str, Any] = Body(...)):
    from . import ai
    question, engine_id = body.get("question") or "", body.get("engine")
    return _sse("ask", lambda job: ai.ask_job(question, engine_id, job), body.get("client_id"))


@router.post("/ai/ask/fix/stream")
async def v2_ai_ask_fix_stream(body: Dict[str, Any] = Body(...)):
    from . import ai
    question, engine_id = body.get("question") or "", body.get("engine")
    fix = {"sql": body.get("sql") or "", "error": body.get("error") or ""}
    return _sse("ask", lambda job: ai.ask_job(question, engine_id, job, fix=fix), body.get("client_id"))


@router.post("/ai/warm")
@_guard
def v2_ai_warm(body: Optional[Dict[str, Any]] = Body(default=None)):
    """前端打开工作台 / 问数据页时调：{kinds: ['fill'] | ['ask'], engine?}。立刻返回，claude 进程在后台开（只有 claude 有预热）。"""
    from . import ai
    body = body or {}
    kinds = body.get("kinds") or ["fill", "ask"]
    if isinstance(kinds, str):
        kinds = [kinds]
    return ai.warm(kinds, body.get("engine"))


@router.post("/ai/cancel")
@_guard
def v2_ai_cancel(body: Dict[str, Any] = Body(...)):
    """{job_id}（= 流式请求时前端给的 client_id，或 open 事件里的 job_id）：杀掉这次请求正在用的进程，或断开 API 连接。"""
    from . import ai
    return {"ok": ai.cancel_job(str(body.get("job_id") or body.get("client_id") or ""))}


@router.get("/ai/pool")
@_guard
def v2_ai_pool():
    from . import ai
    return ai.POOL.status()


def _ai_shutdown() -> None:
    """后端退出：关掉所有预热的 / 正在用的 claude 进程（整棵进程树）。ai 模块没加载过就什么都不用做。"""
    import sys
    m = sys.modules.get(__package__ + ".ai") if __package__ else None
    if m is not None:
        m.shutdown_pool()


router.add_event_handler("shutdown", _ai_shutdown)


# ---------------------------------------------------------------- 自动点击（可选）：用方案抽题
@router.post("/autoclick/auto/start")
async def v2_autoclick_auto_start(body: Optional[Dict[str, Any]] = Body(default=None)):
    """启动自动模式（房主出题），每轮用方案抽题。停止用 /autoclick/auto/stop，状态用 /autoclick/status。"""
    import random as _random
    from .store import C_NAME as _C_NAME
    body = body or {}
    mode = str(body.get("mode") or "host").lower()
    try:
        spec = parse_spec(body.get("spec"))
    except SpecError as e:
        return _err(422, "bad_spec", "方案格式不对：" + "；".join(e.messages), detail=e.messages)
    base_seed = int(spec.draw.seed if spec.draw.seed is not None else _random.getrandbits(31))
    counter = {"n": 0}

    # 启动前先检查：方案有没生效的部分、或者题库是空的，就不启动。
    # （启动后抽不出题，点击器只会每 3 秒重试一次。）
    from anyio import to_thread as _to_thread
    try:
        ev0 = await _to_thread.run_sync(lambda: engine.evaluate(spec))
    except NoDatabase as e:
        return {"ok": False, "error": str(e)}
    if ev0.errors:
        return {"ok": False, "error": "方案里有没生效的部分，先修好再开自动：" + "；".join(e["message"] for e in ev0.errors)}
    if not ev0.pool:
        return {"ok": False, "error": "题库是空的，自动模式没启动"}

    from .. import app as app_mod          # 点击器实例在 app.py 里（懒导入，避免循环 import）
    last_note = {"msg": None}

    def note(msg: str) -> None:            # 同一句话只记一次日志，免得每轮刷屏
        if last_note["msg"] != msg:
            last_note["msg"] = msg
            try:
                app_mod.AC.log("warn", msg)
            except Exception:  # noqa: BLE001
                pass

    def provider():
        """抽不出来时返回 (None, "", None)：点击器会显示「抽题失败」、3 秒后重试。"""
        counter["n"] += 1
        try:
            ev = engine.evaluate(spec)             # 有缓存；库换了会自动重算
        except Exception as e:  # noqa: BLE001
            note(f"方案求值失败：{e}；这一轮不出题")
            return None, "", None
        if ev.errors:
            note("方案里有没生效的部分：" + "；".join(e["message"] for e in ev.errors) + "；这一轮不出题")
            return None, "", None
        cid, _rid, work, _ = engine.draw(ev, (base_seed + counter["n"]) & 0x7FFFFFFF, spec.draw.method)
        if cid is None:
            note("方案的题库是空的；这一轮不出题")
            return None, "", None
        last_note["msg"] = None
        name = ev.snap.C[cid][_C_NAME]
        wname = ev.snap.S[work][S_NAME] if (work is not None and work in ev.snap.S) else None
        return cid, name, (wname if wname and "-" not in wname else None)   # 作品名带「-」就不给提示

    try:
        result = app_mod.AC.start_auto(mode=mode, provider=provider, provider_name="spec")
        return {"ok": True, "result": result, "status": await app_mod.AC.status_async()}
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=200, content={"ok": False, "error": str(e)})


# ---------------------------------------------------------------- 启动预热
def warmup() -> None:
    HUB.warmup(modes=["anime"], tag_counts=[6])


warmup()
