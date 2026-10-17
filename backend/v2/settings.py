# -*- coding: utf-8 -*-
"""出题器的配置和路径。

- 配置读 backend/config.json 的 `v2` 段（用 paths.load_config 读）。
- AI 接口的设置在 `v2.ai.api`，网页「设置 → AI」里改：save_api_config 只换这一段，配置文件的其余内容原样写回。
  API key 优先用环境变量 OUTSETTER_AI_API_KEY（设置了它，网页上就改不了 key）。
- 找库顺序：环境变量 OUTSETTER_V2_DB（只给测试 / 临时开发用）→ v2.db_path。
- 清单、方案目录：data/lists_v2、data/plans_v2（测试时可用环境变量 OUTSETTER_V2_DATA_DIR 整体改到临时目录）。
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from typing import Any, Dict, Optional

from ..paths import BACKEND_DIR, REPO_ROOT, config_file, example_config_file, load_config

API_KEY_ENV = "OUTSETTER_AI_API_KEY"


class ConfigFileInvalid(ValueError):
    """config.json 存在但读不出来（不是合法的 JSON，或最外层不是对象）。"""

API_DEFAULTS: Dict[str, Any] = {
    "protocol": "openai",         # openai（OpenAI 兼容的 /chat/completions）或 anthropic（/v1/messages）
    "preset": None,               # 网页上选的服务商（web/src/features/ai/providers.ts 的 id），只用来显示名字
    "base_url": "",
    "model": "",
    "api_key": "",
    "max_tokens": None,           # None：openai 协议不传；anthropic 协议必须传，用 4096
}

AI_DEFAULTS: Dict[str, Any] = {
    "default_engine": "api",      # api（v2.ai.api 里的接口）/ claude / codex（本机命令行）
    "api": dict(API_DEFAULTS),
    "claude_model": "sonnet",
    # claude 的推理强度（--effort）：low / medium / high / xhigh / max；null 或 "default" = 不传（跟随 ~/.claude/settings.json 的
    # effortLevel）。默认 low（为了速度）。
    "claude_effort": "low",
    "codex_model": None,          # None = codex 自己的默认模型
    "codex_effort": "medium",
    "timeout_s": 120,
    "max_input_chars": 500,
    "warm_enabled": True,         # 预热进程池（只对 claude）：fill / ask 各提前开好一个 claude 进程
    "warm_idle_s": 600,           # 预热的进程空闲这么多秒没人用就关掉
    "stall_s": 60,                # 发出请求后连续这么多秒什么都没收到 → 当成卡住了，中止
}


def v2_config() -> Dict[str, Any]:
    try:
        cfg = load_config()
    except Exception:
        return {}
    return dict(cfg.get("v2") or {})


def ai_config() -> Dict[str, Any]:
    """v2.ai 合并默认值；api 这一段单独按字段合并（只写了一部分字段时，其余字段用默认值）。"""
    user = v2_config().get("ai")
    user = user if isinstance(user, dict) else {}
    out = dict(AI_DEFAULTS)
    out.update(user)
    api = dict(API_DEFAULTS)
    if isinstance(user.get("api"), dict):
        api.update(user["api"])
    out["api"] = api
    return out


def api_config() -> Dict[str, Any]:
    """实际要用的 API 设置：v2.ai.api 合并默认值；api_key 是要发出去的 key（环境变量优先），key_from_env 说明 key 从哪来。"""
    a = dict(API_DEFAULTS)
    raw = ai_config().get("api")
    if isinstance(raw, dict):
        a.update(raw)
    env = (os.environ.get(API_KEY_ENV) or "").strip()
    a["key_from_env"] = bool(env)
    a["api_key"] = env or str(a.get("api_key") or "").strip()
    return a


def saved_api_key() -> str:
    """config.json 里存的 key（不看环境变量）。"""
    raw = ai_config().get("api")
    return str((raw or {}).get("api_key") or "").strip() if isinstance(raw, dict) else ""


def config_label() -> str:
    """给人看的配置文件名：默认位置写 backend/config.json，别的位置写完整路径。"""
    path = config_file()
    default = os.path.join(BACKEND_DIR, "config.json")
    return "backend/config.json" if os.path.normcase(os.path.abspath(path)) == os.path.normcase(default) else path


def config_problem() -> Optional[str]:
    """config.json 存在但读不出来时返回原因（例如 JSON 解析的报错）；不存在或读得出来返回 None。
    v2_config() 读不出来时按空配置处理，GET / PUT 设置接口要先用这个把问题报出来，不能当成「还没设置」。"""
    path = config_file()
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        return str(e) or type(e).__name__
    if not isinstance(raw, dict):
        return "最外层不是一个对象"
    return None


def _replace(tmp: str, path: str) -> None:
    """os.replace；Windows 上目标文件正被别的进程（例如杀毒软件、编辑器）短暂打开时会报拒绝访问，稍等重试几次。"""
    for i in range(10):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == 9:
                raise
            time.sleep(0.05)


def save_api_config(api: Dict[str, Any]) -> str:
    """把 v2.ai.api 换成 api（只保留 API_DEFAULTS 里的字段），写回 config.json，返回写入的路径。

    读的是 config.json 的原文（不存在就以 config.example.json 的内容为底），其余各段和 _comment 原样保留。
    不用 load_config() 的返回值：它额外加了 _config_path 和 data_paths，写回去会把这些也存进文件。
    先写同目录的临时文件、刷到磁盘，再 os.replace，写到一半出错或断电时原文件不受影响。
    同时保存的串行由调用方（aiapi.update_config）负责。
    """
    path = config_file()
    src = path if os.path.exists(path) else example_config_file()
    try:
        with open(src, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except ValueError as e:                    # 文件不是合法 JSON：不覆盖它
        raise ConfigFileInvalid(str(e)) from None
    if not isinstance(raw, dict):
        raise ConfigFileInvalid(f"{os.path.basename(src)} 最外层不是一个对象")
    v2 = raw.get("v2")
    if not isinstance(v2, dict):
        v2 = raw["v2"] = {}
    ai = v2.get("ai")
    if not isinstance(ai, dict):
        ai = v2["ai"] = {}
    ai["api"] = {k: api.get(k, API_DEFAULTS[k]) for k in API_DEFAULTS}
    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(raw, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        _replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return path


def db_candidates() -> list:
    """按优先级列出候选库路径（不管存不存在）。"""
    out = []
    env = os.environ.get("OUTSETTER_V2_DB")
    if env:
        out.append(os.path.normpath(env))
        return out
    p = v2_config().get("db_path")
    if p:
        p = os.path.normpath(p if os.path.isabs(p) else os.path.join(REPO_ROOT, p))
        out.append(p)
    return out


def resolve_db_path() -> Optional[str]:
    for p in db_candidates():
        if os.path.isfile(p):
            return p
    return None


def data_dir() -> str:
    return os.environ.get("OUTSETTER_V2_DATA_DIR") or os.path.join(REPO_ROOT, "data")


def lists_dir() -> str:
    return os.path.join(data_dir(), "lists_v2")


def plans_dir() -> str:
    return os.path.join(data_dir(), "plans_v2")
