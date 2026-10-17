# backend/app.py
from __future__ import annotations

from typing import Optional

from fastapi import Body, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from anyio import to_thread

from . import classic
from .classic_router import router as classic_router  # 经典工作台（需要经典工作台数据，见 backend/classic.py）
from .api_ext import ext_router  # 经典工作台的统计、标签补全、数据文件新鲜度（/stats /tags /ext/*）
from .paths import load_config, describe
from .schemas import ConfigPayload
from .writeguard import GUARD_HEADER, LOCAL_ORIGIN_REGEX, WriteGuardMiddleware
# 自动点击器：实现在 backend/clicker/
from .clicker import ClickerService, OncePayload, OnceResp, DryRunPayload

from .v2.router import router as v2_router  # 出题器接口（/v2/*：数据库、方案、候选池、AI 等）
from .v2.solo.router import router as v2_solo_router  # 单人版猜猜呗的只读辅助接口（/v2/solo/*，见 backend/v2/solo/README.md）
from .v2.solo.session_router import router as v2_solo_session_router  # 单人版猜猜呗的对局接口（会话 / 开局 / 猜测 / 评级 / Bangumi 搜索）
from .v2.maplink_router import router as v2_maplink_router  # 导图 × 单人猜猜呗联动（预选、图组存储，/v2/maplink/*）
from .v2.solo import search as v2_solo_search  # 单人版容错搜索服务（索引在后台建，见 backend/v2/solo/search.py）
# -------------------- 配置 --------------------
# 配置由 paths.load_config() 读取；数据库路径取配置里的 v2.db_path（相对路径按仓库根解析）。
# 经典工作台的数据放在 data/classic/，有就加载，没有不影响启动。
CFG = load_config()
CFG_PATH = CFG.get("_config_path")
print(describe(CFG), flush=True)

# -------------------- FastAPI --------------------
app = FastAPI(title="guessr-outset-backend", version="0.2.2")
# 中间件从里到外：写请求守卫 → CORS → Host 检查（add_middleware 后加的在外层）。
# 写请求守卫放在 CORS 里面，这样本机页面收到的 403 也带 CORS 头，前端读得到错误原因。
# 为什么需要守卫：CORS 只管网页能不能读到响应，不管请求发没发出去。外部网页用普通表单、或不带
# Content-Type 的 fetch 发出的 POST 是不触发预检的简单请求，浏览器照样把它发给本机后端。
# 所以写请求必须带自定义头 X-Outsetter: 1（逼浏览器先预检，预检会被下面的 CORS 规则挡住），
# 并且 Origin 不能是外部网页；规则和例外见 backend/writeguard.py。
# 脚本、curl 这类非浏览器客户端没有 Origin，只要加上这个头就能调用。
app.add_middleware(WriteGuardMiddleware)
# 只让本机页面读响应：出题器前端（默认 5175 端口，可在 web/.env.development.local 里用 WEB_PORT 改）都在 127.0.0.1 / localhost 上。
# 项目不用 cookie，也没有登录，所以不开 allow_credentials。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=LOCAL_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["Content-Type", GUARD_HEADER],
)
# Host 头只认本机名字：挡住 DNS 重绑定（外部网页把自己的域名解析到 127.0.0.1 后就成了「同源」，CORS 管不到）。
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

# -------------------- 常驻对象 --------------------
classic.init(CFG)
AC = ClickerService(CFG)

# -------------------- 自动点击器：单次 / 验证 / 状态 --------------------
# 说明见 backend/clicker/API.md。logs 是 {ts, level, msg} 对象数组；
# log_lines 是同样内容的格式化文字，方便直接显示。
@app.post("/autoclick/once", response_model=OnceResp)
async def autoclick_once(payload: OncePayload):
    """立即返回 task_id；进度看 GET /autoclick/status。dry_run=true 时只定位不点击。"""
    return AC.once(payload)

@app.post("/autoclick/dry_run")
async def autoclick_dry_run(payload: DryRunPayload):
    """同步返回「会点第几项、依据是什么」（前端「验证」按钮用）。页面上没有可用搜索框时退化为离线预测。"""
    res = await AC.dry_run(payload)
    return res.model_dump(mode="json")

@app.get("/autoclick/status")
async def autoclick_status():
    return await AC.status_async()

@app.get("/autoclick/probe")
async def autoclick_probe():
    """只用 HTTP 看 Chrome 调试端口和猜猜呗标签页，不接管浏览器。"""
    return await AC.probe_async()

@app.post("/autoclick/cancel")
async def autoclick_cancel():
    # result：cancelled（已停下）/ cancelling（还在停）/ stuck（卡住，已自动重置浏览器连接）/ no_task，见 API.md
    return {"ok": True, "result": await AC.cancel_async()}

@app.on_event("shutdown")
async def _clicker_shutdown():
    await to_thread.run_sync(AC.shutdown)

# -------------------- 自动模式 --------------------
# 工作台的自动模式用 POST /v2/autoclick/auto/start 启动（每轮按当前方案抽题，见 backend/v2/router.py）；
# 经典工作台的自动模式用下面这个启动（每轮按经典工作台的方案抽题），需要经典工作台数据。

class AutoStartPayload(BaseModel):
    mode: str = "host"                      # 只有 "host"（房主出题）
    config: Optional[ConfigPayload] = None  # 经典工作台的方案；不传就没有方案，不出题

@app.post("/autoclick/auto/start", dependencies=[Depends(classic.require_classic)])
async def autoclick_auto_start(payload: Optional[AutoStartPayload] = Body(default=None)):
    """允许空 body；mode 大小写随意；出错统一返回 {ok:false,error:""}。"""
    try:
        if payload is None:
            payload = AutoStartPayload()
        mode = (payload.mode or "host").lower()
        provider = classic.make_provider(payload.config) if payload.config is not None else None
        # start_auto 把常驻循环投递到点击器自己的事件循环线程，立即返回字符串结果
        result = AC.start_auto(mode=mode, provider=provider, provider_name="classic")
        return {"ok": True, "result": result, "status": await AC.status_async()}
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "error": str(e)})

@app.post("/autoclick/auto/stop")
async def autoclick_auto_stop():
    try:
        res = await AC.stop_auto_async()
        return {"ok": True, "result": res}
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "error": str(e)})

app.include_router(classic_router)
app.include_router(ext_router)
app.include_router(v2_router)
app.include_router(v2_solo_router)
app.include_router(v2_solo_session_router)
app.include_router(v2_maplink_router)
v2_solo_search.install()  # 单人版容错搜索：库快照装好后在后台建索引（建好之前 /v2/solo/search 先用严格匹配，和 /v2/suggest 一样）
