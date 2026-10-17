# -*- coding: utf-8 -*-
"""最小的 JSON Patch（RFC 6902）：只认 add / replace / remove，给「AI 填工作台」用。

AI 不重写整份方案，只输出「对当前方案改哪几处」（例：{"op": "replace", "path": "/ranges/0/source/year_from", "value": 2024}）。
这里按 RFC 6902 / RFC 6901 应用；出错时抛 PatchError，message 是给人看的中文（说清楚是第几条、哪个路径、为什么）。

和 RFC 不一样的地方（都是为了让「AI 心里想的」和「实际改的」一致）：
1. **数组下标一律按修改之前的文档算**（RFC 是每条修改按顺序生效、下标跟着变）。
   例：当前有 3 个条件，AI 写 remove /conditions/0 再 remove /conditions/1，本意是删前两个——RFC 会删掉第 1 和第 3 个，这里删前两个。
   - remove / replace 下标 i = 修改之前的第 i 项（前面的修改里已经删掉了就报错）；
   - add 下标 i = 插在修改之前的第 i 项前面（它已被删掉就插在后面第一个还在的项前面；i 等于原长度或写 - 就加在末尾）；
   - 这次修改里新加进来的数组（值里带的）照 RFC 的规则。
2. replace 一个对象里**不存在**的键 → 报错（和 RFC 一样；AI 把字段名写错时不能悄悄变成「加一个没人认识的键」）。
3. op 写成大写（"Replace"）也认；只给一条修改、没包成数组也认。
4. 可选 merge 钩子：replace 一个对象时，调用方可以决定「和原来的对象合并」而不是整个换掉（ai.py 用它处理
   「AI 只写了 source 的一部分，却把整个 source 换掉」这种情况）。
不认 move / copy / test：出现就报错（AI 用不到它们）。
"""
from __future__ import annotations

import copy
from typing import Any, Callable, Dict, List, Optional, Tuple

OPS = ("add", "replace", "remove")

# merge(路径各段, 原来的对象, AI 给的新对象) -> 合并后的对象；返回 None = 照常整个替换
MergeFn = Callable[[List[str], Dict[str, Any], Dict[str, Any]], Optional[Dict[str, Any]]]


class PatchError(ValueError):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


def _unescape(tok: str) -> str:
    return tok.replace("~1", "/").replace("~0", "~")


def parse_pointer(path: Any) -> List[str]:
    """"/ranges/0/source" → ["ranges", "0", "source"]；"" → []（整份文档）。"""
    if not isinstance(path, str):
        raise PatchError(f"路径必须是字符串，收到的是 {type(path).__name__}")
    if path == "":
        return []
    if not path.startswith("/"):
        raise PatchError(f"路径「{path}」要以 / 开头")
    return [_unescape(t) for t in path[1:].split("/")]


def _num(tok: str, path: str) -> int:
    if not tok.isdigit() or (len(tok) > 1 and tok[0] == "0"):
        raise PatchError(f"路径「{path}」里的「{tok}」不是数组下标")
    return int(tok)


def _find(lst: List[Any], target: Any) -> int:
    for k, x in enumerate(lst):
        if x is target:
            return k
    return -1


class _Doc:
    """正在改的文档 + 修改之前每个数组的样子（按下标找「原来的第 i 项」）。"""

    def __init__(self, doc: Any, original_indices: bool):
        self.root = doc
        # id(数组) → (数组本身, 修改之前的元素)；存数组本身是为了它活着的时候 id 不会被别的对象复用
        self.snap: Dict[int, Tuple[List[Any], List[Any]]] = {}
        if original_indices:
            self._walk(doc)

    def _walk(self, x: Any) -> None:
        if isinstance(x, dict):
            for v in x.values():
                self._walk(v)
        elif isinstance(x, list):
            self.snap[id(x)] = (x, list(x))
            for v in x:
                self._walk(v)

    def _orig(self, lst: List[Any]) -> Optional[List[Any]]:
        ent = self.snap.get(id(lst))
        return ent[1] if ent is not None and ent[0] is lst else None

    def index(self, lst: List[Any], tok: str, path: str, mode: str) -> int:
        """mode：get（往下走 / remove / replace）或 add（插入位置）。返回现在的下标。"""
        orig = self._orig(lst)
        if tok == "-":
            if mode == "add":
                return len(lst)
            raise PatchError(f"路径「{path}」里的「-」只能用在 add（加在末尾）")
        i = _num(tok, path)
        if orig is None:                                   # 这次修改里新加的数组：照 RFC
            if i > len(lst) or (i == len(lst) and mode != "add"):
                raise PatchError(f"路径「{path}」的下标 {i} 超出了范围（这个数组只有 {len(lst)} 项）")
            return i
        if i >= len(orig):
            # 超出原来长度的下标 = 这次加在末尾的那些项（例：先 add …/conditions/-，再改 …/conditions/2/tags）
            last = max((k for k, x in enumerate(lst) if any(x is t for t in orig)), default=-1)
            tail = lst[last + 1:]
            j = i - len(orig)
            if mode == "add" and j <= len(tail):
                return len(lst) if j == len(tail) else _find(lst, tail[j])
            if mode != "add" and j < len(tail):
                return _find(lst, tail[j])
            raise PatchError(f"路径「{path}」的下标 {i} 超出了范围（这个数组原来只有 {len(orig)} 项）")
        if mode == "add":
            for t in orig[i:]:                             # 插在原来第 i 项（或它后面第一个还在的项）前面
                k = _find(lst, t)
                if k >= 0:
                    return k
            return len(lst)
        k = _find(lst, orig[i])
        if k < 0:
            raise PatchError(f"路径「{path}」指的是原来的第 {i + 1} 项，它在前面的修改里已经删掉了")
        return k

    def replaced(self, lst: List[Any], old: Any, new: Any) -> None:
        """数组里的一项被整个换掉：以后按原下标找它时找到新的这一项。"""
        orig = self._orig(lst)
        if orig is not None:
            for j, t in enumerate(orig):
                if t is old:
                    orig[j] = new


