# backend/classic.py
"""经典工作台的后端状态：经典工作台数据的加载、可用性、方案目录、样例方案。

经典工作台数据放在 data/classic/（文件名见 paths.CLASSIC_FILES）。数据齐全，后端启动时就加载；
没有或加载失败，后端照常启动，经典接口返回 503，GET /classic/status 把原因告诉前端，
前端据此在导航里隐藏经典工作台的入口，直接打开它的页面时显示一页说明。

DS / ENGINE 是模块级变量，只在 init() 里赋值；用的时候写 `classic.DS`，不要在导入时拷贝。
"""
from __future__ import annotations

import os
import shutil
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import HTTPException

from .paths import REPO_ROOT, classic_dir, classic_missing
from .schemas import ConfigPayload

# 经典工作台的方案文件（一个方案一个 json）
PLANS_DIR = os.path.join(REPO_ROOT, "data", "plans")
# 仓库附带的样例方案
SAMPLES_DIR = os.path.join(REPO_ROOT, "examples", "classic-plans")

CFG: Dict[str, Any] = {}
DS: Any = None
ENGINE: Any = None
REASON: Optional[str] = "经典工作台数据还没有加载"


def init(cfg: Dict[str, Any]) -> None:
    """经典工作台数据齐全就加载。任何原因加载不了，都只记下原因，不抛异常。"""
    global CFG, DS, ENGINE, REASON
    CFG = cfg
    missing = classic_missing(cfg)
    if missing:
        REASON = f"没有经典工作台数据：{rel(classic_dir(cfg))} 里缺 {'、'.join(missing)}"
        print(f"[classic] {REASON}。经典工作台不可用，其余功能不受影响。", flush=True)
        return
    try:
        from .data_loader import DataStore
        from .engine import OutsetEngine

        t0 = time.perf_counter()
        ds = DataStore(cfg)
        ds.load()
        DS, ENGINE, REASON = ds, OutsetEngine(ds), None
        print(f"[classic] 经典工作台数据已加载：作品 {len(ds.work)}，角色 {len(ds.char)}，用时 {time.perf_counter() - t0:.1f}s", flush=True)
    except Exception as e:  # 数据文件损坏、格式不对等
        DS, ENGINE = None, None
        REASON = f"经典工作台数据加载失败：{e}"
        print(f"[classic] {REASON}。经典工作台不可用，其余功能不受影响。", flush=True)


def rel(path: str) -> str:
    """相对仓库根的路径（给界面和日志看，不暴露本机的完整路径）。"""
    try:
        return os.path.relpath(path, REPO_ROOT).replace("\\", "/")
    except ValueError:
        return path


def available() -> bool:
    return DS is not None


def sample_files() -> List[str]:
    if not os.path.isdir(SAMPLES_DIR):
        return []
    return sorted(f for f in os.listdir(SAMPLES_DIR) if f.endswith(".json"))


def status() -> Dict[str, Any]:
    return {
        "available": available(),
        "works": len(DS.work) if DS is not None else 0,
        "chars": len(DS.char) if DS is not None else 0,
        "sample_plans": len(sample_files()),
        "reason": REASON,
    }


def require_classic() -> None:
    """经典接口的依赖项：没有经典工作台数据就返回 503。"""
    if DS is None:
        raise HTTPException(status_code=503, detail=REASON or "经典工作台数据没有加载")


def load_samples() -> Dict[str, Any]:
    """把样例方案复制进方案目录。方案目录里已有同名文件的不动。"""
    os.makedirs(PLANS_DIR, exist_ok=True)
    added = skipped = 0
    for fname in sample_files():
        dst = os.path.join(PLANS_DIR, fname)
        if os.path.exists(dst):
            skipped += 1
            continue
        shutil.copyfile(os.path.join(SAMPLES_DIR, fname), dst)
        added += 1
    return {"ok": True, "added": added, "skipped": skipped}


def plan_path(name: str) -> Optional[str]:
    """方案名 → data/plans 里的文件路径。名字带路径分隔符、冒号、..，或解析后跑出 data/plans 的，返回 None。"""
    if not name or name in (".", "..") or any(c in name for c in "/\\:\x00"):
        return None
    base = os.path.realpath(PLANS_DIR)
    fpath = os.path.realpath(os.path.join(base, f"{name}.json"))
    if os.path.dirname(fpath) != base:
        return None
    return fpath


