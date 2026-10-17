@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM === 获取脚本所在目录（防止路径带空格出错）===
set "ROOT=%~dp0"
cd /d "%ROOT%"
echo 当前目录：%CD%

REM === 虚拟环境路径（setup-deps.bat 建在 backend\venv）===
set "VENV_PATH=%ROOT%backend\venv"

if not exist "%VENV_PATH%\Scripts\python.exe" (
    echo [x] 未检测到虚拟环境，请先运行 setup-deps.bat
    pause
    exit /b 1
)

REM === 读端口 ===
REM 想换端口：在 web\.env.development.local 里写 WEB_PORT=xxxx 和 VITE_API_BASE=http://127.0.0.1:xxxx
REM 没写就用 5175（前端）和 8099（后端）。Vite 自己也读这个文件，所以两边端口一致。
set "WEB_PORT=5175"
set "API_PORT=8099"
set "API_BASE="
set "ENV_FILE=%ROOT%web\.env.development.local"
if exist "%ENV_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
        set "KEY=%%A"
        set "VAL=%%~B"
        set "KEY=!KEY: =!"
        set "VAL=!VAL: =!"
        if "!KEY!"=="WEB_PORT" set "WEB_PORT=!VAL!"
        if "!KEY!"=="VITE_API_BASE" set "API_BASE=!VAL!"
    )
)
REM 从 VITE_API_BASE（形如 http://127.0.0.1:8100）里取端口
if defined API_BASE (
    set "API_REST=!API_BASE:*://=!"
    for /f "tokens=2 delims=:/" %%P in ("!API_REST!") do set "API_PORT=%%P"
)
REM 端口必须是纯数字，否则用默认值（和 vite.config.ts 里 WEB_PORT 读不出就用默认值一致）
set "PORT_BAD="
if not defined WEB_PORT set "PORT_BAD=1"
for /f "delims=0123456789" %%X in ("!WEB_PORT!") do set "PORT_BAD=1"
if defined PORT_BAD set "WEB_PORT=5175"
set "PORT_BAD="
if not defined API_PORT set "PORT_BAD=1"
for /f "delims=0123456789" %%X in ("!API_PORT!") do set "PORT_BAD=1"
if defined PORT_BAD set "API_PORT=8099"
echo 前端 http://127.0.0.1:%WEB_PORT% ，后端 http://127.0.0.1:%API_PORT%

REM === 检查并生成 config.json ===
if not exist "%ROOT%backend\config.json" (
    copy "%ROOT%backend\config.example.json" "%ROOT%backend\config.json" >nul
    echo 已从示例生成 backend\config.json。请把 v2.db_path 改成出题器库 outsetter_v2.sqlite 的路径（默认 data\outsetter_v2.sqlite，相对仓库根）。
)

REM === 启动后端 ===
echo 启动后端服务中...
start "出题器-后端" cmd /k ""%VENV_PATH%\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port %API_PORT%"


REM === 启动前端 web/ ===
cd /d "%ROOT%web"
if not exist "node_modules" (
    echo [x] 未检测到 node_modules，请先运行 setup-deps.bat
    pause
    exit /b 1
)
echo 启动前端界面中...
REM 端口是上面读到的 WEB_PORT，只监听 127.0.0.1（见 web/vite.config.ts）
start "出题器-前端" cmd /k "npm run dev"

REM === 自动用系统默认浏览器打开页面 ===
timeout /t 5 /nobreak >nul
echo 正在用默认浏览器打开页面...

REM 前端只监听 127.0.0.1（见 web/vite.config.ts），所以直接用这个地址打开，不用 localhost
start "" "http://127.0.0.1:%WEB_PORT%"

endlocal
