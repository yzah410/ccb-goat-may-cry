"""把当前模式的角色画像转成导图生成器（canvas_logic / canvas_gen）需要的数据结构；分组、去重和布局由生成器负责。"""
from __future__ import annotations

from types import SimpleNamespace

from ..canvas_logic import TAG_GROUPS
from .store import (C_HEAT, C_NAME, P_EARLIEST, P_LATEST, P_NAPP, P_RATING,
                    P_SOURCE, S_HEAT, S_NAME, S_YEAR)


def make_canvas_store(ev):
    """只适配已求值的整池，不重新筛选。"""
    snap, mp = ev.snap, ev.mp
    chars, works, sources, appearances = {}, {}, {}, {}
    required_tags = TAG_GROUPS["G_format"] | TAG_GROUPS["G_source"]
    for cid in sorted(ev.pool):
        c = snap.C.get(cid)
        if c is None:
            continue
        p = mp.prof.get(cid)
        has_profile = bool(p) and bool(p[P_NAPP])
        source = p[P_SOURCE] if has_profile else None
        # 对局标签数控制题材标签；必需展示的来源 / 播放形式不能被该数量截断。
        tags = set(ev.ti.by_char.get(cid, ()))
        if has_profile:
            tags.update(t for t in mp.tags.get(cid, ()) if t in required_tags)
        chars[cid] = {
            "name": c[C_NAME], "heat": c[C_HEAT],
            "max_score": p[P_RATING] if has_profile and p[P_RATING] is not None and p[P_RATING] >= 0 else 0,
            "earliest_year": p[P_EARLIEST] if has_profile else None,
            "latest_year": p[P_LATEST] if has_profile else None,
            "work_tags_from_char": sorted(tags), "source_tag_from_char": source,
        }
        sources[cid] = source
        # 登场作品取 profile_app（已按模式和有效登场规则过滤），不取范围里的 bound_work。
        appearances[cid] = [(sid, None) for sid in mp.apps.get(cid, ())] if has_profile else []
        for sid, _ in appearances[cid]:
            if sid in works:
                continue
            s = snap.S.get(sid)
            if s is not None:
                works[sid] = {
                    "id": sid, "name": s[S_NAME], "year": s[S_YEAR],
                    "favorites": s[S_HEAT], "tags": set(), "meta_tags": set(),
                }

    # 一个连接分批读取，避免每个角色 / 作品开连接（大候选池可包含数万作品）。
    conn = snap.connect()
    try:
        work_ids = sorted(works)
        for start in range(0, len(work_ids), 500):
            ids = work_ids[start:start + 500]
            placeholders = ",".join("?" for _ in ids)
            if "subject_tag" in snap.tables:
                for sid, tag in conn.execute(
                    f"SELECT subject_id, name FROM subject_tag WHERE subject_id IN ({placeholders})", ids
                ):
                    if tag:
                        works[sid]["tags"].add(tag)
            if "subject_meta_tag" in snap.tables:
                for sid, tag in conn.execute(
                    f"SELECT subject_id, tag FROM subject_meta_tag WHERE subject_id IN ({placeholders})", ids
                ):
                    if tag:
                        works[sid]["meta_tags"].add(tag)
    finally:
        conn.close()
    return SimpleNamespace(char=chars, work=works, char_source=sources, char_appear_valid=appearances)
