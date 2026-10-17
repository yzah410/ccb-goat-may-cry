# -*- coding: utf-8 -*-
"""猜猜呗自动点击器。

入口：ClickerService(cfg)。说明见同目录 README.md / API.md。
"""
from .models import (AutoInfo, ClickerStatus, DryRunPayload, LocateResult, LogEntry, OncePayload,
                     OnceResp, PlanOption, TargetView)
from .service import ClickerOptions, ClickerService

__all__ = [
    "ClickerService", "ClickerOptions", "OncePayload", "OnceResp", "DryRunPayload", "LocateResult",
    "ClickerStatus", "AutoInfo", "LogEntry", "PlanOption", "TargetView",
]
