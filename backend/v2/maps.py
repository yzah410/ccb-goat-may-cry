"""标签笔记导图库；与清单、筛选方案使用同一个数据根目录。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import threading
from collections import Counter
from contextlib import contextmanager
from typing import Any

from . import settings
from .storage import StorageError, now_iso

MAX_BYTES = 2 * 1024 * 1024
_ID = re.compile(r"m_[0-9a-f]{12}\Z")
_LOCK = threading.RLock()


def _encode(data: Any) -> bytes:
    try:
        raw = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as e:
        raise StorageError("作品集必须是合法 JSON") from e
    if len(raw) > MAX_BYTES:
        raise StorageError("作品集不能超过 2 MB", 413)
    return raw


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _int(value: Any, lo: int, hi: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi


def _check_terr(terr: Any) -> None:
    """领地图布局缓存的形状。引擎读到不合适的缓存会自己重算；这里只挡掉明显坏掉的，免得存进库里。
    网格 2–6 列（作品数决定）；200 部作品时 34 行，行列上限取 250 留余量。"""
    if not isinstance(terr, dict):
        raise StorageError("layout_cache.terr 必须是对象")
    cols, rows, pos = terr.get("cols"), terr.get("rows"), terr.get("pos")
    if not _int(cols, 1, 250) or not _int(rows, 1, 250):
        raise StorageError("layout_cache.terr 的 cols、rows 必须是 1–250 的整数")
    if not isinstance(pos, dict) or any(
            not isinstance(p, list) or len(p) != 2 or not _int(p[0], 0, cols - 1) or not _int(p[1], 0, rows - 1)
            for p in pos.values()):
        raise StorageError("layout_cache.terr.pos 必须是「作品 id → [列, 行]」，坐标在网格内")


def validate(data: Any) -> dict:
    """校验并复制作品集；不改调用方的数据，去掉内嵌封面。"""
    raw = _encode(data)
    if not isinstance(data, dict) or data.get("schema") != "tagnote/1":
        raise StorageError("schema 必须是 tagnote/1")
    col = data.get("collection")
    if not isinstance(col, dict) or not _text(col.get("title")):
        raise StorageError("collection.title 必须是非空字符串")
    for key in ("source", "group", "origin", "tags_from", "generated_at"):
        if col.get(key) is not None and not isinstance(col[key], str):
            raise StorageError(f"collection.{key} 必须是字符串或 null")
    if "common_tags" in col and (not isinstance(col["common_tags"], list)
                                or any(not isinstance(t, str) for t in col["common_tags"])):
        raise StorageError("collection.common_tags 必须是字符串列表")
    works = data.get("works")
    if not isinstance(works, list) or not 1 <= len(works) <= 200:
        raise StorageError("works 必须是 1–200 项的列表")
    for w in works:
        if not isinstance(w, dict) or not _text(w.get("id")) or not _text(w.get("title")):
            raise StorageError("每部作品的 id、title 必须是非空字符串")
        if not isinstance(w.get("tags"), list) or any(not isinstance(t, str) for t in w["tags"]):
            raise StorageError("作品 tags 必须是字符串列表")
    dup = sorted(i for i, n in Counter(w["id"] for w in works).items() if n > 1)
    if dup:
        raise StorageError("作品 id 重复：" + "、".join(dup[:5]) + (f" 等 {len(dup)} 个" if len(dup) > 5 else ""))
    groups = data.get("tag_groups", {})
    if not isinstance(groups, dict) or any(not isinstance(v, list) or any(not isinstance(t, str) for t in v)
                                          for v in groups.values()):
        raise StorageError("tag_groups 必须是字符串列表的对象")
    if "layout_cache" in data:
        if not isinstance(data["layout_cache"], dict):
            raise StorageError("layout_cache 必须是对象")
        if "terr" in data["layout_cache"]:
            _check_terr(data["layout_cache"]["terr"])
    clean = json.loads(raw)
    for w in clean["works"]:
        if isinstance(w.get("cover"), str) and w["cover"].lower().startswith("data:"):
            w.pop("cover")
    return clean


def edited_at_of(data: dict) -> str | None:
    """用户最近一次编辑（新建、改数据、改名）的时间。只改布局缓存的 PATCH 不动它；
    文件里没有这个字段时回退到 collection.generated_at（生成日期，只有日期）。两个都没有 → None。"""
    v = data.get("edited_at")
    if isinstance(v, str) and v:
        return v
    g = data["collection"].get("generated_at")
    return g if isinstance(g, str) and g else None


def summary(data: dict) -> dict:
    col = data["collection"]
    return {"id": data["id"], "title": col["title"], "source": col.get("source"),
            "group": col.get("group"), "origin": col.get("origin"), "n_works": len(data["works"]),
            "common_tags": col.get("common_tags", []), "tags_from": col.get("tags_from"),
            "generated_at": col.get("generated_at"), "updated_at": data["updated_at"],
            "edited_at": edited_at_of(data)}


_DIGITS = re.compile(r"[0-9]{1,15}\Z")     # 只认 ASCII 数字；不 strip、不含符号和小数点（和前端 binding.ts 的 /^\d+$/ 一致）


def _int_or_none(v: Any) -> int | None:
    """作品卡里的 id → 整数。整数和纯数字字符串（"101"）算同一个 id；布尔、小数（含 101.0）、
    非数字字符串、空白、全角数字、None 都当「没有」。导入的图里 id 有字符串也有整数，题库里是整数。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str) and _DIGITS.match(v):
        return int(v)
    return None