# -------------------- 候选角色卡 --------------------
def build_draw_body(cfg: ConfigPayload, cid: int, wid: Optional[int] = None) -> dict:
    """组装角色卡主体（/draw 和 /candidates 共用）。"""
    ds = DS
    c = ds.char[cid]

    # ---- 1) 角色基础信息 ----
    ey_char = c.get("earliest_year_from_char")
    ly_char = c.get("latest_year_from_char")
    earliest_year = ey_char if ey_char is not None else c.get("earliest_year")
    latest_year = ly_char if ly_char is not None else c.get("latest_year")

    char_obj = {
        "id": cid,
        "name": c["name"],
        "gender": c["gender"],
        "heat": c["heat"],
        "max_score": c.get("max_score", 0.0),
        "earliest_year": earliest_year,
        "latest_year": latest_year,
    }

    # ---- 2) 登场作品：先按登场表算，再用 characters_db 里的统计覆盖 ----
    apps = ds.char_appear_valid.get(cid, [])
    work_ids = [w for (w, t) in apps if w in ds.work]
    uniq_wids = sorted(set(work_ids))
    appear_count_fallback = len(uniq_wids)

    appear_best_fallback = None
    if appear_count_fallback > 0:
        best_wid = max(uniq_wids, key=lambda x: ds.work[x]["favorites"])
        bw = ds.work[best_wid]
        appear_best_fallback = {
            "id": best_wid,
            "name": bw["name"],
            "year": bw["year"],
            "favorites": bw["favorites"],
        }

    work_count_from_char = c.get("work_count_from_char")
    appearances_from_char = c.get("appearances_from_char")

    work_count: Optional[int] = work_count_from_char if isinstance(work_count_from_char, int) else None
    appearances: Optional[list[str]] = list(appearances_from_char) if isinstance(appearances_from_char, list) else None

    if appearances:
        if work_count is None:
            work_count = len(appearances)
        appear_count = work_count
        best_name = appearances[0]
        appear_best = {"id": None, "name": best_name, "year": None, "favorites": 0}
    else:
        appearances = None
        if work_count is None:
            work_count = appear_count_fallback
        appear_count = appear_count_fallback
        appear_best = appear_best_fallback

    # ---- 3) 标签：来源 + 作品标签（含可选 additional）+ 播放形式 + 角色标签 ----
    source_tag = c.get("source_tag_from_char") or ds.char_source.get(cid)

    work_tag_set: set[str] = set()
    work_tags_from_char = c.get("work_tags_from_char")
    if isinstance(work_tags_from_char, list):
        work_tag_set |= set(map(str, work_tags_from_char))

    if cfg.include_extra_work_tags:
        add_tags_from_char = c.get("additional_work_tags_from_char")
        if isinstance(add_tags_from_char, list):
            for item in add_tags_from_char:
                if isinstance(item, dict):
                    nm = item.get("name")
                    if nm:
                        work_tag_set.add(str(nm))

    if not work_tag_set:
        for wid0 in uniq_wids:
            w = ds.work.get(wid0)
            if not w:
                continue
            work_tag_set |= set(w.get("work_tags", []))

    work_tags = sorted(work_tag_set)
    PLAYBACK_WHITELIST = ["TV", "剧场版", "OVA", "WEB", "动态漫画"]
    playback_tags = [t for t in PLAYBACK_WHITELIST if t in work_tag_set]
    char_tags = sorted(list(c.get("char_tags", set())))

    base = {
        "mode": cfg.mode,
        "char_id": cid,
        "character": char_obj,

        "appear_count": appear_count,
        "appear_best": appear_best,

        # 来自 characters_db
        "work_count": work_count,
        "appearances": appearances,

        # 标签相关
        "source_tag": source_tag,
        "playback_tags": playback_tags,
        "work_tags": work_tags,
        "char_tags": char_tags,
    }

    if wid:
        w = ds.work[wid]
        base.update({
            "bound_work_id": wid,
            "bound_work": {"id": wid, "name": w["name"], "year": w["year"]},
        })

    return base


# -------------------- 自动点击器的抽题函数 --------------------
def make_provider(cfg: ConfigPayload) -> Callable[[], Tuple[Optional[int], str, Optional[str]]]:
    """给点击器用的抽题函数：每调用一次，种子加 1 重新抽一次，不会一直抽到同一个角色。"""
    base_seed = (getattr(cfg, "seed", None) or int(time.time() * 1000)) & 0x7fffffff
    counter = 0

    def _provider() -> Tuple[Optional[int], str, Optional[str]]:
        nonlocal counter
        counter += 1
        cfg2 = cfg.model_copy()
        cfg2.seed = (base_seed + counter) & 0x7fffffff

        cid, wid = ENGINE.draw(cfg2)
        if not cid:
            raise RuntimeError("按这个方案抽不出角色")

        c = DS.char.get(cid)
        if not c:
            raise RuntimeError(f"角色 {cid} 不在经典工作台数据里")

        name = c["name"]
        hint = None
        if wid and wid in DS.work:
            wname = DS.work[wid]["name"]
            hint = wname if "-" not in wname else None
        return cid, name, hint

    return _provider
