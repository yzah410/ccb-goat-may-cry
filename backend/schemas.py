from __future__ import annotations
from typing import List, Literal, Optional, Dict, Any
from pydantic import BaseModel, Field, field_validator

# ---- 前端传入的“标签小组块”的元素 ----
class TagItem(BaseModel):
    name: str
    kind: Literal["work", "char", "va", "source"]  # source 仅在 char-range 中生效
    color: Literal["red", "blue"]  # 红=必须含，蓝=必须不含

class TagGroup(BaseModel):
    items: List[TagItem]

def _normalize_tag_groups(v):
    """
    接受下面几种传参形态，统一成第 1 种：
    1) [{items:[TagItem,...]}, ...]  -> 标准形态
    2) [[TagItem,...], [TagItem,...]] -> 包装为 [{items:[...]}, {items:[...]}]
    3) [TagItem,...] (单组) -> 包装为 [{items:[...]}]
    4) None / 空 -> []
    """
    if v is None:
        return []
    if isinstance(v, list):
        if not v:
            return []
        # 情形2：列表的列表
        if isinstance(v[0], list):
            return [{"items": grp} for grp in v]
        # 情形1或3：要么是 [{items:[...]}, ...]，要么是 [TagItem,...]
        if isinstance(v[0], dict) and "items" in v[0]:
            return v  # 已是期望形态
        # 视为“单组的 TagItem 列表”
        return [{"items": v}]
    # 其他类型原样返回，由 Pydantic 校验
    return v

# ---- 四类组块的参数 ----
class WorkRangeBlock(BaseModel):
    years: List[int]  # [Ymin, Ymax]
    tag_groups: List[TagGroup] = Field(default_factory=list)  # 只看 work 标签；只有蓝标签的组 = 范围里不含这些标签的作品（组之间是「或」）

    # 收藏名次：两次二选一交叉 → 四种模式
    rank_basis: Literal["per_year", "merged"]
    rank_value_kind: Literal["rank", "percent"]  # 名次值 or 百分比
    rank_lo: float
    rank_hi: float

    # 每作品角色量
    roles_scope: Literal["main", "all"]  # main = 仅主角(type:1), all = 主+配(type:1|2)
    role_rank_kind: Literal["rank", "percent"]
    role_rank_lo: float
    role_rank_hi: float

    @field_validator("tag_groups", mode="before")
    @classmethod
    def _coerce_tag_groups(cls, v):
        return _normalize_tag_groups(v)

class WorkListBlock(BaseModel):
    work_lines: str  # 多行文本
    roles_scope: Optional[Literal["main", "all"]] = None  # 红块才会用到
    role_rank_kind: Optional[Literal["rank", "percent"]] = None
    role_rank_lo: Optional[float] = None
    role_rank_hi: Optional[float] = None

class CharListBlock(BaseModel):
    char_lines: str

class CharRangeBlock(BaseModel):
    earliest_year: Optional[List[int]] = None  # [min,max]
    latest_year: Optional[List[int]] = None
    genders: Optional[List[Literal["?", "♂", "♀"]]] = None
    max_score: Optional[List[float]] = None  # [min,max]
    tag_groups: List[TagGroup] = Field(default_factory=list)  # 可混用 work/char/va/source；只有蓝标签的组 = 不含这些标签的角色（组之间是「或」）
    appear_works: Optional[List[int]] = None  # 至少在这些作品中登场一次

    @field_validator("tag_groups", mode="before")
    @classmethod
    def _coerce_tag_groups(cls, v):
        return _normalize_tag_groups(v)

# ---- 组块定义 ----
class Block(BaseModel):
    id: str
    kind: Literal["work-range", "work-list", "char-list", "char-range"]
    color: Literal["red", "blue"]
    weight: float = 1.0  # 仅红块使用（角色权重取 max；作品权重用于角色→作品聚合）
    enabled: bool = True
    params: Dict[str, Any]

# ---- 配置保存 ----
class ConfigPayload(BaseModel):
    mode: Literal["char-weight", "work-weight"]
    seed: Optional[int] = None
    theme: Optional[str] = None
    blocks: List[Block]

    # 是否把 additional_work_tags 视为作品标签的一部分
    include_extra_work_tags: bool = False

# ---- 预览/抽题响应 ----
class PreviewResp(BaseModel):
    total_candidates: int
    sample: List[Dict[str, Any]]

class DrawResp(BaseModel):
    mode: Literal["char-weight", "work-weight"]
    char_id: Optional[int]
    character: Optional[Dict[str, Any]]
    bound_work_id: Optional[int] = None
    bound_work: Optional[Dict[str, Any]] = None

    # 登场汇总
    appear_count: Optional[int] = None
    appear_best: Optional[Dict[str, Any]] = None  # {id,name,year,favorites}

    # characters_db 里的登场统计
    work_count: Optional[int] = None               # work_count（登场动画作品数）
    appearances: Optional[List[str]] = None        # appearances（登场作品名列表）

    # 标签
    source_tag: Optional[str] = None                 # 原作来源（单个字符串）
    playback_tags: Optional[List[str]] = None        # 播放形式标签（TV/剧场版/OVA/WEB/动态漫画）多选
    work_tags: Optional[List[str]] = None            # 角色“包含的作品标签”的全集（去重）
    char_tags: Optional[List[str]] = None            # 角色标签全集（去重）

# -------------------- Candidates API --------------------
class CandidateItem(DrawResp):
    weight: float

class CandidatesReq(BaseModel):
    config: ConfigPayload
    page: int = 1
    page_size: int = 10
    sort_mode: str = "time"  # 只支持 "time"（按时间排序）

class CandidatesResp(BaseModel):
    total: int
    page: int
    page_size: int
    items: List[CandidateItem]
