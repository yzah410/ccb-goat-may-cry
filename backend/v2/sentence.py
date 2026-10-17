# -*- coding: utf-8 -*-
"""把一个范围 / 排除项翻译成一句中文（模板拼接，不用 AI）。

例：「2016–2026 年热度前 50 部动画的主角里（每部最多 6 人，按角色热度），作品标签同时含『百合』『日常』的角色」

另外提供 describe_changes(old, new)：两份方案之间「改了什么」（给 AI 填表的 changes 用，由后端算，保证和实际改动一致）。
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from .spec import RangeV2, SpecV2, TagFilter

ListGet = Callable[[str], Optional[Dict[str, Any]]]

TYPE_ORDER = [2, 4, 1, 6, 3]
TYPE_ZH = {1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元"}
MODE_ZH = {"anime": "动画", "game": "游戏", "book": "书籍", "real": "三次元", "all": "全部"}
DRAW_ZH = {"per_character": "每个角色机会均等", "per_work": "先抽作品、再抽角色", "range_share": "按范围占比"}
MAX_TAGS_SHOWN = 6


def _n(x) -> str:
    if x is None:
        return ""
    if isinstance(x, float):
        if x.is_integer():
            x = int(x)
        else:
            return f"{x:g}"
    return f"{x:,}"


def join_or(items: List[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return "、".join(items[:-1]) + "或" + items[-1]


def join_and(items: List[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return "、".join(items[:-1]) + "和" + items[-1]


def types_phrase(types: Optional[List[int]]) -> str:
    if not types:
        return "作品"
    ts = [t for t in TYPE_ORDER if t in set(types)]
    if set(ts) == {1, 2, 4, 6}:
        return "书籍、动画、游戏和三次元作品"
    return join_and([TYPE_ZH.get(t, str(t)) for t in ts])


def years_phrase(yf: Optional[int], yt: Optional[int]) -> str:
    if yf is not None and yt is not None:
        return f"{yf} 年" if yf == yt else f"{yf}–{yt} 年"
    if yf is not None:
        return f"{yf} 年及以后"
    if yt is not None:
        return f"{yt} 年及以前"
    return ""


def list_name(lists_get: ListGet, list_id: Optional[str]) -> str:
    if not list_id:
        return "（没选清单）"
    d = lists_get(list_id) if lists_get else None
    if not d:
        return f"{list_id}（已不存在）"
    return str(d.get("name") or list_id)


def list_ref(lists_get: ListGet, list_id: Optional[str], kind_zh: str = "清单") -> str:
    """「角色清单『示例清单』」；清单被删了就写「角色清单 l_xxx（已不存在）」，不套书名号。"""
    if not list_id:
        return f"{kind_zh}（没选）"
    d = lists_get(list_id) if lists_get else None
    if not d:
        return f"{kind_zh} {list_id}（已不存在）"
    return f"{kind_zh}『{d.get('name') or list_id}』"


def _tags_txt(tags: List[str]) -> str:
    shown = "".join(f"『{t}』" for t in tags[:MAX_TAGS_SHOWN])
    if len(tags) > MAX_TAGS_SHOWN:
        shown += f"等 {len(tags)} 个"
    return shown


# ---------------------------------------------------------------- 标签筛选
def tagfilter_phrase(tf: TagFilter, lists_get: ListGet, negate: bool, style: str) -> str:
    """style: 'game'（角色的作品标签）/ 'char'（角色标签）/ 'work'（作品本身的标签）。"""
    tags = list(tf.tags or [])
    lst = list_ref(lists_get, tf.tag_list_id) if tf.tag_list_id else None
    q = tf.quant
    k = tf.k if tf.k is not None else 1
    if negate and q == "any":
        q, negate = "none", False
    elif negate and q == "none":
        q, negate = "any", False
    single = len(tags) == 1 and not lst
    two = len(tags) == 2 and not lst
    if single and q == "all":
        q = "any" if not negate else "none"
        negate = False
    if q == "at_least" and single and k <= 1:
        q = "any" if not negate else "none"
        negate = False
    if lst and tags:
        pool = f"{lst}里的标签和{_tags_txt(tags)}"
    elif lst:
        pool = f"{lst}里的标签"
    else:
        pool = _tags_txt(tags)
    list_only = bool(lst) and not tags

    if style in ("game", "char"):
        P = "作品标签" if style == "game" else "角色标签"
        if q == "any":
            if single:
                return f"{P}含{pool}"
            if two:
                return f"{P}含『{tags[0]}』或『{tags[1]}』"
            return f"{P}含{lst}里的任意一个标签" if list_only else f"{P}含{pool}中的任意一个"
        if q == "none":
            if single:
                return f"{P}不含{pool}"
            if two:
                return f"{P}既不含『{tags[0]}』也不含『{tags[1]}』"
            return f"{P}不含{lst}里的任何一个标签" if list_only else f"{P}不含{pool}中的任何一个"
        if q == "all":
            if not negate:
                return f"{P}含{lst}里的全部标签" if list_only else f"{P}同时含{pool}"
            return f"{P}没有含全{lst}里的标签" if list_only else f"{P}没有同时含{pool}"
        if q == "at_least":
            if not negate:
                return f"{P}至少含{lst}里的 {k} 个标签" if list_only else f"{P}至少含{pool}中的 {k} 个"
            return f"{P}含{lst}里的标签不到 {k} 个" if list_only else f"{P}含{pool}中的不到 {k} 个"
    # 作品本身的标签（meta = Bangumi 公共标签）
    note = "（有人打过就算）" if tf.tag_mode == "any" else ""
    W = "公共标签" if tf.tag_mode == "meta" else "标签"
    if q == "any":
        if single:
            return f"带{pool}{W}{note}"
        if two:
            return f"带『{tags[0]}』或『{tags[1]}』{W}{note}"
        return f"带{lst}里任意一个{W}{note}" if list_only else f"带{pool}中任意一个{W}{note}"
    if q == "none":
        if single:
            return f"不带{pool}{W}{note}"
        return f"不带{lst}里的任何{W}{note}" if list_only else f"不带{pool}中的任何一个{W}{note}"
    if q == "all":
        if not negate:
            return f"带{lst}里的全部{W}{note}" if list_only else f"同时带{pool}{W}{note}"
        return f"没有带全{lst}里的{W}{note}" if list_only else f"没有同时带{pool}{W}{note}"
    if q == "at_least":
        if not negate:
            return f"带{lst}里至少 {k} 个{W}{note}" if list_only else f"带{pool}中至少 {k} 个{W}{note}"
        return f"带{lst}里的{W}不到 {k} 个{note}" if list_only else f"带{pool}中不到 {k} 个{W}{note}"
    return "（标签条件）"


def tagfilter_is_empty(tf: Optional[TagFilter]) -> bool:
    return tf is None or (not tf.tags and not tf.tag_list_id)


# ---------------------------------------------------------------- 数值
def _minmax(name: str, mn, mx, negate: bool, unit: str = "") -> str:
    a, b = _n(mn), _n(mx)
    if mn is not None and mx is not None:
        if mn == mx:
            return f"{name}不是 {a}{unit}" if negate else f"{name}为 {a}{unit}"
        return f"{name}不在 {a}–{b}{unit} 之间" if negate else f"{name}在 {a}–{b}{unit} 之间"
    if mn is not None:
        return f"{name}少于 {a}{unit}" if (negate and unit) else (f"{name}低于 {a}" if negate else f"{name}至少 {a}{unit}")
    if mx is not None:
        return f"{name}多于 {b}{unit}" if (negate and unit) else (f"{name}高于 {b}" if negate else f"{name}不超过 {b}{unit}")
    return f"{name}（没设范围）"


def _year_minmax(name: str, mn, mx, negate: bool) -> str:
    a = None if mn is None else int(mn)
    b = None if mx is None else int(mx)
    if a is not None and b is not None:
        if a == b:
            return f"{name}不在 {a} 年" if negate else f"{name}于 {a} 年"
        return f"{name}不在 {a}–{b} 年之间" if negate else f"{name}于 {a}–{b} 年"
    if a is not None:
        return f"{name}早于 {a} 年" if negate else f"{name}于 {a} 年或以后"
    if b is not None:
        return f"{name}晚于 {b} 年" if negate else f"{name}于 {b} 年或以前"
    return f"{name}（没设范围）"


# ---------------------------------------------------------------- 单个条件
def condition_is_empty(c) -> bool:
    t = c.type
    if t in ("gender", "source_tag"):
        return not c.values
    if t == "va":
        return not [x for x in c.names if x.strip()]
    if t in ("char_heat", "n_app", "earliest_year", "latest_year", "rating"):
        return c.min is None and c.max is None
    if t in ("game_tags", "char_tags"):
        return tagfilter_is_empty(c)
    if t == "appearance":
        return (not c.subject_types and c.year_from is None and c.year_to is None and not c.roles
                and tagfilter_is_empty(c.work_tags) and not c.work_list_id)
    if t == "char_list":
        return not c.list_id
    if t == "sql":
        return not (c.sql or "").strip()
    return False


def condition_phrase(c, lists_get: ListGet) -> str:
    t, neg = c.type, bool(c.negate)
    if t == "gender":
        vals = [v for v in ("男", "女", "未知") if v in set(c.values)]
        if neg:
            if len(vals) == 1:
                return "性别不是未知" if vals[0] == "未知" else "性别不是" + vals[0]
            vals = [v for v in ("男", "女", "未知") if v not in set(c.values)]
            if not vals:
                return "（性别：全部取反，没人满足）"
        if vals == ["未知"]:
            return "性别未知"
        return "性别为" + join_or(vals)
    if t == "char_heat":
        return _minmax("角色热度", c.min, c.max, neg)
    if t == "n_app":
        return _minmax("登场作品", c.min, c.max, neg, unit=" 部")
    if t == "rating":
        return _minmax("最高评分", c.min, c.max, neg)
    if t == "earliest_year":
        return _year_minmax("最早登场", c.min, c.max, neg)
    if t == "latest_year":
        return _year_minmax("最晚登场", c.min, c.max, neg)
    if t == "game_tags":
        return tagfilter_phrase(c, lists_get, neg, "game")
    if t == "char_tags":
        return tagfilter_phrase(c, lists_get, neg, "char")
    if t == "va":
        names = [x.strip() for x in c.names if x.strip()]
        if len(names) == 1:
            who = f"『{names[0]}』"
        elif len(names) == 2:
            who = f"『{names[0]}』或『{names[1]}』"
        else:
            who = _tags_txt(names) + "中的任意一位"
        if neg:
            return f"不是由{who}配音" if len(names) <= 2 else f"不由{_tags_txt(names)}中的任何一位配音"
        return f"由{who}配音"
    if t == "source_tag":
        vals = list(c.values)
        return ("来源不是" + "、".join(vals)) if neg else ("来源是" + join_or(vals))
    if t == "char_list":
        ref = list_ref(lists_get, c.list_id, "角色清单")
        return f"不在{ref}里" if neg else f"在{ref}里"
    if t == "sql":
        lab = f"『{c.label}』" if c.label else ""
        return f"不满足自定义查询{lab}" if neg else f"满足自定义查询{lab}"
    if t == "appearance":
        return appearance_phrase(c, lists_get, neg)
    return f"（{t}）"


def appearance_phrase(c, lists_get: ListGet, neg: bool) -> str:
    what = types_phrase(c.subject_types) if c.subject_types else "作品"
    bits = []
    yp = years_phrase(c.year_from, c.year_to)
    if yp:
        bits.append(yp)
    if not tagfilter_is_empty(c.work_tags):
        bits.append(tagfilter_phrase(c.work_tags, lists_get, False, "work"))
    desc = "、".join(bits)
    roles = [r for r in ("主角", "配角", "客串") if r in set(c.roles or [])]
    if not roles or len(roles) == 3:
        act = "登场过"
    elif roles == ["客串"]:
        act = "客串过"
    else:
        act = "当过" + join_or(roles)
    if c.work_list_id:
        where = f"{list_ref(lists_get, c.work_list_id, '作品清单')}里" + (f"{desc}的" if desc else "") + f"某一部{what}"
        return f"没有在{where}{act}" if neg else f"在{where}{act}"
    if not desc and not c.subject_types and not c.roles:
        return "没有任何登场作品" if neg else "有登场作品"
    where = (f"{desc}的" if desc else "") + what
    if where[:1].isdigit():
        where = " " + where          # 「一部 2024 年的动画」：数字前留空格
    return f"没有在任何一部{where}里{act}" if neg else f"至少在一部{where}里{act}"


# ---------------------------------------------------------------- 来源 + 取角色
def roles_phrase(roles: List[str]) -> str:
    rs = [r for r in ("主角", "配角") if r in set(roles or [])]
    return "和".join(rs) if rs else "（没选身份）"


ORDER_ZH = {"heat": "按角色热度", "game": "按游戏的顺序", "bangumi": "按游戏的顺序"}


def pick_phrase(pick) -> str:
    """每部人数不限时返回空字符串（句子里就不写括号）；有上限时「每部最多 6 人，按角色热度」。"""
    if pick.per_work is None:
        return ""
    return f"每部最多 {pick.per_work} 人，{ORDER_ZH.get(pick.order, pick.order)}"


def rank_phrase(src, lists_get: ListGet) -> str:
    yp = years_phrase(src.year_from, src.year_to)
    tp = types_phrase(src.subject_types)
    wf = None if tagfilter_is_empty(src.work_filter) else tagfilter_phrase(src.work_filter, lists_get, False, "work")
    a, b = src.rank_from, src.rank_to
    is_all = b is None and a <= 1
    per = "每年" if (src.rank_scope == "per_year" and not is_all) else ""
    if is_all:
        if wf:
            return f"{yp}所有{wf}的{tp}"
        return f"{yp}的全部{tp}" if yp else f"全部{tp}"
    if b is None:
        rk = f"{per}热度第 {_n(a)} 名及以后的"
    elif a <= 1:
        rk = f"{per}热度前 {_n(b)} 部"
    elif a == b:
        rk = f"{per}热度第 {_n(a)} 名的"
    else:
        rk = f"{per}热度第 {_n(a)}–{_n(b)} 名的"
    if wf and getattr(src, "work_filter_order", "before_rank") == "after_rank":
        return f"{yp}{rk}{tp}中{wf}的作品"
    if wf:
        return f"{yp}{wf}的{tp}中{rk}".rstrip("的")
    return f"{yp}{rk}{tp}"


def range_sentence(r: RangeV2, lists_get: ListGet) -> str:
    conds = [condition_phrase(c, lists_get) for c in r.conditions if c.enabled and not condition_is_empty(c)]
    ctext = "、".join(conds)
    src = r.source
    if src.kind in ("rank", "work_list"):
        if src.kind == "rank":
            base = rank_phrase(src, lists_get)
        else:
            base = f"{list_ref(lists_get, src.list_id, '作品清单')}中各部作品"
        roles = roles_phrase(r.pick.roles)
        pk = pick_phrase(r.pick)
        paren = f"（{pk}）" if pk else ""
        if ctext:
            return f"{base}的{roles}里{paren}，{ctext}的角色"
        return f"{base}的{roles}{paren}"
    if src.kind == "char_list":
        ref = list_ref(lists_get, src.list_id, "角色清单")
        if ctext:
            return f"{ref}里，{ctext}的角色"
        return f"{ref}里的全部角色"
    # all_characters
    if ctext:
        return f"整个角色库里，{ctext}的角色"
    return "整个角色库的所有角色"


def source_short(r: RangeV2, lists_get: ListGet) -> str:
    """只描述「从哪来 + 取角色」，不含条件（给改动说明用）。"""
    tmp = r.model_copy(update={"conditions": []})
    return range_sentence(tmp, lists_get)


# ---------------------------------------------------------------- 改了什么
def _rank_desc(src) -> str:
    a, b = src.rank_from, src.rank_to
    if b is None:
        return "全部" if a <= 1 else f"第 {_n(a)} 名及以后"
    return f"前 {_n(b)} 部" if a <= 1 else f"第 {_n(a)}–{_n(b)} 名"


def _years_desc(yf, yt) -> str:
    return years_phrase(yf, yt) or "不限年份"


def _cond_key(c) -> str:
    d = c.model_dump(mode="json")
    d.pop("id", None)
    return repr(sorted(d.items(), key=lambda x: x[0]))


def describe_range_changes(o: RangeV2, n: RangeV2, lists_get: ListGet, prefix: str) -> List[str]:
    out: List[str] = []
    so, sn = o.source, n.source
    if so.kind != sn.kind:
        out.append(f"{prefix}从哪来：{source_short(o, lists_get)} → {source_short(n, lists_get)}")
    elif sn.kind == "rank":
        if (so.year_from, so.year_to) != (sn.year_from, sn.year_to):
            out.append(f"{prefix}年份：{_years_desc(so.year_from, so.year_to)} → {_years_desc(sn.year_from, sn.year_to)}")
        if list(so.subject_types) != list(sn.subject_types):
            out.append(f"{prefix}条目类型：{types_phrase(so.subject_types)} → {types_phrase(sn.subject_types)}")
        if (so.rank_from, so.rank_to) != (sn.rank_from, sn.rank_to):
            out.append(f"{prefix}热度范围：{_rank_desc(so)} → {_rank_desc(sn)}")
        if so.rank_scope != sn.rank_scope:
            z = {"merged": "合并排名", "per_year": "每年分别取"}
            out.append(f"{prefix}排名方式：{z[so.rank_scope]} → {z[sn.rank_scope]}")
        wo = None if tagfilter_is_empty(so.work_filter) else tagfilter_phrase(so.work_filter, lists_get, False, "work")
        wn = None if tagfilter_is_empty(sn.work_filter) else tagfilter_phrase(sn.work_filter, lists_get, False, "work")
        if wo != wn:
            out.append(f"{prefix}作品本身的标签：{wo or '不限'} → {wn or '不限'}")
        if wn and so.work_filter_order != sn.work_filter_order:
            z = {"before_rank": "先按作品标签筛、再排名", "after_rank": "先排名、再按作品标签筛"}
            out.append(f"{prefix}作品标签筛选：{z[so.work_filter_order]} → {z[sn.work_filter_order]}")
        if so.include_unaired != sn.include_unaired:
            out.append(f"{prefix}未上映作品：{'算' if so.include_unaired else '不算'} → {'算' if sn.include_unaired else '不算'}")
    elif getattr(so, "list_id", None) != getattr(sn, "list_id", None):
        out.append(f"{prefix}清单：{list_name(lists_get, getattr(so, 'list_id', None))} → {list_name(lists_get, sn.list_id)}")
    if sn.kind in ("rank", "work_list"):
        po, pn = o.pick, n.pick
        if list(po.roles) != list(pn.roles):
            out.append(f"{prefix}身份：只要{roles_phrase(po.roles)} → {roles_phrase(pn.roles)}".replace("只要主角和配角", "主角和配角"))
        if po.per_work != pn.per_work:
            out.append(f"{prefix}每部人数：{po.per_work if po.per_work else '不限'} → {pn.per_work if pn.per_work else '不限'}")
        if po.order != pn.order:
            out.append(f"{prefix}每部取人顺序：{ORDER_ZH.get(po.order, po.order)} → {ORDER_ZH.get(pn.order, pn.order)}")
    if o.enabled != n.enabled:
        out.append(f"{prefix}{'启用' if n.enabled else '停用'}了这个范围")
    if (o.share or 1) != (n.share or 1):
        out.append(f"{prefix}占比：{_n(o.share or 1)} → {_n(n.share or 1)}")
    # 条件：按 id 对上，对不上的按内容对
    oc = {c.id: c for c in o.conditions}
    nc = {c.id: c for c in n.conditions}
    okeys = {_cond_key(c): c for c in o.conditions}
    matched_old = set()
    for c in n.conditions:
        if c.id in oc:
            old = oc[c.id]
            matched_old.add(c.id)
            if _cond_key(old) != _cond_key(c):
                out.append(f"{prefix}改了条件：{condition_phrase(old, lists_get)} → {condition_phrase(c, lists_get)}"
                           + ("" if c.enabled else "（停用）"))
            continue
        k = _cond_key(c)
        if k in okeys and okeys[k].id not in matched_old:
            matched_old.add(okeys[k].id)
            continue
        out.append(f"{prefix}加了条件：{condition_phrase(c, lists_get)}" + ("" if c.enabled else "（停用）"))
    for c in o.conditions:
        if c.id not in matched_old and c.id not in nc:
            out.append(f"{prefix}去掉了条件：{condition_phrase(c, lists_get)}")
    return out


def describe_changes(old: SpecV2, new: SpecV2, lists_get: ListGet) -> List[str]:
    out: List[str] = []
    if old.game.mode != new.game.mode:
        out.append(f"对局模式：{MODE_ZH[old.game.mode]} → {MODE_ZH[new.game.mode]}")
    if old.game.tag_count != new.game.tag_count:
        out.append(f"作品标签数：{old.game.tag_count} → {new.game.tag_count}")
    for kind, olds, news, zh in (("ranges", old.ranges, new.ranges, "范围"), ("excludes", old.excludes, new.excludes, "排除")):
        by_id = {r.id: r for r in olds}
        used = set()
        multi = len(news) > 1 or len(olds) > 1
        for i, r in enumerate(news):
            prefix = f"{zh} {i + 1} · " if (multi or kind == "excludes") else ""
            o = by_id.get(r.id)
            if o is None and i < len(olds) and olds[i].id not in used and olds[i].id not in {x.id for x in news}:
                o = olds[i]
            if o is None:
                out.append(f"加了{zh}：{range_sentence(r, lists_get)}")
                continue
            used.add(o.id)
            out.extend(describe_range_changes(o, r, lists_get, prefix))
        for r in olds:
            if r.id not in used:
                out.append(f"去掉了{zh}：{range_sentence(r, lists_get)}")
    if old.draw.method != new.draw.method:
        out.append(f"抽题方式：{DRAW_ZH[old.draw.method]} → {DRAW_ZH[new.draw.method]}")
    return out
