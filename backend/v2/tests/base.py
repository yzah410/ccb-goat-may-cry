# -*- coding: utf-8 -*-
"""测试公共设置：合成库 + 临时清单 / 方案目录 + 临时配置文件。必须在导入 backend.v2.router 之前导入本模块（它会设置环境变量）。"""
from __future__ import annotations

import atexit
import os
import shutil
import tempfile

TMP = tempfile.mkdtemp(prefix="v2test_")
DB = os.path.join(TMP, "synthetic.sqlite")
DATA = os.path.join(TMP, "data")
# 配置文件换成临时目录里的 config.json：文件不存在时读 config.example.json；改设置的测试写到这里，不碰真实的 backend/config.json
CONFIG = os.path.join(TMP, "config.json")
os.environ["OUTSETTER_V2_DB"] = DB
os.environ["OUTSETTER_V2_DATA_DIR"] = DATA
os.environ["OUTSETTER_CONFIG"] = CONFIG
os.environ.pop("OUTSETTER_AI_API_KEY", None)       # 本机设置了这个环境变量也不影响测试
atexit.register(lambda: shutil.rmtree(TMP, ignore_errors=True))

from . import synth  # noqa: E402

synth.build(DB)

from backend.v2 import engine  # noqa: E402
from backend.v2.spec import parse_spec  # noqa: E402
from backend.v2.storage import LISTS  # noqa: E402
from backend.v2.store import HUB  # noqa: E402

LISTS.save({"name": "测试标签清单", "kind": "tag", "items": ["百合", "日常", "战斗"]}, list_id="l_t")
LISTS.save({"name": "测试角色清单", "kind": "character", "items": [{"id": 1, "name": "角色一"}, {"id": 5}, {"id": 99}]},
           list_id="l_c")
LISTS.save({"name": "测试作品清单", "kind": "work", "items": [{"id": 101}, {"name": "恋爱番"}]}, list_id="l_w")


def rng(**src) -> dict:
    """rank 来源的小工具：rng(year_from=2024, year_to=2024, rank_to=None)。"""
    s = {"kind": "rank", "subject_types": [2], "year_from": 2024, "year_to": 2024, "rank_from": 1, "rank_to": 50,
         "rank_scope": "merged"}
    s.update(src)
    return s


def spec(ranges=None, excludes=None, mode="anime", n=6, method="per_character") -> dict:
    return {"version": 2, "game": {"mode": mode, "tag_count": n}, "ranges": ranges if ranges is not None else [],
            "excludes": excludes or [], "draw": {"method": method, "seed": None}}


def one(source=None, pick=None, conditions=None, **kw) -> dict:
    r = {"source": source or rng(), "conditions": conditions or []}
    if pick is not None:
        r["pick"] = pick
    r.update(kw)
    return r


def ev(sp: dict):
    return engine.evaluate(parse_spec(sp), use_cache=False)


def pool(sp: dict) -> set:
    return set(ev(sp).pool)


# 条件测试的基准范围：2024 年全部动画的主角和配角，不限每部人数
# = 101 的 c1 c2 c3 c13-c17 + 102 的 c4 c5 + 104 的 c6 = 11 人
BASE_SRC = rng(rank_to=None)
BASE_PICK = {"roles": ["主角", "配角"], "per_work": None, "order": "heat"}
BASE_POOL = {1, 2, 3, 13, 14, 15, 16, 17, 4, 5, 6}


def base_with(*conds, n=6, mode="anime") -> dict:
    return spec([one(BASE_SRC, BASE_PICK, list(conds))], n=n, mode=mode)


def all_with(*conds, n=6) -> dict:
    return spec([one({"kind": "all_characters"}, None, list(conds))], n=n)
