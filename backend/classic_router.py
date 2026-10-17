# backend/classic_router.py
"""经典工作台的接口：状态、预览 / 抽题 / 候选、导图导出、方案文件、样例方案。

GET /classic/status 任何时候都能调，前端靠它决定显不显示经典工作台；
其余接口都依赖经典工作台数据，没有经典工作台数据时返回 503（见 classic.require_classic）。
处理函数都是 async def，在事件循环里顺序执行：ENGINE.build_pool 会改 BlockEngine 上的共享开关，不能并发跑。
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from . import classic
from .canvas_gen import CanvasGenerator
from .canvas_logic import generate_canvas_data
from .classic import build_draw_body, plan_path
from .schemas import CandidateItem, CandidatesReq, CandidatesResp, ConfigPayload, DrawResp, PreviewResp

router = APIRouter()
guarded = APIRouter(dependencies=[Depends(classic.require_classic)])


@router.get("/classic/status")
async def classic_status():
    """经典工作台能不能用：{available, works, chars, sample_plans, reason}。"""
    return classic.status()


# -------------------- 基础 / 预览 / 抽题 --------------------
@guarded.get("/status")
async def status():
    return {"works": len(classic.DS.work), "chars": len(classic.DS.char), "ready": True}


@guarded.post("/preview", response_model=PreviewResp)
async def preview(cfg: ConfigPayload):
    char_weight, _ = classic.ENGINE.build_pool(cfg)
    sample = []
    for i, (cid, w) in enumerate(list(char_weight.items())[:30]):
        c = classic.DS.char[cid]
        sample.append({
            "id": cid,
            "name": c["name"],
            "gender": c["gender"],
            "heat": c["heat"],
            "weight": w,
            "earliest_year": c.get("earliest_year"),
            "latest_year": c.get("latest_year"),
        })
    return PreviewResp(total_candidates=len(char_weight), sample=sample)


@guarded.post("/draw", response_model=DrawResp)
async def draw(cfg: ConfigPayload):
    cid, wid = classic.ENGINE.draw(cfg)
    if not cid:
        return DrawResp(mode=cfg.mode, char_id=None, character=None)
    base = build_draw_body(cfg, cid, wid)
    return DrawResp(**base)


def _norm_key(s: str) -> str:
    # 全小写，便于 a-z 排序
    return (s or "").casefold()


@guarded.post("/candidates", response_model=CandidatesResp)
async def candidates(payload: CandidatesReq):
    cfg = payload.config
    page = max(1, int(payload.page or 1))
    page_size = min(20, max(1, int(payload.page_size or 10)))
    sort_mode = (payload.sort_mode or "time")

    # 复用引擎池：拿到角色权重 & 按作品权重时的绑定 wid
    char_weight, bound = classic.ENGINE.build_pool(cfg)

    # 组装所有候选的卡片主体 + 权重
    items: list[CandidateItem] = []
    for cid, w in char_weight.items():
        wid = bound.get(cid) if cfg.mode == "work-weight" else None
        base = build_draw_body(cfg, cid, wid)
        items.append(CandidateItem(weight=float(w), **base))

    # 时间模式的排序：时间 ↑，权重 ↓，评分 ↓，作品名 a-z，角色名 a-z
    if sort_mode == "time":
        def _sort_key(it: CandidateItem):
            char = it.character or {}
            ey = char.get("earliest_year")
            ey = ey if (ey is not None) else 10**9  # 空年排最后
            score = float(char.get("max_score") or 0.0)

            # 作品名：优先 appear_best.name；再退 appearances[0]
            work_name = ""
            ab = getattr(it, "appear_best", None)
            if isinstance(ab, dict) and ab.get("name"):
                work_name = ab["name"]
            else:
                apps = getattr(it, "appearances", None)
                if isinstance(apps, list) and apps:
                    work_name = str(apps[0])

            return (
                int(ey),
                -float(it.weight),
                -score,
                _norm_key(work_name),
                _norm_key(char.get("name") or ""),
            )
        items.sort(key=_sort_key)

    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    page_items = items[start:end]

    return CandidatesResp(
        total=total,
        page=page,
        page_size=page_size,
        items=page_items
    )


# -------------------- 导图导出 --------------------
class GenCanvasReq(BaseModel):
    config: ConfigPayload


@guarded.post("/generate_canvas")
async def generate_canvas_endpoint(payload: GenCanvasReq):
    # 1. 取候选角色 id
    char_weight, _ = classic.ENGINE.build_pool(payload.config)
    candidate_ids = list(char_weight.keys())

    # 2. 生成逻辑树
    logic_tree = generate_canvas_data(classic.DS, candidate_ids, payload.config.include_extra_work_tags)

    # 3. 生成 Canvas JSON
    gen = CanvasGenerator()
    canvas_data = gen.process(logic_tree)

    # 4. 返回文件流
    json_str = json.dumps(canvas_data, ensure_ascii=False, indent=2)
    return Response(
        content=json_str,
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=candidates.canvas"}
    )


# -------------------- 方案存储（一个方案一个 data/plans/*.json） --------------------
def _ensure_plans_dir():
    os.makedirs(classic.PLANS_DIR, exist_ok=True)


def _bad_plan_name():
    return JSONResponse({"error": "方案名不合法"}, status_code=400)


@guarded.get("/plans")
async def list_plans():
    _ensure_plans_dir()
    plans = []
    for fname in os.listdir(classic.PLANS_DIR):
        if fname.endswith(".json"):
            fpath = os.path.join(classic.PLANS_DIR, fname)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                plans.append({
                    "name": data.get("name", fname[:-5]),
                    "updated_at": data.get("updated_at", ""),
                    "mode": data.get("mode", ""),
                })
            except Exception:
                pass
    plans.sort(key=lambda p: p.get("updated_at", ""), reverse=True)
    return {"plans": plans}


@guarded.get("/plans/{name}")
async def get_plan(name: str):
    fpath = plan_path(name)
    if fpath is None:
        return _bad_plan_name()
    if not os.path.exists(fpath):
        return JSONResponse({"error": "方案不存在"}, status_code=404)
    with open(fpath, "r", encoding="utf-8") as f:
        return json.load(f)


@guarded.post("/plans/{name}")
async def save_plan(name: str, body: dict = Body(...)):
    fpath = plan_path(name)
    if fpath is None:
        return _bad_plan_name()
    _ensure_plans_dir()
    existing = {}
    if os.path.exists(fpath):
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                existing = json.load(f)
        except Exception:
            pass
    now = datetime.now(timezone.utc).isoformat()
    plan = {
        "name": name,
        "mode": body.get("mode", "char-weight"),
        "seed": body.get("seed"),
        "theme": body.get("theme"),
        "blocks": body.get("blocks", []),
        "include_extra_work_tags": body.get("include_extra_work_tags", False),
        "created_at": existing.get("created_at", now),
        "updated_at": now,
    }
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)
    return {"ok": True, "name": name}


@guarded.delete("/plans/{name}")
async def delete_plan(name: str):
    fpath = plan_path(name)
    if fpath is None:
        return _bad_plan_name()
    if os.path.exists(fpath):
        os.remove(fpath)
        return {"ok": True}
    return JSONResponse({"error": "方案不存在"}, status_code=404)


@guarded.post("/classic/samples/load")
async def load_samples():
    """把仓库附带的样例方案放进方案目录；已有同名方案的不覆盖。"""
    return classic.load_samples()


router.include_router(guarded)
