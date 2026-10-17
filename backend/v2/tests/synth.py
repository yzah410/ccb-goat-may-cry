# -*- coding: utf-8 -*-
"""手工造的小型合成库（出题器数据库的表结构），每个数字都能手算，给单元测试用。

条目（today = 2026-06-15）：
  101 动画 2024 热度 1000  标签 百合100 日常50 校园5（校园不到 10%）       主角 c1 c2 c13-c17（7 个主角），配角 c3，客串 c12
  102 动画 2024 热度  900  标签 战斗80 百合20                              主角 c4(ord0) c5(ord1)
  103 动画 2023 热度  800  标签 日常30                                     主角 c5，配角 c8
  104 动画 2024 热度  900（和 102 同分，id 大排后面）标签 恋爱10              主角 c6
  105 动画 没日期  热度 5000                                              主角 c7
  106 动画 2025 热度  700  NSFW                                           主角 c8
  107 动画 2026-12-01（未上映）热度 3000                                   主角 c9
  108 动画 2024 热度   10  没有角色（也占名次）
  201 游戏 2024 热度  600  公共标签 Galgame；用户标签 Galgame3 恋爱30          主角 c10
  202 游戏 2022 热度 1500                                                 主角 c11
  301 书籍 2020 热度  100                                                 主角 c12
"""
from __future__ import annotations

import os
import sqlite3

SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE subject(id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT, name_cn TEXT, display_name TEXT,
  date TEXT, year INTEGER, platform INTEGER, nsfw INTEGER NOT NULL, locked INTEGER, heat INTEGER NOT NULL,
  heat_source TEXT, rating_score REAL, rating_total INTEGER, rank INTEGER, image TEXT, tags_source TEXT);
CREATE TABLE subject_tag(subject_id INTEGER, rank INTEGER, name TEXT, count INTEGER, PRIMARY KEY(subject_id, rank));
CREATE TABLE subject_meta_tag(subject_id INTEGER, rank INTEGER, tag TEXT, PRIMARY KEY(subject_id, rank));
CREATE TABLE character(id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, display_name TEXT, gender TEXT,
  heat INTEGER NOT NULL, comments INTEGER, role INTEGER);
CREATE TABLE appearance(character_id INTEGER, subject_id INTEGER, relation TEXT, ord INTEGER, PRIMARY KEY(character_id, subject_id));
CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, display_name TEXT);
CREATE TABLE voice(character_id INTEGER, person_id INTEGER, subject_id INTEGER);
CREATE TABLE char_tag(character_id INTEGER, tag TEXT);
CREATE TABLE char_ext_tag(character_id INTEGER, category TEXT, value TEXT);
CREATE TABLE profile(mode TEXT, character_id INTEGER, fallback INTEGER, n_app INTEGER, earliest INTEGER, latest INTEGER,
  rating REAL, cut INTEGER, source_tag TEXT, PRIMARY KEY(mode, character_id));
CREATE TABLE profile_tag(mode TEXT, character_id INTEGER, rank INTEGER, tag TEXT, score INTEGER, PRIMARY KEY(mode, character_id, rank));
CREATE TABLE profile_app(mode TEXT, character_id INTEGER, ord INTEGER, subject_id INTEGER, extra INTEGER, PRIMARY KEY(mode, character_id, ord));
CREATE TABLE character_va(character_id INTEGER, ord INTEGER, name TEXT, PRIMARY KEY(character_id, ord));
CREATE VIEW game_tag_n6 AS SELECT t.character_id, t.tag, t.rank FROM profile_tag t JOIN profile p USING(mode, character_id)
  WHERE t.mode='anime' AND t.rank < max(p.cut, 6);
CREATE VIEW game_tag_n4 AS SELECT t.character_id, t.tag, t.rank FROM profile_tag t JOIN profile p USING(mode, character_id)
  WHERE t.mode='anime' AND t.rank < max(p.cut, 4);
