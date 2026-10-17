"""作品集 JSON → Obsidian 笔记（.md），供 TagNote 插件打开。

笔记结构：
  1. frontmatter：tagnote: 1（插件靠它识别），以及标题、作品数、来源、分组、原始 .canvas 文件路径（origin，从导图导入时才有）、生成日期、标签口径
  2. 「成员」列表：每部作品一行，带 [[作品ID - 作品名|作品名]] 链接和完整标签组 → 没装插件也能读，搜索照常工作
  3. ```tagnote 代码块：完整 JSON（插件渲染六种视图的数据，含 layout_cache）
出题器的下载接口、tagnote/tools/make_obsidian_note.py 都调这里，保证格式只有一份。
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

# 成员列表里标签组的先后：类型题材 → 制作 → 形式 → 来源 → 其它
SEG = ["G_1", "G_2", "G_3", "G_staff", "G_format", "G_source", "G_4"]
FM_KEYS = ("source", "group", "origin", "generated_at", "tags_from")


def _q(v: Any) -> str:
    """YAML 字符串：JSON 的双引号字符串同时是合法 YAML，引号、冒号、井号都不用另外处理。"""
    return json.dumps(str(v), ensure_ascii=False)


def tag_line(w: Dict[str, Any], groups: Dict[str, List[str]], common: set) -> str:
    by: Dict[str, List[str]] = {}
    for t in w.get("tags") or []:
        if t in common:
            continue
        g = next((k for k, v in groups.items() if t in v), "G_else")
        by.setdefault(g, []).append(t)
    parts = []
    for g in SEG:
        if by.get(g):
            order = groups.get(g, [])
            parts.append(" ".join(sorted(by[g], key=lambda t: order.index(t) if t in order else 99)))
    s = " · ".join(parts) if parts else "（只有共有标签）"
    if by.get("G_else"):
        # 不在任何标签组里的词（如「日本」、制作人员），不一定低频
        s += "  ｜其它：" + " ".join(sorted(by["G_else"]))
    return s


def _score(v: Any) -> str:
    try:
        return "—" if v is None else f"{float(v):.1f}"
    except (TypeError, ValueError):
        return "—"


def make_note(data: Dict[str, Any]) -> str:
    col = data.get("collection") or {}
    groups = data.get("tag_groups") or {}
    works = data.get("works") or []
    common = set(col.get("common_tags") or [])
    if not common and len(works) > 1:
        common = set.intersection(*(set(w.get("tags") or []) for w in works))
    fm = ["---", "tagnote: 1", f"title: {_q(col.get('title') or '标签笔记')}", f"works: {len(works)}"]
    fm += [f"{k}: {_q(col[k])}" for k in FM_KEYS if col.get(k)]
    fm.append("---")
    lines = fm + ["", f"> 标签笔记 · {len(works)} 部 · 全部共有：{' '.join(sorted(common)) or '无'}。装了 TagNote 插件时，打开本笔记即可切换六种视图。",
                  "", "## 成员", ""]
    for w in works:
        link = w.get("link") or (f"{w['subject_id']} - {w['title']}" if w.get("subject_id") else None)
        # 从 .canvas 导图导入的、手写且没有作品链接的卡片：只写作品名，不造一个指向空笔记的链接
        name = f"[[{link}|{w['title']}]]" if link else w["title"]
        note = f"（{w['note']}）" if w.get("note") else ""
        lines.append(f"- {name}{note} {w.get('years', '')} · {_score(w.get('score'))} — {tag_line(w, groups, common)}")
    slim = dict(data)
    # data URI 封面会让笔记变得很大；去掉后引擎显示作品名首字
    slim["works"] = [{k: v for k, v in w.items() if not (k == "cover" and isinstance(v, str) and v.startswith("data:"))} for w in works]
    lines += ["", "## 数据", "", "```tagnote", json.dumps(slim, ensure_ascii=False, indent=1), "```", ""]
    return "\n".join(lines)


_BAD = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f]')


def note_filename(title: str) -> str:
    """Windows 和 Obsidian 都能用的文件名（Obsidian 链接里不能有 # ^ [ ] |）。"""
    name = _BAD.sub(" ", title or "").strip().rstrip(".") or "标签笔记"
    return re.sub(r"\s+", " ", name)[:120] + ".md"
