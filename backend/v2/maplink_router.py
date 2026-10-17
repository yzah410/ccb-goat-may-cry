# -*- coding: utf-8 -*-
"""/v2/maplink 接口：导图 × 单人猜猜呗联动（预选、图组存储）。逻辑在 maplink.py。

- POST /v2/maplink/preselect          {spec? | plan_name?, cap?=8, target?=0.95} -> 预选结果
- GET  /v2/maplink/sets/{plan_key}    -> {plan_key, map_ids, updated_at}；没存过 404
- PUT  /v2/maplink/sets/{plan_key}    {map_ids} -> 同上（plan_key 只能是 workbench 或 plan:<方案名>）
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Body

from .maplink import SETS, preselect
from .router import _err, _guard
from .solo.feedback import SoloError
from .solo.router import _solo
from .spec import parse_spec
from .storage import PLANS, StorageError
from .store import with_snapshot

router = APIRouter(prefix="/v2/maplink", tags=["导图联动"])


def _spec_of(body: Dict[str, Any]):
    """spec 和 plan_name 二选一：给了 spec 就用它（和单人猜猜呗建会话一样，plan_name 只是个名字）；
    只给 plan_name 就读已保存的方案。两个都没给 422。已保存的方案不存在 → None。"""
    if body.get("spec") is not None:
        return parse_spec(body["spec"])
    name = body.get("plan_name")
    if name is None:
        raise SoloError(422, "bad_field", "要给 spec 或 plan_name 其中一个")
    if not isinstance(name, str):
        raise SoloError(422, "bad_field", "方案名（plan_name）要是文字")
    data = PLANS.get(name)
    return None if data is None else parse_spec(data)


@router.post("/preselect")
@_guard
@_solo
def maplink_preselect(body: Dict[str, Any] = Body(...)):
    """按方案预选一组导图（贪心，覆盖方案里几乎所有题）。返回 {pool_total, picked, covered, maps, uncovered, pool,
    no_map, no_map_ids, skipped, errors, warnings}；maps[].covers 是这张图覆盖的角色 id，前端勾选增删时用它本地重算覆盖；
    skipped 是读不出来、被跳过的坏图 [{id, reason}]（一张图坏了不影响其他图预选）。"""
    spec = _spec_of(body)
    if spec is None:
        return _err(404, "not_found", f"方案「{body.get('plan_name')}」不存在")
    return with_snapshot(lambda snap: preselect(snap, spec, body.get("cap"), body.get("target")))


@router.get("/sets/{plan_key}")
@_guard
def maplink_set_get(plan_key: str):
    d = SETS.get(plan_key)
    if d is None:
        return _err(404, "not_found", "这个方案还没有存过联动图组")
    return d


@router.put("/sets/{plan_key}")
@_guard
def maplink_set_put(plan_key: str, body: Dict[str, Any] = Body(...)):
    if body.get("plan_key") not in (None, plan_key):
        raise StorageError("请求体里的 plan_key 和地址里的不一致", 422)
    return SETS.put(plan_key, body.get("map_ids"))
