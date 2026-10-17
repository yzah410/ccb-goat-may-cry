# -*- coding: utf-8 -*-
"""清单（data/lists_v2/<id>.json）和方案（data/plans_v2/<name>.json）的文件存储。

清单：{ id, name, kind: 'character'|'work'|'tag', items: [{id?: number, name: string}], note, created, updated }
方案：SpecV2（带 meta）。
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import threading
from typing import Any, Dict, List, Optional

from . import settings

LIST_KINDS = ("character", "work", "tag")
_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WIN_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


class StorageError(Exception):
    def __init__(self, message: str, status: int = 400):
        self.message = message
        self.status = status
        super().__init__(message)


def now_iso() -> str:
    """UTC、毫秒、Z 结尾，和浏览器的 Date.toISOString() 同一种写法（前端传来的 created 也是这种）。"""
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ts_key(s: Any) -> float:
    """排序用：把各种 ISO 时间（带 Z / 带时区 / 不带时区）换成时间戳；解析不了的排最后。"""
    if not isinstance(s, str) or not s:
        return float("-inf")
    try:
        d = _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return float("-inf")
    if d.tzinfo is None:
        d = d.astimezone()
    return d.timestamp()


def _atomic_write(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def check_list_id(list_id: str) -> str:
    if not isinstance(list_id, str) or not _ID_RE.match(list_id):
        raise StorageError("清单 id 只能用英文字母、数字、下划线、减号（1–64 个字符）")
    return list_id


def check_plan_name(name: str) -> str:
    if not isinstance(name, str):
        raise StorageError("方案名要是文字")
    name = name.strip()
    if not name:
        raise StorageError("方案名不能是空的")
    if len(name) > 80:
        raise StorageError("方案名太长了（最多 80 个字）")
    if _BAD_NAME.search(name) or name.startswith(".") or name.endswith(".") or name.split(".")[0].upper() in _WIN_RESERVED:
        raise StorageError('方案名里不能有 \\ / : * ? " < > | 这些字符，也不能以点开头或结尾')
    return name


def normalize_items(kind: str, items: Any) -> List[Dict[str, Any]]:
    if items is None:
        return []
    if isinstance(items, str):
        items = [x for x in re.split(r"[\r\n,，、]+", items)]
    if not isinstance(items, list):
        raise StorageError("items 要是列表")
    out: List[Dict[str, Any]] = []
    seen = set()
    for it in items:
        if isinstance(it, (int, float)) and not isinstance(it, bool):
            it = {"id": int(it), "name": ""}
        elif isinstance(it, str):
            s = it.strip()
            if not s:
                continue
            it = {"id": int(s), "name": ""} if (kind != "tag" and s.isdigit()) else {"name": s}
        elif not isinstance(it, dict):
            raise StorageError("items 里每一项要是 {id?, name} 或文字")
        name = str(it.get("name") or "").strip()
        iid = it.get("id")
        if kind == "tag":
            if not name:
                continue
            key = ("n", name)
            rec = {"name": name}
        else:
            if iid is not None:
                try:
                    iid = int(iid)
                except (TypeError, ValueError):
                    raise StorageError(f"清单项的 id 要是整数：{iid!r}")
            if iid is None and not name:
                continue
            key = ("i", iid) if iid is not None else ("n", name)
            rec = {"id": iid, "name": name} if iid is not None else {"name": name}
        if key in seen:
            continue
        seen.add(key)
        out.append(rec)
    return out


class ListStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._cache: Dict[str, tuple] = {}   # id -> (mtime_ns, data)
        self._counter = 0

    def dir(self) -> str:
        d = settings.lists_dir()
        os.makedirs(d, exist_ok=True)
        return d

    def _path(self, list_id: str) -> str:
        return os.path.join(self.dir(), check_list_id(list_id) + ".json")

    def version(self) -> tuple:
        d = self.dir()
        try:
            st = os.stat(d)
            files = tuple(sorted((f, os.stat(os.path.join(d, f)).st_mtime_ns) for f in os.listdir(d) if f.endswith(".json")))
        except OSError:
            files = ()
            st = None
        return (self._counter, st.st_mtime_ns if st else 0, hash(files))

    def get(self, list_id: str) -> Optional[Dict[str, Any]]:
        try:
            path = self._path(list_id)
        except StorageError:
            return None
        try:
            mt = os.stat(path).st_mtime_ns
        except OSError:
            return None
        hit = self._cache.get(list_id)
        if hit and hit[0] == mt:
            return hit[1]
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        data.setdefault("id", list_id)
        data.setdefault("items", [])
        data.setdefault("kind", "tag")
        data.setdefault("note", "")
        self._cache[list_id] = (mt, data)
        return data

    def all(self) -> List[Dict[str, Any]]:
        out = []
        for f in os.listdir(self.dir()):
            if not f.endswith(".json"):
                continue
            d = self.get(f[:-5])
            if d is not None:
                out.append(d)
        out.sort(key=lambda d: (_ts_key(d.get("updated")), d.get("id") or ""), reverse=True)
        return out

    def save(self, body: Dict[str, Any], list_id: Optional[str] = None, create_only: bool = False) -> Dict[str, Any]:
        if not isinstance(body, dict):
            raise StorageError("清单要是一个 JSON 对象")
        kind = body.get("kind") or "tag"
        if kind not in LIST_KINDS:
            raise StorageError("清单种类只能是 character（角色）/ work（作品）/ tag（标签）")
        name = str(body.get("name") or "").strip()
        if not name:
            raise StorageError("清单要有名字")
        if len(name) > 80:
            raise StorageError("清单名字太长了（最多 80 个字）")
        items = normalize_items(kind, body.get("items"))
        with self._lock:
            if list_id is None:
                list_id = body.get("id") or None
            if list_id is None:
                import secrets
                alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
                while True:
                    list_id = "l_" + "".join(secrets.choice(alphabet) for _ in range(6))
                    if not os.path.exists(self._path(list_id)):
                        break
            check_list_id(list_id)
            old = self.get(list_id)
            if old is not None and create_only:
                raise StorageError(f"清单 id「{list_id}」已经存在", status=409)
            now = now_iso()
            data = {
                "id": list_id, "name": name, "kind": kind, "items": items,
                "note": str(body.get("note") or ""),
                "created": (old or {}).get("created") or now, "updated": now,
            }
            _atomic_write(self._path(list_id), data)
            self._counter += 1
            self._cache.pop(list_id, None)
            return data

    def delete(self, list_id: str) -> bool:
        path = self._path(list_id)
        with self._lock:
            if not os.path.exists(path):
                return False
            os.remove(path)
            self._counter += 1
            self._cache.pop(list_id, None)
            return True


class PlanStore:
    def dir(self) -> str:
        d = settings.plans_dir()
        os.makedirs(d, exist_ok=True)
        return d

    def _path(self, name: str) -> str:
        return os.path.join(self.dir(), check_plan_name(name) + ".json")

    def get(self, name: str) -> Optional[Dict[str, Any]]:
        path = self._path(name)
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def all(self) -> List[Dict[str, Any]]:
        out = []
        for f in os.listdir(self.dir()):
            if not f.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.dir(), f), "r", encoding="utf-8") as fh:
                    d = json.load(fh)
            except (OSError, ValueError):
                continue
            meta = d.get("meta") or {}
            out.append({"name": meta.get("name") or f[:-5], "file": f[:-5], "note": meta.get("note") or "",
                        "created": meta.get("created"), "updated": meta.get("updated"),
                        "mode": (d.get("game") or {}).get("mode"),
                        "ranges": len(d.get("ranges") or []), "excludes": len(d.get("excludes") or [])})
        out.sort(key=lambda p: _ts_key(p.get("updated")), reverse=True)
        return out

    def save(self, name: str, spec_dict: Dict[str, Any]) -> Dict[str, Any]:
        name = check_plan_name(name)
        old = self.get(name)
        now = now_iso()
        meta = dict(spec_dict.get("meta") or {})
        meta["name"] = name
        meta["created"] = ((old or {}).get("meta") or {}).get("created") or meta.get("created") or now
        meta["updated"] = now
        data = dict(spec_dict)
        data["meta"] = meta
        _atomic_write(self._path(name), data)
        return data

    def delete(self, name: str) -> bool:
        path = self._path(name)
        if not os.path.exists(path):
            return False
        os.remove(path)
        return True


LISTS = ListStore()
PLANS = PlanStore()