"""

# (id, type, name, date, nsfw, heat, tags[(name,count)], meta_tags)
SUBJECTS = [
    (101, 2, "百合日常番", "2024-04-01", 0, 1000, [("百合", 100), ("日常", 50), ("校园", 5)], []),
    (102, 2, "战斗番", "2024-07-01", 0, 900, [("战斗", 80), ("百合", 20)], []),
    (103, 2, "日常番2023", "2023-01-01", 0, 800, [("日常", 30)], []),
    (104, 2, "恋爱番", "2024-10-01", 0, 900, [("恋爱", 10)], []),
    (105, 2, "没日期的番", None, 0, 5000, [], []),
    (106, 2, "NSFW 番", "2025-01-01", 1, 700, [("百合", 9)], []),
    (107, 2, "还没播的番", "2026-12-01", 0, 3000, [], []),
    (108, 2, "没角色的番", "2024-02-01", 0, 10, [], []),
    (201, 4, "某 Galgame", "2024-03-01", 0, 600, [("Galgame", 3), ("恋爱", 30)], ["Galgame", "PC"]),
    (202, 4, "某 RPG", "2022-03-01", 0, 1500, [("RPG", 50)], ["RPG"]),
    (301, 1, "某小说", "2020-03-01", 0, 100, [], []),
]

# (id, name, gender, heat)
CHARS = [
    (1, "角色一", "女", 500), (2, "角色二", "女", 300), (3, "角色三", "男", 100), (4, "角色四", None, 50),
    (5, "角色五", "女", 800), (6, "角色六", "男", 20), (7, "角色七", "女", 5), (8, "角色八", "女", 1),
    (9, "角色九", "男", 900), (10, "角色十", "女", 400), (11, "角色十一", "男", 60), (12, "角色十二", "女", 70),
    (13, "角色十三", "女", 10), (14, "角色十四", "女", 9), (15, "角色十五", "女", 8), (16, "角色十六", "女", 7),
    (17, "角色十七", "女", 6),
]

# (cid, sid, relation, ord)
APPS = [
    (1, 101, "主角", 1), (2, 101, "主角", 0), (3, 101, "配角", 2), (12, 101, "客串", 9),
    (13, 101, "主角", 3), (14, 101, "主角", 4), (15, 101, "主角", 5), (16, 101, "主角", 6), (17, 101, "主角", 7),
    (4, 102, "主角", 0), (5, 102, "主角", 1),
    (5, 103, "主角", 0), (8, 103, "配角", 1),
    (6, 104, "主角", 0),
    (7, 105, "主角", 0),
    (8, 106, "主角", 0),
    (9, 107, "主角", 0),
    (10, 201, "主角", 0),
    (11, 202, "主角", 0),
    (12, 301, "主角", 0),
]

# 动画模式画像：cid -> (fallback, n_app, earliest, latest, rating, cut, source, [tags])
PROFILE_ANIME = {
    1: (0, 1, 2024, 2024, 8.0, -1, "漫画改", ["百合", "日常", "校园", "漫画改", "TV", "搞笑", "音乐"]),
    2: (0, 1, 2024, 2024, 8.0, 2, "漫画改", ["百合", "日常", "校园", "漫画改"]),
    3: (0, 1, 2024, 2024, 8.0, -1, "原创", ["日常", "校园", "百合"]),
    4: (0, 1, 2024, 2024, 7.0, -1, "原创", ["战斗", "百合"]),
    5: (0, 2, 2023, 2024, 7.5, -1, "原创", ["战斗", "日常", "百合"]),
    6: (0, 1, 2024, 2024, 6.5, -1, "小说改", ["恋爱"]),
    # 7：没有画像行
    8: (0, 1, 2023, 2023, 6.0, -1, None, ["日常"]),
    9: (0, 0, -1, -1, -1, -1, None, []),              # 只在未上映作品里登场：n_app = 0
    10: (1, 1, 2024, 2024, 7.2, -1, "游戏改", ["Galgame", "恋爱"]),
    11: (1, 1, 2022, 2022, 6.8, -1, "游戏改", ["RPG"]),
    12: (0, 1, 2020, 2020, 5.0, -1, "小说改", ["奇幻"]),
    13: (0, 1, 2024, 2024, 8.0, -1, "漫画改", ["百合"]),
    14: (0, 1, 2024, 2024, 8.0, -1, "漫画改", ["百合"]),
    15: (0, 1, 2024, 2024, 8.0, -1, "漫画改", ["百合"]),
    16: (0, 1, 2024, 2024, 8.0, -1, "漫画改", ["百合"]),
    17: (0, 1, 2024, 2024, 8.0, -1, "漫画改", ["百合"]),
}
PROFILE_APPS = {1: [101], 2: [101], 3: [101], 4: [102], 5: [102, 103], 6: [104], 8: [103], 10: [201], 11: [202],
                12: [301], 13: [101], 14: [101], 15: [101], 16: [101], 17: [101]}
# 吐槽数（character.comments）：游戏里的人气 = heat + comments。只给几个角色加，其余为 0
COMMENTS = {1: 50, 2: 20, 4: 10, 5: 100, 9: 7}
# 追加的「特殊游戏」（profile_app.extra = 1，只用于共同出演，不算登场数）：(cid, ord, sid)
PROFILE_APPS_EXTRA = [(1, 1, 202), (5, 2, 202), (4, 1, 201), (6, 1, 201)]
CHAR_TAGS = {1: ["黑长直"], 2: ["双马尾"], 5: ["黑长直", "双马尾"]}
VAS = {1: ["声优A"], 2: ["声优B"], 5: ["声优A", "声优C"]}
# 角色的原名 / 中文名（character.name / name_cn）：默认都等于 display_name；这两个角色不一样，给「名字两行」的测试用。
# display_name 不变，所以按显示名搜索、猜测行的 name 都不受影响。c8 没有中文名。
CHAR_NAMES = {7: ("セブン", "七号角色"), 8: ("エイト", None)}


# ---- 可见性变体（subject 的 search_visible / anon_detail 两列）----
# 109：2024 动画、热度 950、locked（nsfw=0 但 search_visible=0、anon_detail=1）——游戏不排名、也不算登场
# 110：2024 动画、热度 960、匿名 404（nsfw=0 但 search_visible=0、anon_detail=0）
# c11 在 109 当主角、c12 和 c18 在 110 当主角；c18 只在 110 登场（= 没有游戏算的登场作品）
EXTRA_SUBJECTS = [
    # (id, type, name, date, nsfw, heat, tags, meta_tags, locked, search_visible, anon_detail)
    (109, 2, "被锁定的番", "2024-05-01", 0, 950, [("战斗", 50)], ["测试公共"], 1, 0, 1),
    (110, 2, "匿名404的番", "2024-06-01", 0, 960, [("百合", 40)], [], None, 0, 0),
]
EXTRA_CHARS = [(18, "角色十八", "女", 3)]
EXTRA_APPS = [(11, 109, "主角", 0), (4, 109, "主角", 1), (12, 110, "主角", 0), (18, 110, "主角", 1)]


def build(path: str, today: str = "2026-06-15", variant: str = None) -> str:
    """variant：None = 原样（没有可见性两列，走退回 nsfw = 0 的逻辑）；
    'visibility' = 加 search_visible / anon_detail 两列 + 109 / 110 两部隐藏条目；
    'visibility_nocols' = 同样多出 109 / 110，但没有这两列（测库里缺这两列时的退回规则）。"""
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    db.executemany("INSERT INTO meta VALUES(?,?)", [("schema_version", "2"), ("dump_name", "synthetic"),
                                                    ("built_at", "2026-06-15T00:00:00"), ("today", today),
                                                    ("tags_api_subjects", "4"), ("tags_dump_subjects", "0")])
    for sid, typ, name, date, nsfw, heat, tags, metas in SUBJECTS:
        year = int(date[:4]) if date else None
        db.execute("INSERT INTO subject VALUES(?,?,?,?,?,?,?,NULL,?,NULL,?,'dump',7.0,100,NULL,NULL,?)",
                   (sid, typ, name, name, name, date, year, nsfw, heat, "api" if tags else None))
        for i, (t, c) in enumerate(tags):
            db.execute("INSERT INTO subject_tag VALUES(?,?,?,?)", (sid, i, t, c))
        for i, t in enumerate(metas):
            db.execute("INSERT INTO subject_meta_tag VALUES(?,?,?)", (sid, i, t))
    for cid, name, g, heat in CHARS:
        orig, cn = CHAR_NAMES.get(cid, (name, name))
        db.execute("INSERT INTO character VALUES(?,?,?,?,?,?,?,1)", (cid, orig, cn, name, g, heat, COMMENTS.get(cid, 0)))
    db.executemany("INSERT INTO appearance VALUES(?,?,?,?)", APPS)
    for cid, (fb, napp, e, l, r, cut, src, tags) in PROFILE_ANIME.items():
        db.execute("INSERT INTO profile VALUES('anime',?,?,?,?,?,?,?,?)", (cid, fb, napp, e, l, r, cut, src))
        for i, t in enumerate(tags):
            db.execute("INSERT INTO profile_tag VALUES('anime',?,?,?,?)", (cid, i, t, 100 - i))
    for cid, sids in PROFILE_APPS.items():
        for i, s in enumerate(sids):
            db.execute("INSERT INTO profile_app VALUES('anime',?,?,?,0)", (cid, i, s))
    for cid, o, s in PROFILE_APPS_EXTRA:
        db.execute("INSERT INTO profile_app VALUES('anime',?,?,?,1)", (cid, o, s))
    for cid, tags in CHAR_TAGS.items():
        for t in tags:
            db.execute("INSERT INTO char_tag VALUES(?,?)", (cid, t))
    for cid, names in VAS.items():
        for i, n in enumerate(names):
            db.execute("INSERT INTO character_va VALUES(?,?,?)", (cid, i, n))
    if variant in ("visibility", "visibility_nocols"):
        with_cols = variant == "visibility"
        if with_cols:
            db.execute("ALTER TABLE subject ADD COLUMN search_visible INTEGER NOT NULL DEFAULT 1")
            db.execute("ALTER TABLE subject ADD COLUMN anon_detail INTEGER NOT NULL DEFAULT 1")
            db.execute("UPDATE subject SET search_visible = 0, anon_detail = 0 WHERE nsfw = 1")
        for sid, typ, name, date, nsfw, heat, tags, metas, locked, sv, ad in EXTRA_SUBJECTS:
            year = int(date[:4]) if date else None
            db.execute("INSERT INTO subject(id, type, name, name_cn, display_name, date, year, nsfw, locked, heat, "
                       "heat_source, rating_score, rating_total, tags_source) VALUES(?,?,?,?,?,?,?,?,?,?,'api',7.0,100,?)",
                       (sid, typ, name, name, name, date, year, nsfw, locked, heat, "api" if tags else None))
            if with_cols:
                db.execute("UPDATE subject SET search_visible = ?, anon_detail = ? WHERE id = ?", (sv, ad, sid))
            for i, (t, c) in enumerate(tags):
                db.execute("INSERT INTO subject_tag VALUES(?,?,?,?)", (sid, i, t, c))
            for i, t in enumerate(metas):
                db.execute("INSERT INTO subject_meta_tag VALUES(?,?,?)", (sid, i, t))
        for cid, name, g, heat in EXTRA_CHARS:
            db.execute("INSERT INTO character VALUES(?,?,?,?,?,?,0,1)", (cid, name, name, name, g, heat))
        db.executemany("INSERT INTO appearance VALUES(?,?,?,?)", EXTRA_APPS)
    db.commit()
    db.close()
    return path
