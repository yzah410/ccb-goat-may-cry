# -*- coding: utf-8 -*-
"""SpecV2 的 Pydantic 模型：缺字段补默认值，错误信息翻成中文。

入口：
- `parse_spec(raw) -> SpecV2`：校验 + 补默认值；不合格抛 SpecError（.messages 是中文错误列表）。
- `default_spec() -> dict`：打开工作台时的默认方案（年份按当天算）。
- `spec_to_dict(spec)`：输出 JSON（保留前端 / AI 带来的额外字段）。
"""
from __future__ import annotations

import datetime as _dt
import secrets
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

ModeId = Literal["anime", "game", "book", "real", "all"]
Role = Literal["主角", "配角"]
AppRole = Literal["主角", "配角", "客串"]
Quant = Literal["any", "all", "at_least", "none"]
VALID_TYPES = {1, 2, 3, 4, 6}


def gen_id(prefix: str) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return prefix + "".join(secrets.choice(alphabet) for _ in range(5))


def this_year() -> int:
    return _dt.date.today().year


def default_year_from() -> int:
    return this_year() - 10


class _Base(BaseModel):
    model_config = ConfigDict(extra="allow")


# ---------------------------------------------------------------- 标签筛选
class TagFilter(_Base):
    quant: Quant = "any"
    k: Optional[int] = None
    tags: List[str] = Field(default_factory=list)
    tag_list_id: Optional[str] = None
    # main = 标注数 ≥ 该作品最高标签的 10%（默认）；any = 有人打过就算；
    # meta = Bangumi 公共标签（游戏的 Galgame 模式按公共标签筛）
    tag_mode: Literal["main", "any", "meta"] = "main"

    @field_validator("tags", mode="before")
    @classmethod
    def _tags(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            v = [x for x in v.replace("，", ",").replace("、", ",").split(",")]
        if isinstance(v, list):
            out, seen = [], set()
            for x in v:
                if not isinstance(x, str):
                    x = str(x)
                x = x.strip()
                if x and x not in seen:
                    seen.add(x)
                    out.append(x)
            return out
        return v

    @field_validator("k")
    @classmethod
    def _k(cls, v):
        if v is not None and v < 0:
            raise ValueError("k 不能是负数")
        return v


# ---------------------------------------------------------------- 对局设置 / 抽题 / meta
class GameSettings(_Base):
    mode: ModeId = "anime"
    tag_count: int = Field(6, ge=0, le=10)


class DrawSettings(_Base):
    method: Literal["per_character", "per_work", "range_share"] = "per_character"
    seed: Optional[int] = None


class SpecMeta(_Base):
    name: Optional[str] = None
    note: Optional[str] = None
    created: Optional[str] = None
    updated: Optional[str] = None


# ---------------------------------------------------------------- 来源
class RankSource(_Base):
    kind: Literal["rank"] = "rank"
    subject_types: List[int] = Field(default_factory=lambda: [2])
    year_from: Optional[int] = Field(default_factory=default_year_from)
    year_to: Optional[int] = Field(default_factory=this_year)
    rank_from: int = Field(1, ge=1)
    rank_to: Optional[int] = 50
    rank_scope: Literal["merged", "per_year"] = "merged"
    work_filter: Optional[TagFilter] = None
    # 默认 false = 和游戏一样，不算「今天还没上映」的条目
    include_unaired: bool = False
    # work_filter 什么时候生效。before_rank = 先按作品标签筛、再排名（默认，和游戏 Galgame 模式一样）；
    # after_rank = 先排名取前 N 部、再筛
    work_filter_order: Literal["before_rank", "after_rank"] = "before_rank"

    @field_validator("subject_types")
    @classmethod
    def _types(cls, v):
        if not v:
            raise ValueError("至少要选一种条目类型")
        bad = [x for x in v if x not in VALID_TYPES]
        if bad:
            raise ValueError(f"条目类型只能是 1 书籍 / 2 动画 / 3 音乐 / 4 游戏 / 6 三次元，收到 {bad}")
        return sorted(set(v))

    @model_validator(mode="after")
    def _ranges(self):
        if self.year_from is not None and self.year_to is not None and self.year_from > self.year_to:
            raise ValueError(f"起始年份 {self.year_from} 比结束年份 {self.year_to} 还晚")
        if self.rank_to is not None and self.rank_to < self.rank_from:
            raise ValueError(f"热度排名终点 {self.rank_to} 比起点 {self.rank_from} 还小")
        return self


class WorkListSource(_Base):
    kind: Literal["work_list"]
    list_id: str


class CharListSource(_Base):
    kind: Literal["char_list"]
    list_id: str


class AllCharactersSource(_Base):
    kind: Literal["all_characters"]


Source = Annotated[Union[RankSource, WorkListSource, CharListSource, AllCharactersSource], Field(discriminator="kind")]


class Pick(_Base):
    """每部作品取哪些角色。

    - per_work：每部最多几人，null = 不限。**没给这个字段时**按游戏的默认：只要主角 → 不限（游戏「仅主角」不截断，
      见上游 client/src/utils/bangumi.js 第 575–577 行，上游仓库见 NOTICE.md）；带配角 → 6（游戏的 characterNum 默认值）。
    - order：'heat' = 按角色热度；'game' = 和游戏一样（角色 id 从小到大：/v0/subjects/{id}/characters 就是这个顺序，
      游戏按它截取前 N 个）。'bangumi' 是 'game' 的别名，同样接受。
    """
    roles: List[Role] = Field(default_factory=lambda: ["主角"])
    per_work: Optional[int] = Field(None, ge=1)
    order: Literal["heat", "game"] = "heat"

    @model_validator(mode="before")
    @classmethod
    def _defaults(cls, v):
        if isinstance(v, dict):
            v = dict(v)
            if v.get("order") == "bangumi":
                v["order"] = "game"
            if "per_work" not in v:
                roles = v.get("roles") or ["主角"]
                v["per_work"] = None if list(roles) == ["主角"] else 6
        return v

    @field_validator("roles")
    @classmethod
    def _roles(cls, v):
        if not v:
            raise ValueError("至少要选一种身份（主角 / 配角）")
        order = {"主角": 0, "配角": 1}
        return sorted(set(v), key=lambda x: order[x])


# ---------------------------------------------------------------- 条件
class CondBase(_Base):
    id: str = Field(default_factory=lambda: gen_id("c_"))
    enabled: bool = True
    negate: bool = False


class _MinMax(CondBase):
    min: Optional[float] = None
    max: Optional[float] = None

    @model_validator(mode="after")
    def _mm(self):
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError(f"下限 {self.min:g} 比上限 {self.max:g} 还大")
        return self


class GenderCond(CondBase):
    type: Literal["gender"]
    values: List[Literal["男", "女", "未知"]] = Field(default_factory=list)


class CharHeatCond(_MinMax):
    type: Literal["char_heat"]


class GameTagsCond(CondBase, TagFilter):
    type: Literal["game_tags"]


class CharTagsCond(CondBase, TagFilter):
    type: Literal["char_tags"]


class VaCond(CondBase):
    type: Literal["va"]
    names: List[str] = Field(default_factory=list)


class SourceTagCond(CondBase):
    type: Literal["source_tag"]
    values: List[str] = Field(default_factory=list)


class NumCond(_MinMax):
    type: Literal["n_app", "earliest_year", "latest_year", "rating"]


class AppearanceCond(CondBase):
    type: Literal["appearance"]
    subject_types: Optional[List[int]] = None
    year_from: Optional[int] = None
    year_to: Optional[int] = None
    roles: Optional[List[AppRole]] = None
    work_tags: Optional[TagFilter] = None
    work_list_id: Optional[str] = None

    @field_validator("subject_types")
    @classmethod
    def _types(cls, v):
        if v is None:
            return v
        bad = [x for x in v if x not in VALID_TYPES]
        if bad:
            raise ValueError(f"条目类型只能是 1 书籍 / 2 动画 / 3 音乐 / 4 游戏 / 6 三次元，收到 {bad}")
        return sorted(set(v))

    @model_validator(mode="after")
    def _years(self):
        if self.year_from is not None and self.year_to is not None and self.year_from > self.year_to:
            raise ValueError(f"起始年份 {self.year_from} 比结束年份 {self.year_to} 还晚")
        return self


class CharListCond(CondBase):
    type: Literal["char_list"]
    list_id: str


class SqlCond(CondBase):
    type: Literal["sql"]
    sql: str
    label: Optional[str] = None


Condition = Annotated[
    Union[GenderCond, CharHeatCond, GameTagsCond, CharTagsCond, VaCond, SourceTagCond, NumCond,
          AppearanceCond, CharListCond, SqlCond],
    Field(discriminator="type"),
]
COND_TYPES = ["gender", "char_heat", "game_tags", "char_tags", "va", "source_tag", "n_app", "earliest_year",
              "latest_year", "rating", "appearance", "char_list", "sql"]


# ---------------------------------------------------------------- 范围 / 方案
class RangeV2(_Base):
    id: str = Field(default_factory=lambda: gen_id("r_"))
    enabled: bool = True
    label: Optional[str] = None
    share: Optional[float] = Field(None, ge=0)
    source: Source = Field(default_factory=RankSource)
    pick: Pick = Field(default_factory=Pick)
    conditions: List[Condition] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _fill(cls, v):
        if isinstance(v, dict):
            v = dict(v)
            src = v.get("source")
            if src is None:
                v.pop("source", None)
            elif isinstance(src, dict) and "kind" not in src:
                src = dict(src)
                src["kind"] = "rank"
                v["source"] = src
            if v.get("pick") is None:
                v.pop("pick", None)
            if v.get("conditions") is None:
                v.pop("conditions", None)
            if not v.get("id"):
                v.pop("id", None)
        return v


class SpecV2(_Base):
    version: Literal[2] = 2
    game: GameSettings = Field(default_factory=GameSettings)
    ranges: List[RangeV2] = Field(default_factory=lambda: [RangeV2(id="r_default")])
    excludes: List[RangeV2] = Field(default_factory=list)
    draw: DrawSettings = Field(default_factory=DrawSettings)
    meta: Optional[SpecMeta] = None

    @model_validator(mode="before")
    @classmethod
    def _fill(cls, v):
        if isinstance(v, dict):
            v = dict(v)
            for k in ("game", "draw"):
                if v.get(k) is None:
                    v.pop(k, None)
            if v.get("excludes") is None:
                v.pop("excludes", None)
            if v.get("version") in (None, "2"):
                v["version"] = 2
        return v

    @model_validator(mode="after")
    def _unique_ids(self):
        seen = set()
        for i, r in enumerate(list(self.ranges) + list(self.excludes)):
            if r.id in seen:
                r.id = gen_id("r_")
            seen.add(r.id)
            cseen = set()
            for c in r.conditions:
                if c.id in cseen:
                    c.id = gen_id("c_")
                cseen.add(c.id)
        return self


# ---------------------------------------------------------------- 默认方案
def default_range(rid: str = "r_default") -> Dict[str, Any]:
    y = this_year()
    return {"id": rid, "enabled": True, "label": None, "share": None,
            "source": {"kind": "rank", "subject_types": [2], "year_from": y - 10, "year_to": y,
                       "rank_from": 1, "rank_to": 50, "rank_scope": "merged", "work_filter": None},
            "pick": {"roles": ["主角"], "per_work": None, "order": "heat"},
            "conditions": []}


def default_spec() -> Dict[str, Any]:
    return {"version": 2,
            "game": {"mode": "anime", "tag_count": 6},
            "ranges": [default_range()],
            "excludes": [],
            "draw": {"method": "per_character", "seed": None}}


# ---------------------------------------------------------------- 中文错误
_FIELD_ZH = {
    "version": "版本号", "game": "对局设置", "mode": "模式", "tag_count": "标签数",
    "ranges": "范围", "excludes": "排除", "draw": "抽题", "method": "抽题方式", "seed": "随机种子",
    "meta": "方案信息", "source": "从哪来", "pick": "取角色", "conditions": "条件",
    "subject_types": "条目类型", "year_from": "起始年份", "year_to": "结束年份",
    "rank_from": "热度排名起点", "rank_to": "热度排名终点", "rank_scope": "排名方式",
    "work_filter": "作品本身的标签", "include_unaired": "是否算未上映作品", "work_filter_order": "作品标签筛选的先后",
    "list_id": "清单", "roles": "身份", "per_work": "每部人数", "order": "排序方式",
    "quant": "量词", "k": "k（至少几个）", "tags": "标签", "tag_list_id": "标签清单", "tag_mode": "标签口径",
    "values": "取值", "names": "声优", "min": "下限", "max": "上限", "work_tags": "作品标签",
    "work_list_id": "作品清单", "sql": "SQL", "label": "名字", "share": "占比", "enabled": "启用",
    "negate": "取反", "id": "编号", "kind": "来源类型", "type": "条件类型", "name": "名字", "note": "备注",
}
_TAG_ZH = {"rank": "", "work_list": "", "char_list": "", "all_characters": ""}


def _loc_zh(loc) -> str:
    parts: List[str] = []
    i = 0
    loc = list(loc)
    while i < len(loc):
        x = loc[i]
        prev = loc[i - 1] if i > 0 else None
        if x in ("ranges", "excludes", "conditions") and i + 1 < len(loc) and isinstance(loc[i + 1], int):
            parts.append(f"{_FIELD_ZH[x]} {loc[i + 1] + 1}")
            i += 2
            continue
        # pydantic 会把判别字段的取值（'rank'、'game_tags'…）塞进路径里，跳过
        if prev == "source" and x in _TAG_ZH:
            i += 1
            continue
        if isinstance(prev, int) and i >= 2 and loc[i - 2] == "conditions" and x in COND_TYPES:
            i += 1
            continue
        if isinstance(x, int):
            parts.append(f"第 {x + 1} 项")
        else:
            parts.append(_FIELD_ZH.get(x, str(x)))
        i += 1
    return " · ".join(p for p in parts if p)


def _err_zh(e: Dict[str, Any]) -> str:
    t = e.get("type", "")
    ctx = e.get("ctx") or {}
    msg = e.get("msg", "")
    if t == "missing":
        return "缺少这一项"
    if t == "literal_error":
        return f"只能是 {ctx.get('expected', '')}".replace(" or ", " 或 ")
    if t in ("int_parsing", "int_type", "int_from_float"):
        return "要填整数"
    if t in ("float_parsing", "float_type"):
        return "要填数字"
    if t in ("bool_parsing", "bool_type"):
        return "要填 true 或 false"
    if t in ("string_type",):
        return "要填文字"
    if t in ("list_type",):
        return "要填列表"
    if t in ("model_type", "dict_type", "model_attributes_type"):
        return "格式不对（这里要一个对象）"
    if t == "greater_than_equal":
        return f"不能小于 {ctx.get('ge')}"
    if t == "less_than_equal":
        return f"不能大于 {ctx.get('le')}"
    if t == "greater_than":
        return f"要大于 {ctx.get('gt')}"
    if t == "union_tag_invalid":
        return f"类型「{ctx.get('tag')}」不认识，只能是 {ctx.get('expected_tags')}"
    if t == "union_tag_not_found":
        return f"缺少类型字段 {ctx.get('discriminator')}"
    if t == "value_error":
        return msg.replace("Value error, ", "")
    if t == "assertion_error":
        return msg.replace("Assertion failed, ", "")
    return msg


class SpecError(Exception):
    def __init__(self, messages: List[str]):
        self.messages = messages
        super().__init__("；".join(messages))


def zh_messages(exc: ValidationError) -> List[str]:
    out = []
    for e in exc.errors():
        where = _loc_zh(e.get("loc", ()))
        what = _err_zh(e)
        out.append(f"{where}：{what}" if where else what)
    # 去重保序
    seen, res = set(), []
    for m in out:
        if m not in seen:
            seen.add(m)
            res.append(m)
    return res


def parse_spec(raw: Any) -> SpecV2:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise SpecError(["方案要是一个 JSON 对象"])
    try:
        return SpecV2.model_validate(raw)
    except ValidationError as e:
        raise SpecError(zh_messages(e)) from None


def spec_to_dict(spec: SpecV2) -> Dict[str, Any]:
    return spec.model_dump(mode="json")
