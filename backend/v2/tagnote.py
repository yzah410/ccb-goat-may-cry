"""标签笔记（TagNote）作品集 JSON：把候选池整理成前端六视图引擎要的数据。

只复用 .canvas 导图（canvas_logic）的数据准备（选角色 → 同一最早作品只留热度最高的角色 → 收集标签），
不建树、不排版：六种视图由前端引擎 tagnote.esm.js 现算。
"""
from __future__ import annotations

import datetime
from typing import Any, Callable, Dict, Iterable, List, Optional

from ..canvas_logic import TAG_GROUPS, LogicBuilder
from .canvas import make_canvas_store

SCHEMA = "tagnote/1"
# 六种视图是给一张导图（通常 20 部以内）设计的；太多时画面会挤到没法读。
MAX_WORKS = 80
# 标签取法：
#   map  —— 和 .canvas 导图画面上显示的一样：路径、入线文字、右侧小格里出现过的标签，外加全部播放形式和原作来源。
#           从 .canvas 导图导入的作品集、tagnote/data 里的示例数据都是这个口径（制作公司、G_4 只有参与分岔时才出现，零散低频标签不出现）。
#   full —— 角色的全部标签（_get_char_tags）。引擎会自己隐藏没有近邻共有的低频标签。
TAG_MODES = ("map", "full")
# Bangumi 的条目封面跳转地址：浏览器打开时 302 到 lain.bgm.tv 的 200px 宽封面，生成时不用联网。
COVER_URL = "https://api.bgm.tv/v0/subjects/{sid}/image?type=small"

# canvas_logic.TAG_GROUPS 是 set、没有顺序；引擎用这里的列表顺序决定同频标签的先后。
TAG_GROUPS_ORDERED: Dict[str, List[str]] = {
    "G_format": ["TV", "剧场版", "OVA", "OAD", "WEB", "动态漫画"],
    "G_1": ["恋爱", "百合", "战斗", "日常", "搞笑", "奇幻", "科幻", "治愈", "后宫", "校园", "萌"],
    "G_2": ["运动", "音乐", "偶像", "悬疑"],
    "G_3": ["热血", "青春", "3D", "推理", "机战", "萝卜", "竞技"],
    "G_4": ["猎奇", "欧美", "国产", "历史", "BL", "童年", "冒险", "女性向", "乙女", "党争", "异世界", "泡面番", "催泪", "智斗"],
    "G_source": ["漫画改", "原创", "小说改", "游戏改"],
    "G_staff": ["SUNRISE", "TRIGGER", "A-1Pictures", "MADHouse", "BONES", "P.A.WORKS", "MAPPA", "SHAFT", "GAINAX",
                "J.C.STAFF", "CloverWorks", "ufotable", "StudioPierrot", "Production.I.G", "WHITEFOX", "LIDENFILMS",
                "davidproduction", "OLM", "studiodeen", "SILVERLINK", "BrainsBase", "Lerche", "8bit", "Feel",
                "GONZO", "WITSTUDIO", "TMS", "StudioBind", "东映"],
}
assert {k: set(v) for k, v in TAG_GROUPS_ORDERED.items()} == TAG_GROUPS, "TAG_GROUPS_ORDERED 要和 canvas_logic.TAG_GROUPS 同步"


def year_str(char: Dict[str, Any]) -> str:
    """和 .canvas 导图的叶子一样：同一年写 2018，跨年写 10-18，没有写「年份未知」。"""
    ey = char["year_span_char"][0] or char["earliest_work"].get("year")
    ly = char["year_span_char"][1] or ey
    if ey is None:
        return "年份未知"
    return str(ey) if ey == ly else f"{str(ey)[2:]}-{str(ly)[2:]}"


def score_of(char: Dict[str, Any]) -> Optional[float]:
    """没有评分时 make_canvas_store 填 0；引擎把 null 显示成「—」。"""
    s = char.get("score")
    return round(float(s), 1) if s is not None and s > 0 else None