def apply_patch(doc: Any, ops: Any, merge: Optional[MergeFn] = None, original_indices: bool = True) -> Any:
    """返回改好的新文档（不动原文档）。original_indices=False 时数组下标按 RFC（每条修改按顺序生效）。"""
    if isinstance(ops, dict):          # AI 偶尔只给一条、没包成数组
        ops = [ops]
    if not isinstance(ops, list):
        raise PatchError("修改列表（patch）必须是数组")
    d = _Doc(copy.deepcopy(doc), original_indices)
    for n, op in enumerate(ops, 1):
        try:
            _apply_one(d, op, merge)
        except PatchError as e:
            raise PatchError(f"第 {n} 条修改：{e.message}")
    return d.root


def _parent(d: _Doc, toks: List[str], path: str) -> Tuple[Any, str]:
    cur = d.root
    for j, tok in enumerate(toks[:-1]):
        where = "/" + "/".join(toks[:j + 1])
        if isinstance(cur, dict):
            if tok not in cur:
                raise PatchError(f"路径「{path}」不存在（当前方案里没有「{where}」）")
            cur = cur[tok]
        elif isinstance(cur, list):
            cur = cur[d.index(cur, tok, path, "get")]
        else:
            raise PatchError(f"路径「{path}」不存在（「{where}」不是对象也不是数组）")
    return cur, toks[-1]


def _merged(merge: Optional[MergeFn], toks: List[str], old: Any, new: Any) -> Any:
    if merge is not None and isinstance(old, dict) and isinstance(new, dict):
        m = merge(toks, old, new)
        if m is not None:
            return m
    return new


def _apply_one(d: _Doc, op: Any, merge: Optional[MergeFn]) -> None:
    if not isinstance(op, dict):
        raise PatchError("每一条修改都应该是 {op, path, value} 对象")
    kind = str(op.get("op") or "").strip().lower()
    if kind not in OPS:
        raise PatchError(f"不认识的操作「{op.get('op')}」（只能是 add / replace / remove）")
    path = op.get("path")
    toks = parse_pointer(path)
    if kind in ("add", "replace") and "value" not in op:
        raise PatchError(f"{kind} 「{path}」缺少 value")
    value = copy.deepcopy(op.get("value"))
    if not toks:                       # 整份替换
        if kind == "remove":
            raise PatchError("不能删掉整份方案")
        d.root = _merged(merge, [], d.root, value)
        return
    parent, last = _parent(d, toks, path)
    if isinstance(parent, dict):
        if kind == "remove":
            if last not in parent:
                raise PatchError(f"要删的「{path}」本来就不存在")
            del parent[last]
        elif kind == "replace":
            if last not in parent:
                raise PatchError(f"要改的「{path}」不存在（字段名是不是写错了？）")
            parent[last] = _merged(merge, toks, parent[last], value)
        else:                          # add：键已经有了就是替换（RFC）
            parent[last] = _merged(merge, toks, parent[last], value) if last in parent else value
    elif isinstance(parent, list):
        if kind == "add":
            parent.insert(d.index(parent, last, path, "add"), value)
        elif kind == "replace":
            k = d.index(parent, last, path, "get")
            old = parent[k]
            parent[k] = _merged(merge, toks, old, value)
            d.replaced(parent, old, parent[k])
        else:
            del parent[d.index(parent, last, path, "get")]
    else:
        raise PatchError(f"路径「{path}」不存在（上一级不是对象也不是数组）")
