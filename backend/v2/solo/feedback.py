# -*- coding: utf-8 -*-
"""单人版「猜猜呗」的反馈：逐字移植上游 kennylimz/anime-character-guessr 的 `generateFeedback`
（client/src/utils/bangumi.js 第 622-777 行，main 9443b4c）。本文件沿用上游的 CC BY-NC 4.0 许可，不适用仓库的 MIT，见 NOTICE.md。

输入一个「猜的角色」和一个「答案角色」，返回两人在 性别 / 人气 / 评分 / 共同出演 / 登场作品数 / 作品标签·角色标签·声优 /
最晚·最早登场年份 上的对比。字段名和取值照上游返回对象（yes/no、=/+/-/++/--/?），另外附一块 `display`：
猜的角色自己的显示值，前端照着就能画猜猜呗游戏里的那张反馈表。

数据来自内存快照（backend/v2/store.py），只有三样要另外读：
  1. 人气 = 收藏数 + 吐槽数（上游 getCharacterDetails，bangumi.js 第 381 行）。快照里只有收藏数（heat），
     吐槽数（character.comments）按需读一次、只存非零的人。
  2. 共同出演的作品 id 含「22 个特殊游戏」（profile_app.extra = 1，bangumi.js 第 287-296 行）；ModeProfile.apps 把它们滤掉了，
     所以另读一次 extra=1 的行（每个模式几百行）。登场作品数仍然不含它们。
  3. 作品原名 / 中文名（共同出演的第一部作品名按「名字」比，bangumi.js 第 664-675 行），按需查 subject 表并缓存。
     共同出演的第一部若是特殊游戏，上游取不到名字（猜猜呗游戏里这一格显示成空的绿块）：`shared_appearances` 照上游留 None，
     只有 `display.shared_work` 补上游戏的名字（中文名优先，没有就原名）。

「无」的写法：内存里评分 / 年份没有就是 None（库里是 -1）。本模块对外也用 None（上游是 -1 或 '?'），反馈符号照上游。
猜对（猜的 id == 答案 id）时上游没有特殊标记，各项自然全是 yes / =；这里多给一个 `correct` 布尔值。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ..store import (C_GENDER, C_HEAT, C_NAME, MODE_IDS, P_CUT, P_EARLIEST, P_LATEST, P_NAPP, P_RATING, ModeProfile,
                     Snapshot)

GENDER_JS = {"男": "male", "女": "female", None: "?"}      # 上游：只认 male / female，其余都是 '?'
GENDER_SYMBOL = {"男": "♂", "女": "♀", None: "?"}
TAG_NUM_MAX = 10


class SoloError(Exception):
    """可预期的错误（角色不存在、参数不对），路由层翻成 JSON。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# ---------------------------------------------------------------- 按需读的三样数据
def comments_map(snap: Snapshot) -> Dict[int, int]:
    """character.comments（吐槽数）。只存非零的人（约 4.4 万人），随快照一起被换掉。"""
    def load() -> Dict[int, int]:
        out: Dict[int, int] = {}
        conn = snap.connect()
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(character)")}
            if "comments" in cols:
                for cid, cm in conn.execute("SELECT id, comments FROM character WHERE comments IS NOT NULL AND comments <> 0"):
                    out[int(cid)] = int(cm)
        finally:
            conn.close()
        return out
    return snap.lazy("solo:comments", load)


def extra_apps(snap: Snapshot, mode: str) -> Dict[int, Tuple[int, ...]]:
    """profile_app.extra = 1 的作品 id（22 个特殊游戏），角色 id -> 按 ord 排好的元组。库里没有 extra 列时为空。"""
    def load() -> Dict[int, Tuple[int, ...]]:
        acc: Dict[int, List[int]] = {}
        if "profile_app" in snap.tables:
            conn = snap.connect()
            try:
                cols = {r[1] for r in conn.execute("PRAGMA table_info(profile_app)")}
                if "extra" in cols:
                    for cid, sid in conn.execute(
                            "SELECT character_id, subject_id FROM profile_app WHERE mode=? AND extra = 1 "
                            "ORDER BY character_id, ord", (mode,)):
                        acc.setdefault(int(cid), []).append(int(sid))
            finally:
                conn.close()
        return {k: tuple(v) for k, v in acc.items()}
    return snap.lazy("solo:extra:" + mode, load)


_NAME_CACHE_MAX = 400_000


