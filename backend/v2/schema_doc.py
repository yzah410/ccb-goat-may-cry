# -*- coding: utf-8 -*-
"""「问数据」页和 AI 提示词共用的表结构说明（每列一句中文）。

说明文字手写；表 / 列清单以实际库为准：库里多出来的表或列也会列出来（说明写「（没有说明）」）。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

TABLE_DOC: Dict[str, Dict[str, Any]] = {
    "meta": {"note": "库的元数据（键值对）", "cols": {
        "key": "键：schema_version / dump_name / built_at / today / tags_api_subjects …",
        "value": "值（文字；counts / modes 等是 JSON 文本）"}},
    "subject": {"note": "条目（作品）。收录：所有有角色关系的条目（含 NSFW）+ 书籍/动画/游戏/三次元里所有非 NSFW 条目", "cols": {
        "id": "Bangumi 条目 id",
        "type": "条目类型：1 书籍、2 动画、3 音乐、4 游戏、6 三次元",
        "name": "原名", "name_cn": "中文名（可能为空）", "display_name": "显示名（中文名优先）",
        "date": "上映 / 发售日期 'YYYY-MM-DD'，可能为 NULL",
        "year": "年份（从 date 取），NULL = 没有规范日期",
        "platform": "平台（dump 原值，数字）",
        "nsfw": "是否 NSFW（0/1）。统计「作品」时一般要加 nsfw = 0",
        "locked": "是否被锁定（0/1；只有接口取到的才可靠，否则 NULL）",
        "heat": "热度 = 收藏总数（想看+看过+在看+搁置+抛弃）。「热度前 N 部」按它降序排",
        "heat_source": "heat 的来源：'api' / 'dump'",
        "rating_score": "Bangumi 评分", "rating_total": "评分人数", "rank": "Bangumi 排名",
        "image": "封面图地址（可能为 NULL）",
        "tags_source": "这部作品的标签来源：'api' = 完整（最多 30 个）；'dump' = 只有前 11 个；NULL = 没有标签",
        "search_visible": "1 = 匿名搜索能搜到（非 NSFW、不是 locked、没有 404）。统计「作品」、热度排名都按它（search_visible = 1）",
        "anon_detail": "1 = 匿名能拿到详情，游戏能把这部算进角色登场（locked 的除外）",
        "in_dump": "0 = dump 里没有这部（之后新建的，或 dump 不导出的 locked 条目）",
        "api_404": "1 = 逐部请求接口时返回过 404",
        "has_main_chars": "1 = 有角色在这部里当主角或配角",
        "api_fetched_at": "接口取数的时间"}},
    "subject_tag": {"note": "作品本身的标签（用户打的标签和标注人数）", "cols": {
        "subject_id": "条目 id（对 subject.id）",
        "rank": "在这部作品里的顺序，0 开始（接口原顺序，基本按标注数降序）",
        "name": "标签名", "count": "标注人数。「主要标签」口径 = count ≥ 这部作品最高标注数的 10%"}},
    "character": {"note": "角色。收录：在任意非 NSFW 条目里当过主角或配角的角色", "cols": {
        "id": "Bangumi 角色 id", "name": "原名", "name_cn": "简体中文名（可能为空）",
        "display_name": "显示名（中文名优先）", "gender": "性别：'男' / '女' / NULL（未知）",
        "heat": "角色热度（收藏数）", "comments": "评论数", "role": "角色类型：1 角色 / 2 机体 / 3 舰船 / 4 组织"}},
    "appearance": {"note": "角色在条目里的身份（含 NSFW 条目）", "cols": {
        "character_id": "角色 id", "subject_id": "条目 id",
        "relation": "身份：'主角' / '配角' / '客串'", "ord": "dump 里的顺序（注意：游戏截取每部前 N 个角色时用的是角色 id 从小到大，不是这个）"}},
    "person": {"note": "人物（声优等）", "cols": {
        "id": "人物 id", "name": "原名", "name_cn": "中文名", "display_name": "显示名"}},
    "voice": {"note": "声优关系（dump 原样，含 NSFW 条目）", "cols": {
        "character_id": "角色 id", "person_id": "人物 id", "subject_id": "在哪个条目里配音"}},
    "char_tag": {"note": "角色标签（外观 / 属性，来自猜猜呗的 id_tags）", "cols": {
        "character_id": "角色 id", "tag": "标签，如 黑长直、双马尾"}},
    "char_ext_tag": {"note": "22 个特殊游戏的外部标签（可能是空表）", "cols": {
        "character_id": "角色 id", "category": "类别，如 乐队", "value": "值，如 Poppin'Party"}},
    "profile": {"note": "每种模式下，角色在游戏格子里的数据（游戏算法算出）", "cols": {
        "mode": "模式：'anime' 动画 / 'game' 游戏 / 'book' 书籍 / 'real' 三次元 / 'all' 全部",
        "character_id": "角色 id",
        "fallback": "1 = 这个模式下没有主角/配角登场，按所有类型退回计算",
        "n_app": "登场数（游戏格子里的数字）；0 = 没有画像",
        "earliest": "最早登场年；-1 = 没有", "latest": "最晚登场年；-1 = 没有",
        "rating": "登场作品里的最高评分；-1 = 没有",
        "cut": "作品标签截断位置；标签数为 n 时显示 rank < max(cut, n) 的标签；-1 = 全部达标",
        "source_tag": "来源：原创 / 漫画改 / 小说改 / 游戏改（可能为 NULL）"}},
    "profile_tag": {"note": "角色的作品标签按得分排名（游戏格子里「作品标签」那组的来源）", "cols": {
        "mode": "模式", "character_id": "角色 id", "rank": "排名，0 开始",
        "tag": "标签名", "score": "得分（登场作品标签加权：主角 ×3、配角 ×1）"}},
    "profile_app": {"note": "游戏格子里的登场作品顺序（按评分人数降序）", "cols": {
        "mode": "模式", "character_id": "角色 id", "ord": "顺序", "subject_id": "条目 id"}},
    "character_va": {"note": "角色的声优名单（游戏口径，和模式无关）", "cols": {
        "character_id": "角色 id", "ord": "顺序", "name": "声优名"}},
    "game_tag_n6": {"note": "视图：标签数 = 6、动画模式时，每个角色在游戏格子里显示的作品标签", "cols": {
        "character_id": "角色 id", "tag": "标签名", "rank": "排名"}},
    "game_tag_n4": {"note": "视图：标签数 = 4、动画模式时，每个角色在游戏格子里显示的作品标签", "cols": {
        "character_id": "角色 id", "tag": "标签名", "rank": "排名"}},
    "user_list": {"note": "你建的清单（只读临时表，每次查询时从清单目录装进来）", "cols": {
        "id": "清单 id", "name": "清单名", "kind": "种类：'character' / 'work' / 'tag'"}},
    "user_list_item": {"note": "清单里的每一项", "cols": {
        "list_id": "清单 id（对 user_list.id）", "item_id": "角色或条目 id（标签清单为 NULL）",
        "name": "名字（标签清单就是标签名）"}},
}

NOTES = [
    "只能执行一条只读查询（SELECT / WITH）；5 秒超时；最多返回 2,000 行。",
    "「角色在游戏里显示的作品标签」：动画模式 n=6 用 game_tag_n6，n=4 用 game_tag_n4；其他模式 / n 写 "
    "`JOIN profile p USING(mode, character_id) WHERE t.mode = '模式' AND t.rank < max(p.cut, n)`。",
    "「作品本身的标签」在 subject_tag；「主要标签」口径：count ≥ 该作品最高 count 的 10%。",
    "统计作品时一般要加 subject.nsfw = 0；统计「动画」加 subject.type = 2。",
    "subject 里有很多没有角色的条目（为了热度排名和游戏一致）；只关心有角色的作品时 JOIN appearance。",
    "库里只收录了当过主角或配角的角色；只客串过的角色不在 character 表里。",
    "user_list / user_list_item 是你建的清单：例 `SELECT name FROM user_list_item WHERE list_id = 'l_example'`。",
]

EXAMPLES = [
    {"q": "「百合」标签（主要标签口径）在多少部动画里出现？",
     "sql": "SELECT COUNT(*) AS 动画数 FROM subject s JOIN subject_tag t ON t.subject_id = s.id\n"
            "WHERE s.type = 2 AND s.nsfw = 0 AND t.name = '百合'\n"
            "  AND t.count * 10 >= (SELECT MAX(count) FROM subject_tag x WHERE x.subject_id = s.id)"},
    {"q": "2024 年、作品标签（n=6）同时含百合和日常、在 2024 年的动画里当过主角的角色",
     "sql": "SELECT c.id AS character_id, c.display_name AS 角色, c.heat AS 热度 FROM character c\n"
            "WHERE c.id IN (SELECT a.character_id FROM appearance a JOIN subject s ON s.id = a.subject_id\n"
            "               WHERE s.type = 2 AND s.nsfw = 0 AND s.year = 2024 AND a.relation = '主角')\n"
            "  AND c.id IN (SELECT character_id FROM game_tag_n6 WHERE tag = '百合')\n"
            "  AND c.id IN (SELECT character_id FROM game_tag_n6 WHERE tag = '日常')\n"
            "ORDER BY c.heat DESC"},
    {"q": "作品标签（n=6）里至少含 4 个指定清单标签的角色（把 SQL 里的 l_example 换成你的清单 id）",
     "sql": "SELECT g.character_id, c.display_name AS 角色, COUNT(*) AS 命中数, c.heat AS 热度\n"
            "FROM game_tag_n6 g JOIN character c ON c.id = g.character_id\n"
            "WHERE g.tag IN (SELECT name FROM user_list_item WHERE list_id = 'l_example')\n"
            "GROUP BY g.character_id HAVING COUNT(*) >= 4 ORDER BY c.heat DESC"},
    {"q": "游戏模式、标签数 5 时，作品标签含「Galgame」的角色数",
     "sql": "SELECT COUNT(DISTINCT t.character_id) FROM profile_tag t JOIN profile p USING(mode, character_id)\n"
            "WHERE t.mode = 'game' AND t.rank < max(p.cut, 5) AND t.tag = 'Galgame'"},
]


def _with_visibility(text: str, has_sv: bool) -> str:
    """说明和例子里「只算非 NSFW 作品」的写法：库里有 search_visible 列就用 search_visible = 1（和游戏的热度排名同一口径），没有就用 nsfw = 0。"""
    if not has_sv:
        return text
    return (text.replace("subject.nsfw = 0", "subject.search_visible = 1")
                .replace("s.nsfw = 0", "s.search_visible = 1"))


def build_schema(conn=None) -> Dict[str, Any]:
    """conn 给了就按实际库补全表 / 列；否则只给手写的说明。"""
    tables: List[Dict[str, Any]] = []
    actual: Dict[str, Dict[str, Any]] = {}
    has_sv = False
    if conn is not None:
        for name, typ in conn.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
                                      "AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            cols = [(r[1], r[2]) for r in conn.execute(f"PRAGMA table_info('{name}')")]
            actual[name] = {"kind": typ, "cols": cols}
        has_sv = "search_visible" in {c for c, _ in (actual.get("subject") or {}).get("cols", [])}
    order = list(TABLE_DOC.keys())
    names = order + sorted(k for k in actual if k not in TABLE_DOC)
    for name in names:
        doc = TABLE_DOC.get(name, {"note": "（没有说明）", "cols": {}})
        if name in ("user_list", "user_list_item"):
            kind = "temp"
            cols = [(c, "") for c in doc["cols"]]
        elif name in actual:
            kind = actual[name]["kind"]
            cols = actual[name]["cols"]
        elif conn is None:
            kind = "view" if name.startswith("game_tag_") else "table"
            cols = [(c, "") for c in doc["cols"]]
        else:
            continue  # 手写说明里有、实际库里没有的表：不列
        tables.append({
            "name": name, "kind": kind, "note": doc["note"],
            "columns": [{"name": c, "type": t or "", "note": doc["cols"].get(c, "（没有说明）")} for c, t in cols],
        })
    notes = [_with_visibility(n, has_sv) for n in NOTES]
    examples = [{"q": e["q"], "sql": _with_visibility(e["sql"], has_sv)} for e in EXAMPLES]
    if has_sv:
        for t in tables:
            if t["name"] == "subject":
                for c in t["columns"]:
                    if c["name"] == "nsfw":
                        c["note"] = "是否 NSFW（0/1）。统计「作品」请用 search_visible = 1（它还排除了 locked 和 404 的条目）"
    return {"tables": tables, "notes": notes, "examples": examples}


def schema_text(schema: Dict[str, Any]) -> str:
    """给 AI 提示词用的紧凑文字版。"""
    lines = []
    for t in schema["tables"]:
        k = {"view": "视图", "temp": "临时只读表"}.get(t["kind"], "表")
        lines.append(f"{k} {t['name']}：{t['note']}")
        for c in t["columns"]:
            lines.append(f"  - {c['name']} {c['type']}：{c['note']}")
    lines.append("注意：")
    lines.extend("  - " + n for n in schema["notes"])
    return "\n".join(lines)
