# backend/api_ext.py
"""经典工作台前端用的附加接口（统计、标签补全、方案摘要、数据文件信息）。这些接口只读，不改变筛选结果。
没有经典工作台数据时全部返回 503（见 classic.py）。

  POST /stats       候选池统计（入参同 /candidates：{"config": ConfigPayload}；也接受裸 ConfigPayload）
  GET  /tags        标签自动补全 ?kind=work|char|va|source&q=&limit=20
  GET  /ext/plans   方案列表 + 组块摘要（/plans 的超集）
  GET  /ext/meta    经典工作台数据文件的大小 / 修改时间，和方案数

DS / ENGINE / PLANS_DIR 在 classic.py 里，调用时再取（init() 之后才有值）。

处理函数都是 async def（和 classic_router.py 里其它接口一样在事件循环里顺序执行），
因为 ENGINE.build_pool 会改 BlockEngine 上的共享开关（include_extra_work_tags），不能放线程池并发跑。
"""
from __future__ import annotations

import json
import os
import re
import time
from collections import Counter, OrderedDict
from typing import Any, Dict, List, Tuple

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import classic
from .paths import CLASSIC_FILES, CLASSIC_REQUIRED, classic_dir, classic_paths
from .schemas import ConfigPayload

ext_router = APIRouter(tags=["经典工作台扩展接口"], dependencies=[Depends(classic.require_classic)])

PLAYBACK_WHITELIST = ["TV", "剧场版", "OVA", "WEB", "动态漫画"]
_PLAYBACK = set(PLAYBACK_WHITELIST)
SOURCE_CANON = ["原创", "漫画改", "小说改", "游戏改"]
_SOURCE = set(SOURCE_CANON)
_YEAR_TAG = re.compile(r"^\d{4}$")


def _parse_config(body: Any) -> ConfigPayload:
    raw = body.get("config", body) if isinstance(body, dict) else body
    return ConfigPayload.model_validate(raw)


def _validation_error(e: ValidationError) -> JSONResponse:
    # 和 FastAPI 自己的 422 一样的形状：{"detail": [...]}
    return JSONResponse(status_code=422, content={"detail": json.loads(e.json())})


# ------------------------------------------------------------------ /stats
def _char_work_tags(ds: Any, c: Dict[str, Any], cid: int, include_extra: bool) -> set:
    """和 classic.build_draw_body 同一套规则：characters_db 的 work_tags →（开关）并入 additional → 仍为空则退回登场作品标签并集。"""
    tags: set = set()
    wt = c.get("work_tags_from_char")
    if isinstance(wt, list):
        tags |= set(map(str, wt))
    if include_extra:
        extra = c.get("additional_work_tags_from_char")
        if isinstance(extra, list):
            for item in extra:
                if isinstance(item, dict) and item.get("name"):
                    tags.add(str(item["name"]))
    if not tags:
        for (wid, _t) in ds.char_appear_valid.get(cid, []):
            w = ds.work.get(wid)
            if w:
                tags |= set(w.get("work_tags", []))
    return tags


_STATS_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_STATS_CACHE_MAX = 32


def _compute_stats(cfg: ConfigPayload) -> Dict[str, Any]:
    ds, engine = classic.DS, classic.ENGINE
    t0 = time.perf_counter()
    char_weight, _bindings = engine.build_pool(cfg)

    by_year: Counter = Counter()
    by_gender: Counter = Counter()
    work_tags: Counter = Counter()
    char_tags: Counter = Counter()
    playback: Counter = Counter()
    source: Counter = Counter()
    no_year = 0
    score_sum = 0.0
    score_n = 0

    for cid in char_weight:
        c = ds.char.get(cid)
        if not c:
            continue
        # 年份：和 classic.build_draw_body 一样，characters_db 的 earliest_appearance 优先
        ey = c.get("earliest_year_from_char")
        if ey is None:
            ey = c.get("earliest_year")
        if ey is None:
            no_year += 1
        else:
            by_year[int(ey)] += 1

        g = c.get("gender") or "?"
        by_gender[g if g in ("♂", "♀") else "?"] += 1

        s = c.get("max_score")
        if isinstance(s, (int, float)) and s > 0:
            score_sum += float(s)
            score_n += 1

        for t in _char_work_tags(ds, c, cid, cfg.include_extra_work_tags):
            if t in _PLAYBACK:
                playback[t] += 1
            elif t in _SOURCE or _YEAR_TAG.match(t):
                continue
            else:
                work_tags[t] += 1

        src = c.get("source_tag_from_char") or ds.char_source.get(cid)
        if src:
            source[str(src)] += 1

        for t in c.get("char_tags", ()) or ():
            char_tags[str(t)] += 1

    years = sorted(by_year)
    by_year_list: List[Dict[str, int]] = []
    if years:
        # 连续年份轴：没有人的年份补 0，图上不会「跳年」
        for y in range(years[0], years[-1] + 1):
            by_year_list.append({"year": y, "count": by_year.get(y, 0)})

    return {
        "total": len(char_weight),
        "by_year": by_year_list,
        "by_gender": {"♀": by_gender.get("♀", 0), "♂": by_gender.get("♂", 0), "?": by_gender.get("?", 0)},
        "top_work_tags": [{"tag": t, "count": n} for t, n in work_tags.most_common(30)],
        "top_char_tags": [{"tag": t, "count": n} for t, n in char_tags.most_common(30)],
        "playback": {k: playback.get(k, 0) for k in PLAYBACK_WHITELIST},
        "source": {k: n for k, n in source.most_common()},
        "year_min": years[0] if years else None,
        "year_max": years[-1] if years else None,
        "avg_score": round(score_sum / score_n, 2) if score_n else None,
        "no_year": no_year,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    }


