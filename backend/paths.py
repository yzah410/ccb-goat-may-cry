"""配置与路径解析。

统一入口：`load_config()`，读 backend/config.json；没有就退回 config.example.json。
环境变量 OUTSETTER_CONFIG 只给测试用：把 config.json 换成一个临时文件，读写都不碰真实配置。

配置里的相对路径按仓库根解析（例如 v2.db_path 写 "data/outsetter_v2.sqlite"，
由 backend/v2/settings.py 用 REPO_ROOT 拼成绝对路径）。

经典工作台数据放在 classic.data_dir（默认 data/classic/），文件名固定，见 CLASSIC_FILES。
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

# 仓库根 = backend/ 的上一级
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BACKEND_DIR)
CONFIG_ENV = "OUTSETTER_CONFIG"

# 经典工作台数据目录（相对仓库根），可用配置 classic.data_dir 改
CLASSIC_DEFAULT_DIR = "data/classic"

# 经典工作台数据目录里的文件名。CLASSIC_REQUIRED 里的缺一个，经典工作台就不加载；
# 其余的缺了也能加载，只是少一部分标签信息（character_source_counts 缺失时后端会在日志里提示）。
CLASSIC_FILES: Dict[str, str] = {
    "characters_db": "characters_db.ndjson",
    "subject": "subject.jsonlines",
    "subject_characters": "subject-characters.jsonlines",
    "work_tags_valid": "work-tags.valid.ndjson",
    "character_source_counts": "character_source_counts.json",
}
CLASSIC_REQUIRED = ("characters_db", "subject", "subject_characters")


def resolve(path: str) -> str:
    """相对路径按仓库根解析；绝对路径原样返回。"""
    if not path:
        return path
    path = os.path.expanduser(path)
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(REPO_ROOT, path))


def classic_dir(cfg: Dict[str, Any]) -> str:
    """经典工作台数据目录的绝对路径。"""
    return resolve((cfg.get("classic") or {}).get("data_dir") or CLASSIC_DEFAULT_DIR)


def classic_paths(cfg: Dict[str, Any]) -> Dict[str, str]:
    """经典工作台数据各文件的绝对路径（文件不一定存在）。"""
    root = classic_dir(cfg)
    return {key: os.path.join(root, name) for key, name in CLASSIC_FILES.items()}


def classic_missing(cfg: Dict[str, Any]) -> List[str]:
    """缺少的必需文件名；空列表表示经典工作台数据齐全。"""
    paths = classic_paths(cfg)
    return [CLASSIC_FILES[k] for k in CLASSIC_REQUIRED if not os.path.isfile(paths[k])]


def config_file() -> str:
    """config.json 的位置（文件不一定存在）。"""
    return os.environ.get(CONFIG_ENV) or os.path.join(BACKEND_DIR, "config.json")


def example_config_file() -> str:
    return os.path.join(BACKEND_DIR, "config.example.json")


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    """读取配置。config.json 缺失时回落到 config.example.json。"""
    if path is None:
        path = config_file()
        if not os.path.exists(path):
            path = example_config_file()

    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    cfg["_config_path"] = path
    cfg["data_paths"] = classic_paths(cfg)
    return cfg


def describe(cfg: Dict[str, Any]) -> str:
    """启动日志里打印用了哪个配置文件，以及经典工作台数据放在哪、齐不齐。"""
    missing = classic_missing(cfg)
    state = "齐全" if not missing else "缺 " + "、".join(missing)
    return f"config: {cfg.get('_config_path')}\n经典工作台数据: {classic_dir(cfg)}（{state}）"