def subject_names(snap: Snapshot, sids: Sequence[int]) -> Dict[int, Tuple[str, str]]:
    """作品 id -> (原名 name, 中文名 name_cn or name)，对应上游的 appearances / appearancesCn。缓存在快照上。"""
    cache: Dict[int, Tuple[str, str]] = snap.lazy("solo:subnames", dict)
    missing = sorted({int(s) for s in sids if int(s) not in cache})
    if missing:
        if len(cache) > _NAME_CACHE_MAX:
            cache.clear()
        conn = snap.connect()
        try:
            for i in range(0, len(missing), 500):
                chunk = missing[i:i + 500]
                q = "SELECT id, name, name_cn FROM subject WHERE id IN (%s)" % ",".join("?" * len(chunk))
                for sid, name, name_cn in conn.execute(q, chunk):
                    cache[int(sid)] = (name, name_cn or name)         # 上游：nameCn = name_cn || name
        finally:
            conn.close()
        for s in missing:
            cache.setdefault(s, (str(s), str(s)))                    # 库里没有这部作品（不该发生）：用 id 当名字
    return {int(s): cache[int(s)] for s in sids}


def char_names(snap: Snapshot, cids: Sequence[int]) -> Dict[int, Tuple[str, Optional[str]]]:
    """角色 id -> (原名 character.name, 中文名 character.name_cn 或 None)。给对局的猜测行 / 结算块画「名字两行」用
    （上行日文原名，下行中文名，和猜猜呗游戏的名字格一样）。按需查 character 表，缓存在快照上。库里没有的 id 不在结果里。"""
    cache: Dict[int, Tuple[str, Optional[str]]] = snap.lazy("solo:charnames", dict)
    missing = sorted({int(c) for c in cids if int(c) not in cache})
    if missing:
        if len(cache) > _NAME_CACHE_MAX:
            cache.clear()
        conn = snap.connect()
        try:
            for i in range(0, len(missing), 500):
                chunk = missing[i:i + 500]
                q = "SELECT id, name, name_cn, display_name FROM character WHERE id IN (%s)" % ",".join("?" * len(chunk))
                for cid, name, name_cn, display in conn.execute(q, chunk):
                    cache[int(cid)] = (name or display or str(cid), name_cn or None)
        finally:
            conn.close()
    return {int(c): cache[int(c)] for c in cids if int(c) in cache}


# ---------------------------------------------------------------- 一个角色在游戏里的数据
@dataclass(frozen=True)
class CharView:
    """一个角色在 (模式, 作品标签数 n) 下，游戏拿到的数据（对应上游 designateCharacter 的返回）。"""
    id: int
    name: str
    gender: Optional[str]                  # '男' / '女' / None
    heat: int                              # 收藏数
    comments: int                          # 吐槽数
    n_app: int                             # 登场作品数（不含特殊游戏）
    earliest: Optional[int]
    latest: Optional[int]
    rating: Optional[float]
    tags: Tuple[str, ...]                  # 作品标签：前 max(cut, n) 个（cut = -1 时前 n 个）= 上游 rawTags 的键
    regular_apps: Tuple[int, ...]          # 登场作品 id（按评分人数降序，= 上游 appearances 对应的 id）
    extra_apps: Tuple[int, ...]            # 追加的特殊游戏 id（只用于共同出演）
    char_tags: Tuple[str, ...]             # 角色标签，全部，原顺序（= 上游 idToTags[id]）
    vas: Tuple[str, ...]                   # 声优（= 上游 animeVAs）

    @property
    def popularity(self) -> int:
        return self.heat + self.comments

    @property
    def app_ids(self) -> Tuple[int, ...]:
        return self.regular_apps + self.extra_apps


def shown_tags(prof: Optional[tuple], tags: Sequence[str], n: int) -> Tuple[str, ...]:
    """游戏在作品标签数 n 时显示的标签：前 max(cut, n) 个；全部达标时 cut = -1，只看 n（bangumi.js 第 242 行）。"""
    if not prof or not (prof[P_NAPP] or 0):
        return ()
    cut = prof[P_CUT]
    k = n if (cut is None or cut < 0) else max(cut, n)
    return tuple(tags[:k])