def shown_tags_by_work(builder: LogicBuilder) -> Dict[int, Callable[[str], bool]]:
    """跑一遍 .canvas 导图的分岔，给每张作品卡一个判断函数：某个标签在画面上（路径、入线文字、右侧小格）能不能看到。"""
    out: Dict[int, Callable[[str], bool]] = {}

    def walk(n: Dict[str, Any]) -> None:
        if n.get("type") == "char" and n.get("work_id") is not None:
            shown = set(n.get("_displayed_tags") or []) | set((n.get("residual") or "").split())
            # 入线文字用「-」连接，标签本身也可能带「-」（A-1Pictures），所以按整段匹配，不拆开
            edge = "-" + (n.get("edge_label") or "") + "-"
            out[n["work_id"]] = lambda t, shown=shown, edge=edge: t in shown or f"-{t}-" in edge
        for ch in n.get("children") or []:
            walk(ch)

    walk(builder.build_tree())
    return out


def works_from_store(ds, cids: Iterable[int], include_extra: bool = False, tag_mode: str = "map") -> List[Dict[str, Any]]:
    """ds 是 make_canvas_store 的结果。一部最早作品一条；顺序：年份 → 评分高到低 → 作品 ID。"""
    if tag_mode not in TAG_MODES:
        raise ValueError(f"tag_mode 只能是 {TAG_MODES}")
    builder = LogicBuilder(ds, sorted(cids), include_extra)
    shown = shown_tags_by_work(builder) if tag_mode == "map" else None
    always = TAG_GROUPS["G_format"] | TAG_GROUPS["G_source"]
    works = []
    for c in builder.chars:
        w = c["earliest_work"]
        sid = w["id"]
        tags = set(map(str, c["tags"]))
        if shown is not None and sid in shown:
            visible = shown[sid]
            tags = {t for t in tags if t in always or visible(t)}
        elif shown is not None:
            # 分岔结果里没有这部作品（canvas_logic 没把它放进任何分支）。如果当成「什么都看不到」，
            # 题材标签会被删光，六种视图都把它分到「非恋爱」之类的错误分支；所以保留全部标签。
            print(f"[tagnote] 作品 {sid} {w['name']} 不在导图分岔里，改用全部标签", flush=True)
        works.append({
            "id": str(sid),
            "title": w["name"],
            "years": year_str(c),
            "score": score_of(c),
            "subject_id": sid,
            "cover": COVER_URL.format(sid=sid),
            "link": f"{sid} - {w['name']}",
            "char_id": c["id"],
            "tags": sorted(tags),
        })
    year0 = {c["earliest_work"]["id"]: (c["year_span_char"][0] or c["earliest_work"].get("year") or 9999) for c in builder.chars}
    works.sort(key=lambda x: (year0[x["subject_id"]], -(x["score"] or 0), x["subject_id"]))
    return works


def common_tags(works: List[Dict[str, Any]]) -> List[str]:
    if len(works) < 2:
        return []
    return sorted(set.intersection(*(set(w["tags"]) for w in works)))


def make_collection(works: List[Dict[str, Any]], title: str, source: str, *, origin: Optional[str] = None,
                    group: Optional[str] = None, **extra: Any) -> Dict[str, Any]:
    """完整的作品集 JSON（不含 layout_cache：领地图布局由引擎第一次打开时算，或用 tagnote/tools/precompute_layout.js 预先写入）。"""
    collection = {
        "title": title,
        "common_tags": common_tags(works),
        "source": source,
        "origin": origin,
        "group": group,
        "generated_at": datetime.date.today().isoformat(),
    }
    collection.update({k: v for k, v in extra.items() if v is not None})
    return {"schema": SCHEMA, "collection": collection, "tag_groups": TAG_GROUPS_ORDERED, "works": works}


def tagnote_from_eval(ev, title: str, *, include_extra: bool = False, tag_mode: str = "map", **extra: Any) -> Dict[str, Any]:
    """已求值的候选池 → 作品集 JSON。调用方先检查 ev.errors 和作品数（MAX_WORKS）。"""
    ds = make_canvas_store(ev)
    works = works_from_store(ds, ev.pool, include_extra, tag_mode)
    return make_collection(works, title, "outsetter", tags_from=tag_mode, **extra)