def _ids(data: dict) -> tuple[frozenset, frozenset]:
    """一张图里作品卡的 subject_id 集合、char_id 集合（手写卡没有就跳过）。类型统一成整数，见 _int_or_none。"""
    subjects, chars = set(), set()
    for w in data["works"]:
        s, c = _int_or_none(w.get("subject_id")), _int_or_none(w.get("char_id"))
        if s is not None:
            subjects.add(s)
        if c is not None:
            chars.add(c)
    return frozenset(subjects), frozenset(chars)


@contextmanager
def file_lock(lock_path: Path):
    """线程锁 + 文件锁（lock_path 是一个专门的锁文件）：服务与命令行同时运行也不会丢失更新。
    导图库和「联动图组」存储共用。"""
    with _LOCK:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+b") as f:
            if os.name == "nt":
                import msvcrt
                if f.seek(0, os.SEEK_END) == 0:
                    f.write(b"\0")
                    f.flush()
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)


class MapIndex:
    """全部导图的反向索引：作品 subject_id → 图、角色 char_id → 图。只读快照，按文件 (mtime, size) 缓存。
    summaries / subjects / chars 都按图 id 索引；by_subject / by_char 的值是图 id 元组（按图 id 升序）。
    skipped：建索引时读不出来、被跳过的坏图 [{id, reason}]（按图 id 升序）；它们不参与预选。"""

    def __init__(self, entries: list[tuple[dict, frozenset, frozenset]],
                 skipped: list[dict] | None = None) -> None:
        self.skipped: list[dict] = sorted(skipped or [], key=lambda s: s["id"])
        self.summaries: dict[str, dict] = {}
        self.subjects: dict[str, frozenset] = {}
        self.chars: dict[str, frozenset] = {}
        by_subject: dict[int, list[str]] = {}
        by_char: dict[int, list[str]] = {}
        for summ, subj, chars in sorted(entries, key=lambda e: e[0]["id"]):
            mid = summ["id"]
            self.summaries[mid] = summ
            self.subjects[mid] = subj
            self.chars[mid] = chars
            for s in subj:
                by_subject.setdefault(s, []).append(mid)
            for c in chars:
                by_char.setdefault(c, []).append(mid)
        self.by_subject: dict[int, tuple[str, ...]] = {k: tuple(v) for k, v in by_subject.items()}
        self.by_char: dict[int, tuple[str, ...]] = {k: tuple(v) for k, v in by_char.items()}

    def maps_for_subject(self, subject_id: int) -> tuple[str, ...]:
        return self.by_subject.get(subject_id, ())

    def maps_for_char(self, char_id: int) -> tuple[str, ...]:
        return self.by_char.get(char_id, ())