def check_tag_num(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= TAG_NUM_MAX:
        raise SoloError(422, "bad_tag_num", f"{label}要是 0 到 {TAG_NUM_MAX} 的整数")
    return value


def check_mode(mode: Any) -> str:
    if mode not in MODE_IDS:
        raise SoloError(422, "bad_mode", f"模式只能是 {' / '.join(MODE_IDS)}")
    return mode


def char_view(snap: Snapshot, mp: ModeProfile, n: int, cid: int) -> CharView:
    c = snap.C.get(cid)
    if c is None:
        # 故意不带 id：cid 可能是这一局的答案，错误信息不能把它带出去
        raise SoloError(404, "not_found", "这个角色不在角色库里")
    p = mp.prof.get(cid)
    has = bool(p) and (p[P_NAPP] or 0) > 0
    return CharView(
        id=cid, name=c[C_NAME], gender=c[C_GENDER], heat=c[C_HEAT], comments=comments_map(snap).get(cid, 0),
        n_app=int(p[P_NAPP]) if has else 0,
        earliest=p[P_EARLIEST] if has else None, latest=p[P_LATEST] if has else None,
        rating=p[P_RATING] if has else None,
        tags=shown_tags(p, mp.tags.get(cid, ()), n),
        regular_apps=tuple(mp.apps.get(cid, ())),
        extra_apps=extra_apps(snap, mp.mode).get(cid, ()),
        char_tags=tuple(snap.char_tags()[0].get(cid, ())),
        vas=tuple(snap.vas()[0].get(cid, ())),
    )


# ---------------------------------------------------------------- 逐字移植 generateFeedback
def _count_feedback(diff: int, small: int) -> str:
    """登场作品数 / 年份共用：差 0 → =；差在 small 以内 → + / -；更大 → ++ / --。"""
    if diff == 0:
        return "="
    if diff > 0:
        return "+" if diff <= small else "++"
    return "-" if diff >= -small else "--"


def compute_feedback(g: CharView, a: CharView, subject_tag_num: int, character_tag_num: int,
                     g_names: Sequence[Tuple[str, str]], a_names: Sequence[Tuple[str, str]],
                     extra_names: Optional[Mapping[int, Tuple[str, str]]] = None) -> Dict[str, Any]:
    """g_names / a_names：各自登场作品（regular_apps，同顺序）的 (原名, 中文名)。返回上游 generateFeedback 同形的 dict
    （「无」用 None），再加一块 display。
    extra_names：猜的角色的特殊游戏 id -> (原名, 中文名)。只有「共同出演的第一部是特殊游戏」时才用得上，
    而且只补进 display.shared_work；shared_appearances 里的上游字段不动。"""
    out: Dict[str, Any] = {}
    gg, ag = GENDER_JS[g.gender], GENDER_JS[a.gender]
    out["gender"] = {"guess": gg, "feedback": "yes" if gg == ag else "no"}

    # 人气（bangumi.js 第 630-644 行）：差 ≤ 答案的 5% → =；≤ 20% → + / -；更大 → ++ / --
    pdiff = g.popularity - a.popularity
    five, twenty = a.popularity * 0.05, a.popularity * 0.2
    if abs(pdiff) <= five:
        pf = "="
    elif pdiff > 0:
        pf = "+" if pdiff <= twenty else "++"
    else:
        pf = "-" if pdiff >= -twenty else "--"
    out["popularity"] = {"guess": g.popularity, "feedback": pf}

    # 评分（第 647-661 行）：上游「无」是 -1；任一方无 → ?
    gr = -1 if g.rating is None else g.rating
    ar = -1 if a.rating is None else a.rating
    rdiff = gr - ar
    if gr == -1 or ar == -1:
        rf = "?"
    elif abs(rdiff) <= 0.3:
        rf = "="
    elif rdiff > 0:
        rf = "+" if rdiff <= 1 else "++"
    else:
        rf = "-" if rdiff >= -1 else "--"
    out["rating"] = {"guess": g.rating, "feedback": rf}

    # 共同出演（第 664-675 行）：作品名列表和作品 id 列表各比一次
    g_orig = [x[0] for x in g_names]
    a_orig = set(x[0] for x in a_names)
    shared_by_name = [nm for nm in g_orig if nm in a_orig]
    a_ids = set(a.app_ids)
    shared_idx = [i for i, sid in enumerate(g.app_ids) if sid in a_ids]
    first_original: Optional[str] = ""      # 没有共同作品：上游是 ''
    first_cn: Optional[str] = ""
    game_name: Optional[Tuple[str, str]] = None     # 第一个共同作品是特殊游戏时它的名字，只给 display 用
    if shared_idx:
        i0 = shared_idx[0]
        first_original = first_cn = None    # 第一个共同作品若是追加的特殊游戏，上游没有对应的名字（undefined）
        if i0 < len(g_names):
            first_original = g_names[i0][0]
            first_cn = g_names[i0][1] or g_names[i0][0]
        elif extra_names:
            game_name = extra_names.get(g.app_ids[i0])
    out["shared_appearances"] = {
        "first": shared_by_name[0] if shared_by_name else "",
        "firstOriginal": first_original,
        "firstCn": first_cn,
        "count": len(shared_idx) or len(shared_by_name),
    }

    # 登场作品数（第 677-689 行）。数的是名字列表，不含特殊游戏
    out["appearancesCount"] = {"guess": g.n_app, "feedback": _count_feedback(g.n_app - a.n_app, 2)}

    # 作品标签 / 角色标签 / 声优（commonTags 分支，第 690-716 行）
    n, ctn = subject_tag_num, character_tag_num
    a_tag_set = set(a.tags)
    shared_subject = [t for t in g.tags if t in a_tag_set][:n]
    subject_tags = list(shared_subject)
    for t in g.tags:
        if len(subject_tags) >= n:
            break
        if t not in a_tag_set:
            subject_tags.append(t)
    a_ctag_set = set(a.char_tags)
    shared_char = [t for t in g.char_tags if t in a_ctag_set][:ctn]
    char_tags = list(shared_char)
    for t in g.char_tags:
        if len(char_tags) >= ctn:
            break
        if t not in a_ctag_set:
            char_tags.append(t)
    shared_cv = [t for t in g.vas if t in a.vas]
    out["metaTags"] = {
        "guess": list(dict.fromkeys(subject_tags + char_tags + list(g.vas))),     # 上游用 Set，三类之间重名只留一个
        "shared": list(dict.fromkeys(shared_subject + shared_char + shared_cv)),
    }

    # 最晚登场年份（第 736-756 行）。上游 guess 在「无」时是 '?'
    out["latestAppearance"] = _year_block(g.latest, a.latest)
    # 最早登场年份（第 757-776 行）。上游 guess 在「无」时是 -1
    out["earliestAppearance"] = _year_block(g.earliest, a.earliest)

    # ---- 猜的角色自己的显示值（上游没有这一块，给前端画表用）
    s_shared, c_shared, v_shared = set(shared_subject), set(shared_char), set(shared_cv)
    work_original, work_cn = first_original, first_cn
    if game_name:                           # 中文名优先，没有就原名
        work_original, work_cn = game_name[0], game_name[1] or game_name[0]
    out["display"] = {
        "id": g.id, "name": g.name, "gender": gg, "gender_symbol": GENDER_SYMBOL[g.gender],
        "popularity": g.popularity, "heat": g.heat, "comments": g.comments,
        "rating": g.rating, "n_app": g.n_app, "earliest": g.earliest, "latest": g.latest,
        "has_profile": g.n_app > 0,
        "subject_tags": [{"tag": t, "shared": t in s_shared} for t in subject_tags],
        "char_tags": [{"tag": t, "shared": t in c_shared} for t in char_tags],
        "vas": [{"name": v, "shared": v in v_shared} for v in g.vas],
        "shared_work": {
            "name": work_cn or out["shared_appearances"]["first"] or None,
            "name_original": work_original or out["shared_appearances"]["first"] or None,
            "count": out["shared_appearances"]["count"],
        },
    }
    return out


def _year_block(gy: Optional[int], ay: Optional[int]) -> Dict[str, Any]:
    """任一方「无」→ ?（两边都无 → =）；否则差 0 → =，≤ 2 → + / -，更大 → ++ / --。"""
    if gy is None or ay is None:
        return {"guess": gy, "feedback": "=" if (gy is None and ay is None) else "?"}
    return {"guess": gy, "feedback": _count_feedback(gy - ay, 2)}


# ---------------------------------------------------------------- 入口
def _game_names(snap: Snapshot, g: CharView) -> Dict[int, Tuple[str, str]]:
    """猜的角色的特殊游戏 id -> (原名, 中文名)。库里查不到的游戏不放进去（subject_names 会拿 id 当名字，那不是名字）。"""
    if not g.extra_apps:
        return {}
    return {s: nm for s, nm in subject_names(snap, g.extra_apps).items() if nm != (str(s), str(s))}


def solo_feedback(snap: Snapshot, mode: str, guess_id: int, answer_id: int, subject_tag_num: int,
                  character_tag_num: int, mp: Optional[ModeProfile] = None) -> Dict[str, Any]:
    check_mode(mode)
    n = check_tag_num(subject_tag_num, "作品标签数")
    ctn = check_tag_num(character_tag_num, "角色标签数")
    mp = mp or snap.mode(mode)
    g = char_view(snap, mp, n, int(guess_id))
    a = char_view(snap, mp, n, int(answer_id))
    names = subject_names(snap, list(g.regular_apps) + list(a.regular_apps))
    fb = compute_feedback(g, a, n, ctn, [names[s] for s in g.regular_apps], [names[s] for s in a.regular_apps],
                          _game_names(snap, g))
    return {"guess_id": g.id, "answer_id": a.id, "mode": mode, "subject_tag_num": n, "character_tag_num": ctn,
            "correct": g.id == a.id, **fb}
