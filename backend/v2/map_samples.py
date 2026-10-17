"""样例导图：仓库 examples/maps/ 下的导图，按需复制进用户的导图库（data/maps_v2/）。

- 首次运行：导图库里一张图都没有、也没有标记文件 maps_v2/.samples 时，复制 examples/maps/defaults.txt
  列出的几张（一行一个 id），再写下标记文件。库里已经有图时只写标记文件。
  有了标记文件就不自动复制：用户删掉的样例不会自己回来。
- 「载入全部样例导图」：把库里还没有的样例都复制进来。库里已经有同一个 id 的图就跳过，绝不覆盖。
  删掉的样例也能这样重新载入。
- 读写都在导图库的锁里进行（和导图的增删改用同一把锁）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from ..paths import REPO_ROOT
from .maps import _ID, MAPS, MAX_BYTES
from .storage import StorageError

SAMPLES_DIR = Path(REPO_ROOT) / "examples" / "maps"
DEFAULTS_FILE = "defaults.txt"
MARKER = ".samples"
MARKER_TEXT = "首次运行时已经放过默认的样例导图。有这个文件，后端启动时就不自动放。\n"


def sample_ids() -> list[str]:
    """examples/maps/ 下全部样例的 id（文件名不合规的不算），按 id 排序。"""
    return sorted(p.stem for p in SAMPLES_DIR.glob("m_*.json") if _ID.fullmatch(p.stem))


def default_ids() -> list[str]:
    """首次运行时复制的几张：defaults.txt 里列出、且确实有这个样例文件的 id，按文件里的顺序。"""
    try:
        text = (SAMPLES_DIR / DEFAULTS_FILE).read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    have = set(sample_ids())
    return [i for i in dict.fromkeys(text.split()) if i in have]


def _read_sample(map_id: str) -> dict:
    path = SAMPLES_DIR / (map_id + ".json")
    try:
        with path.open("rb") as f:
            raw = f.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise StorageError("作品集不能超过 2 MB", 413)
        return json.loads(raw)
    except (OSError, ValueError, RecursionError) as e:
        raise StorageError(f"读取失败：{e}") from e


def _copy(ids: Iterable[str]) -> tuple[int, int]:
    """逐张复制进导图库（调用方持有锁）。返回（复制了几张，因为库里已有而跳过几张）。"""
    copied = skipped = 0
    for map_id in ids:
        try:
            done = MAPS._insert(map_id, _read_sample(map_id))
        except StorageError as e:
            raise StorageError(f"样例导图 {map_id} 没能载入：{e.message}；已载入 {copied} 张", e.status) from e
        copied += done
        skipped += not done
    return copied, skipped


def _status() -> dict:
    present = {p.stem for p in MAPS.dir().glob("*.json")}
    ids = sample_ids()
    return {"total": len(ids), "remaining": sum(1 for i in ids if i not in present)}


def status() -> dict:
    """total = 一共几张样例；remaining = 导图库里还没有的有几张（按钮上显示的数）。"""
    with MAPS._locked():
        return _status()


def seed_defaults() -> int:
    """首次运行：导图库里一张图都没有、也没有标记文件时，复制默认的几张，并写下标记文件。返回复制了几张。
    库里已经有图时只写标记文件，不复制；仓库里没有 examples/maps/ 时什么都不做。"""
    if not SAMPLES_DIR.is_dir():
        return 0
    with MAPS._locked():
        marker = MAPS.dir() / MARKER
        if marker.exists():
            return 0
        try:
            if any(MAPS.dir().glob("*.json")):
                return 0
            return _copy(default_ids())[0]
        finally:
            marker.write_text(MARKER_TEXT, encoding="utf-8")


def load_all() -> dict:
    """把导图库里还没有的样例全部复制进来；库里已有同 id 的图跳过，不覆盖。
    返回 {loaded: 这次复制了几张, skipped: 因为库里已有而跳过几张, total, remaining}。"""
    with MAPS._locked():
        copied, skipped = _copy(sample_ids())
        return {"loaded": copied, "skipped": skipped, **_status()}