class MapStore:
    def __init__(self) -> None:
        # 图 id -> ((mtime_ns, size), 摘要, subject_id 集合, char_id 集合)
        self._summaries: dict[str, tuple[tuple[int, int], dict, frozenset, frozenset]] = {}
        # 读不出来的坏图：图 id -> ((mtime_ns, size), 原因)；文件没变就不重读
        self._bad: dict[str, tuple[tuple[int, int], str]] = {}
        # 整个反向索引：全部文件的 (id, mtime, size) 没变就直接复用
        self._index: tuple[tuple, MapIndex] | None = None

    def dir(self) -> Path:
        return Path(settings.data_dir()) / "maps_v2"

    def _path(self, map_id: str) -> Path:
        if not isinstance(map_id, str) or not _ID.fullmatch(map_id):
            raise StorageError("导图 id 必须是 m_ 加 12 位小写十六进制")
        return self.dir() / (map_id + ".json")

    @contextmanager
    def _locked(self):
        # 线程锁 + 文件锁：服务与命令行导入同时运行也不会丢失更新。
        with file_lock(self.dir() / ".lock"):
            yield

    def get(self, map_id: str) -> dict | None:
        with self._locked():
            return self._get(map_id)

    def _get(self, map_id: str) -> dict | None:
        path = self._path(map_id)
        try:
            with path.open("rb") as f:
                raw = f.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise StorageError("作品集不能超过 2 MB", 413)
            data = validate(json.loads(raw))
            data["id"] = map_id
            if not isinstance(data.get("updated_at"), str):
                raise StorageError("导图缺少 updated_at")
            return data
        except FileNotFoundError:
            return None
        except (OSError, ValueError, RecursionError) as e:
            raise StorageError(f"读取导图失败：{e}") from e

    def all(self) -> list[dict]:
        with self._locked():
            return self._all()

    def _all(self) -> list[dict]:
        return [e[0] for e in self._entries()]

    def _entries(self) -> list[tuple[dict, frozenset, frozenset]]:
        """列表接口用：任何一张图读不出来都抛 StorageError（坏图要让人看见）。"""
        return self._scan(skip_bad=False)[0]

    def _scan(self, skip_bad: bool) -> tuple[list[tuple[dict, frozenset, frozenset]], list[dict]]:
        # 摘要和 subject_id / char_id 集合按 (修改时间, 大小) 缓存：几百张图时列表接口、反向索引
        # 不必每次把全部 JSON 读一遍。
        # skip_bad=True（建反向索引）：读不出来的图记进 skipped（图 id + 原因），其他图照常；坏图的结果同样按
        # (修改时间, 大小) 缓存，文件没变就不重读，文件改好了下次扫描自然恢复。
        out, skipped, seen = [], [], set()
        for path in sorted(self.dir().glob("*.json")):
            try:
                st = path.stat()
            except FileNotFoundError:
                continue
            key = (st.st_mtime_ns, st.st_size)
            seen.add(path.stem)
            hit = self._summaries.get(path.stem)
            if hit and hit[0] == key:
                out.append(hit[1:])
                continue
            if skip_bad:
                bad = self._bad.get(path.stem)
                if bad and bad[0] == key:
                    skipped.append({"id": path.stem, "reason": bad[1]})
                    continue
            try:
                data = self._get(path.stem)
            except StorageError as e:
                if not skip_bad:
                    raise
                if not isinstance(e.__cause__, OSError):      # 读文件本身出错（权限、占用）可能是暂时的，不缓存
                    self._bad[path.stem] = (key, e.message)
                skipped.append({"id": path.stem, "reason": e.message})
                continue
            self._bad.pop(path.stem, None)
            if data is not None:
                subj, chars = _ids(data)
                self._summaries[path.stem] = (key, summary(data), subj, chars)
                out.append(self._summaries[path.stem][1:])
        for stale in set(self._summaries) - seen:
            del self._summaries[stale]
        for stale in set(self._bad) - seen:
            del self._bad[stale]
        # 导图的来源标记（collection.source）：manual = 手工整理的导图，batch = 批量生成的导图，
        # outsetter = 在出题器里新建的导图。列表按这个顺序排，别的取值排最后。
        priority = {"manual": 0, "batch": 1, "outsetter": 2}
        out.sort(key=lambda e: (priority.get(e[0]["source"], 3), e[0]["group"] or "", e[0]["title"], e[0]["id"]))
        return out, skipped

    def index(self) -> MapIndex:
        """反向索引（作品 subject_id → 图、角色 char_id → 图）。全部文件的 (id, mtime, size) 没变就复用上一份。
        文件名不合规、JSON 损坏、内容校验不过的图不会拖垮索引：跳过，记在 index.skipped 里。"""
        with self._locked():
            entries, skipped = self._scan(skip_bad=True)
            version = (tuple((e[0]["id"], self._summaries[e[0]["id"]][0]) for e in entries),
                       tuple((s["id"], s["reason"]) for s in skipped))
            if self._index is None or self._index[0] != version:
                self._index = (version, MapIndex(entries, skipped))
            return self._index[1]

    def _write(self, map_id: str, data: dict, edited: bool) -> dict:
        """edited=True：用户的编辑（新建、改数据、改名）→ 更新 edited_at；False（只改布局缓存）→ 保持原样。"""
        now = now_iso()
        data = {**data, "id": map_id, "updated_at": now}
        if edited:
            data["edited_at"] = now
        elif not isinstance(data.get("edited_at"), str):
            data.pop("edited_at", None)
        self._save(self._path(map_id), _encode(data))
        return summary(data)

    @staticmethod
    def _save(path: Path, raw: bytes) -> None:
        tmp = path.with_suffix(".json.tmp")
        with tmp.open("wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def _insert(self, map_id: str, data: Any) -> bool:
        """把一张现成的图按给定 id 放进库（调用方持有锁），updated_at、edited_at 保持图里原来的值。
        库里已经有这个 id 的图时什么都不写，返回 False；写入了返回 True。"""
        path = self._path(map_id)
        if path.exists():
            return False
        data = {**validate(data), "id": map_id}
        if not isinstance(data.get("updated_at"), str):
            raise StorageError("导图缺少 updated_at")
        self._save(path, _encode(data))
        return True

    def create(self, data: Any) -> dict:
        data = validate(data)
        with self._locked():
            map_id = "m_" + secrets.token_hex(6)
            while self._path(map_id).exists():
                map_id = "m_" + secrets.token_hex(6)
            return self._write(map_id, data, edited=True)

    def patch(self, map_id: str, changes: Any) -> dict:
        if not isinstance(changes, dict) or not changes or set(changes) - {"title", "layout_cache"}:
            raise StorageError("只支持修改 title、layout_cache，至少提供一项")
        with self._locked():
            data = self._get(map_id)
            if data is None:
                raise StorageError("导图不存在", 404)
            if "title" in changes:
                data["collection"]["title"] = changes["title"]
            if "layout_cache" in changes:
                data["layout_cache"] = changes["layout_cache"]
            # 改名算编辑；只改布局缓存（引擎第一次打开时自动存）不算
            return self._write(map_id, validate(data), edited="title" in changes)

    def delete(self, map_id: str) -> bool:
        path = self._path(map_id)
        with self._locked():
            try:
                path.unlink()
                return True
            except FileNotFoundError:
                return False

    def import_directory(self, directory: str, replace_origin: bool = False) -> dict:
        root = Path(directory)
        if not root.is_dir():
            raise StorageError("导入目录不存在")
        counts = {"imported": 0, "skipped": 0, "replaced": 0}
        # 整个导入持有一次锁，来源索引只建一次（每个文件都扫全库时，几百份要读几万次文件）。
        with self._locked():
            by_origin = {}
            for d in self._all():
                by_origin.setdefault(d["origin"], d["id"])
            for path in sorted(root.rglob("*.tagnote.json")):
                try:
                    with path.open("rb") as f:
                        raw = f.read(MAX_BYTES + 1)
                    if len(raw) > MAX_BYTES:
                        raise StorageError("作品集不能超过 2 MB", 413)
                    data = validate(json.loads(raw))
                    origin = data["collection"].get("origin")
                    if not _text(origin):
                        raise StorageError("导入文件必须有非空 collection.origin")
                    existing = by_origin.get(origin)
                    if existing and not replace_origin:
                        counts["skipped"] += 1
                        continue
                    map_id = existing or "m_" + hashlib.sha1(origin.encode("utf-8")).hexdigest()[:12]
                    if not existing and self._path(map_id).exists():
                        raise StorageError("导入 id 冲突，未覆盖其它来源的导图", 409)
                    self._write(map_id, data, edited=True)
                    by_origin[origin] = map_id
                    counts["replaced" if existing else "imported"] += 1
                except (OSError, ValueError, RecursionError, StorageError) as e:
                    # RecursionError：json.loads / validate 遇到上万层嵌套时抛的，不是 ValueError；也要带上文件名和已完成数量
                    raise StorageError(f"{path}：{e}；已完成 {counts}", getattr(e, "status", 400)) from e
        return counts


MAPS = MapStore()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="导入标签笔记作品集")
    commands = parser.add_subparsers(dest="command", required=True)
    imp = commands.add_parser("import")
    imp.add_argument("directory")
    imp.add_argument("--replace-origin", action="store_true")
    args = parser.parse_args(argv)
    try:
        counts = MAPS.import_directory(args.directory, args.replace_origin)
    except StorageError as e:
        parser.exit(1, str(e) + "\n")
    print(f"导入 {counts['imported']} / 跳过 {counts['skipped']} / 覆盖 {counts['replaced']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