@ext_router.post("/stats")
async def stats(body: Any = Body(...)):
    """候选池统计：年份分布、性别、最常见的作品/角色标签、播放形式、来源。"""
    try:
        cfg = _parse_config(body)
    except ValidationError as e:
        return _validation_error(e)
    key = cfg.model_dump_json()
    hit = _STATS_CACHE.get(key)
    if hit is not None:
        _STATS_CACHE.move_to_end(key)
        return {**hit, "cached": True}
    res = _compute_stats(cfg)
    _STATS_CACHE[key] = res
    while len(_STATS_CACHE) > _STATS_CACHE_MAX:
        _STATS_CACHE.popitem(last=False)
    return res


# ------------------------------------------------------------------ /tags
_TAG_INDEX: Dict[str, List[Tuple[str, int]]] = {}


def _build_tag_index(kind: str) -> List[Tuple[str, int]]:
    ds = classic.DS
    cnt: Counter = Counter()
    if kind == "work":
        # 作品标签：作品倒排索引里的作品数；角色上独有的作品标签（characters_db）按角色数补进来
        for t, ws in ds.work_by_tag.items():
            cnt[str(t)] = len(ws)
        extra: Counter = Counter()
        for c in ds.char.values():
            wt = c.get("work_tags_from_char")
            if isinstance(wt, list):
                for t in wt:
                    t = str(t)
                    if t not in cnt:
                        extra[t] += 1
        cnt.update(extra)
    elif kind == "char":
        for c in ds.char.values():
            cnt.update(str(t) for t in (c.get("char_tags") or ()))
    elif kind == "va":
        for c in ds.char.values():
            cnt.update(str(t) for t in (c.get("va_tags") or ()))
    elif kind == "source":
        # blocks.py 里来源块的判定只看 DS.char_source（来自 character_source_counts.json）
        for v in ds.char_source.values():
            cnt[str(v)] += 1
        for s in SOURCE_CANON:
            cnt.setdefault(s, 0)
    return sorted(cnt.items(), key=lambda x: (-x[1], x[0]))


@ext_router.get("/tags")
async def tags(
    kind: str = Query("work", pattern="^(work|char|va|source)$"),
    q: str = "",
    limit: int = Query(20, ge=1, le=100),
):
    """标签自动补全：完全相同 > 前缀匹配 > 包含，同一档里按出现次数降序。"""
    idx = _TAG_INDEX.get(kind)
    if idx is None:
        idx = _build_tag_index(kind)
        _TAG_INDEX[kind] = idx
    qn = q.strip().casefold()
    if not qn:
        matched = idx
    else:
        exact: List[Tuple[str, int]] = []
        prefix: List[Tuple[str, int]] = []
        contains: List[Tuple[str, int]] = []
        for name, n in idx:
            k = name.casefold()
            if k == qn:
                exact.append((name, n))
            elif k.startswith(qn):
                prefix.append((name, n))
            elif qn in k:
                contains.append((name, n))
        matched = exact + prefix + contains
    return {
        "kind": kind,
        "q": q,
        "items": [{"name": n, "count": c} for n, c in matched[:limit]],
        "total_matched": len(matched),
    }


# ------------------------------------------------------------------ /ext/plans
@ext_router.get("/ext/plans")
async def plans_ext():
    """和 GET /plans 一样的列表（同样的排序、同样跳过坏文件），多带组块摘要。"""
    plans_dir = classic.PLANS_DIR
    os.makedirs(plans_dir, exist_ok=True)
    out: List[Dict[str, Any]] = []
    for fname in os.listdir(plans_dir):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(plans_dir, fname), "r", encoding="utf-8") as f:
                data = json.load(f)
            blocks = data.get("blocks") or []
            out.append(
                {
                    "name": data.get("name", fname[:-5]),
                    "file": fname[:-5],
                    "updated_at": data.get("updated_at", ""),
                    "created_at": data.get("created_at", ""),
                    "mode": data.get("mode", ""),
                    "seed": data.get("seed"),
                    "theme": data.get("theme"),
                    "include_extra_work_tags": bool(data.get("include_extra_work_tags", False)),
                    "block_count": len(blocks),
                    "blocks": [
                        {
                            "kind": b.get("kind"),
                            "color": b.get("color"),
                            "enabled": b.get("enabled", True) is not False,
                            "weight": b.get("weight", 1),
                        }
                        for b in blocks
                        if isinstance(b, dict)
                    ],
                }
            )
        except Exception:
            continue
    out.sort(key=lambda p: p.get("updated_at", ""), reverse=True)
    return {"plans": out}


# ------------------------------------------------------------------ /ext/meta
def _file_entry(key: str, path: str) -> Dict[str, Any]:
    e: Dict[str, Any] = {
        "key": key,
        "name": CLASSIC_FILES[key],
        "path": classic.rel(path),
        "required": key in CLASSIC_REQUIRED,
        "exists": False,
    }
    if os.path.exists(path):
        st = os.stat(path)
        e.update(exists=True, size=st.st_size, mtime=st.st_mtime)
    return e


@ext_router.get("/ext/meta")
async def data_meta():
    """经典工作台数据文件的新鲜度，给前端「数据」页用。只读文件属性，不读内容。"""
    cfg = classic.CFG
    files = [_file_entry(k, p) for k, p in classic_paths(cfg).items()]
    plans_dir = classic.PLANS_DIR
    plans_count = len([f for f in os.listdir(plans_dir) if f.endswith(".json")]) if os.path.isdir(plans_dir) else 0
    return {
        "data_root": classic.rel(classic_dir(cfg)),
        "files": files,
        "plans_count": plans_count,
        "server_time": time.time(),
    }
