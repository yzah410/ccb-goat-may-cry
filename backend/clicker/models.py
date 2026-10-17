# -*- coding: utf-8 -*-
"""点击器的状态 / 日志 / 请求 / 结果模型（pydantic v2）。

调用方只需要看 API.md；这里是字段的唯一真相来源。
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

Mode = Literal["host"]          # 房主出题
# 步骤：idle → locating → typing → selecting → confirming → done / error。
# 取消 / 关服相关的三个状态：cancelling（已发出取消，等协程真正停下；busy 仍为 true）、
#                                 stuck（取消后超过宽限期还没停下，已自动重置浏览器连接；停下之前拒绝新任务）、
#                                 closed（后端正在退出 / 已退出，任务被中止）
ClickState = Literal["idle", "locating", "typing", "selecting", "confirming", "done", "error",
                     "cancelling", "stuck", "closed"]
LogLevel = Literal["debug", "info", "warn", "error"]
# 路径：直接搜角色 / 先搜作品再在作品角色列表里选
PathKind = Literal["char_search", "subject"]
# 依据：页面里凭什么认定「这一项就是目标」
Evidence = Literal["resp_id", "react_key", "img_id", "text", "planned"]


class LogEntry(BaseModel):
    ts: float                       # Unix 秒（带小数）
    level: LogLevel
    msg: str


class TargetView(BaseModel):
    """当前目标角色（给 UI 显示用）。"""
    char_id: Optional[int] = None
    name: Optional[str] = None      # Bangumi 原名（游戏结果项第一行显示的就是它）
    name_cn: Optional[str] = None   # 简体中文名（结果项第二行）
    work_hint: Optional[str] = None


class PlanOption(BaseModel):
    """一条候选路径的离线预测（用 Bangumi API 算出来的）。"""
    path: PathKind
    keyword: str                    # 输入框里要打的字
    keyword_label: str              # 关键词来源：name / name+cn / cn / alias / ds_name / ds_name_jp / work_hint ...
    index: Optional[int] = None     # 目标在结果里的 0 基位置（char_search）或在作品角色列表里的位置（subject）
    more_clicks: int = 0            # 需要点几次「更多」
    subject_id: Optional[int] = None
    subject_name: Optional[str] = None
    subject_index: Optional[int] = None   # 作品在「搜作品」结果里的位置
    cost: float = 0.0               # 估算耗时（秒），越小越优先
    note: Optional[str] = None


class LocateResult(BaseModel):
    """一次定位 / 点击的结果；dry_run 也返回它。"""
    ok: bool
    dry_run: bool = False
    mode: Optional[Mode] = None
    char_id: Optional[int] = None
    path: Optional[PathKind] = None
    keyword: Optional[str] = None
    keyword_label: Optional[str] = None
    index: Optional[int] = None     # 0 基
    nth: Optional[int] = None       # 1 基，「第 N 项」
    more_clicks: int = 0
    subject_id: Optional[int] = None
    subject_name: Optional[str] = None
    evidence: Optional[Evidence] = None
    evidence_detail: Optional[str] = None
    source: Literal["page", "api", "none"] = "none"   # page = 在真实页面里找到；api = 只做了离线预测
    clicked: bool = False
    confirmed: bool = False
    verified: bool = False          # 点完后按 id 核验通过
    summary: Optional[str] = None   # 给人看的一句话
    warnings: List[str] = Field(default_factory=list)
    error: Optional[str] = None
    plan: List[PlanOption] = Field(default_factory=list)
    elapsed_ms: Optional[int] = None


class AutoInfo(BaseModel):
    running: bool = False
    mode: Optional[Mode] = None
    round: int = 0                  # 成功完成的轮数（出了几题）
    failed: int = 0                 # 失败轮数
    started_at: Optional[float] = None
    last_round_at: Optional[float] = None
    last_char_id: Optional[int] = None
    last_char_name: Optional[str] = None
    waiting_for: Optional[str] = None     # 当前在等什么（「等本局结束」「等玩家准备」…）
    provider: Optional[str] = None        # spec（按工作台的方案抽题）| classic（按经典工作台的方案抽题）| default（没给方案，不出题）
    stop_reason: Optional[str] = None


class ClickerStatus(BaseModel):
    connected: bool = False         # Playwright 当前是否已接上 Chrome
    browser_ok: bool = False        # CDP 端口能否访问（不需要接上）
    cdp_port: int = 9223
    page_url: Optional[str] = None  # 当前（或最近一次）操作的标签页
    page_role: Optional[str] = None # 取值见 API.md「page_role」
    state: ClickState = "idle"
    busy: bool = False
    task_id: Optional[str] = None
    target: Optional[TargetView] = None
    strategy_used: Optional[str] = None   # 例：char_search/react_key、subject/resp_id
    attempts: int = 0
    last_error: Optional[str] = None
    last_result: Optional[LocateResult] = None
    logs: List[LogEntry] = Field(default_factory=list)   # 最近 200 条
    auto: AutoInfo = Field(default_factory=AutoInfo)
    updated_at: float = 0.0
    # —— 便于直接显示的冗余字段 ——
    running: bool = False
    manual_running: bool = False
    auto_running: bool = False
    log_lines: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# 请求体
# ---------------------------------------------------------------------------
class OncePayload(BaseModel):
    """POST /autoclick/once（只有 mode 必填，其余字段都是可选）。"""
    mode: Mode = "host"
    char_id: Optional[int] = None
    char_name: Optional[str] = None
    work_name_hint: Optional[str] = None
    dry_run: bool = False           # true = 只定位不点击
    confirm: bool = True            # host：选中后是否点「确认」
    open_popup: bool = True         # host：弹窗没开时是否自动「有人想出题？→ 选择自己」


class OnceResp(BaseModel):
    task_id: str
    accepted: bool
    message: Optional[str] = None
    state: Optional[ClickState] = None


class DryRunPayload(BaseModel):
    """POST /autoclick/dry_run：同步返回 LocateResult。"""
    mode: Mode = "host"
    char_id: Optional[int] = None
    char_name: Optional[str] = None
    work_name_hint: Optional[str] = None
    in_page: bool = True            # true = 页面上有可用搜索框时，真的打字去找（不点）；false = 只做离线预测


def dump(m: BaseModel) -> Dict[str, Any]:
    return m.model_dump(mode="json")
