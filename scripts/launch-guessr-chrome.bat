@echo off
chcp 65001 >nul
setlocal
REM ==========================================================================
REM  一键启动「带调试端口的 Chrome」并打开猜猜呗房间，供出题器自动点击器连接。
REM  用法：launch-guessr-chrome.bat [房间URL] [CDP端口]
REM    例：launch-guessr-chrome.bat https://anime-character-guessr.netlify.app/multiplayer/xxxx
REM        launch-guessr-chrome.bat http://localhost:5173/multiplayer 9223    （本地运行的猜猜呗，调试端口 9223）
REM  不给 URL 时打开线上多人大厅；端口默认 9223（与 backend\config.json 的 autoclick.cdp_port 一致）。
REM  说明：
REM   - 用独立的用户目录 %LocalAppData%\outsetter\chrome-debug-profile（Chrome 136+ 不允许在默认用户目录上开调试端口）。
REM   - 如果这个端口上已经有调试版 Chrome 在跑，就直接在里面新开一个标签页，不重复启动。
REM   - 关闭后台标签页节流：否则切到别的标签页后，游戏的 500ms 搜索防抖会被拖慢到 1 秒以上甚至 1 分钟。
REM ==========================================================================
set "URL=%~1"
if "%URL%"=="" set "URL=https://anime-character-guessr.netlify.app/multiplayer"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=9223"
set "PROFILE=%LocalAppData%\outsetter\chrome-debug-profile"

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" goto :nochrome

curl.exe -s -m 2 "http://127.0.0.1:%PORT%/json/version" >nul 2>&1
if not errorlevel 1 goto :reuse

echo [1/2] 启动调试版 Chrome：端口 %PORT%，用户目录 %PROFILE%
if not exist "%PROFILE%" mkdir "%PROFILE%"
REM 可选：--webrtc-ip-handling-policy=disable_non_proxied_udp 让网页里的 WebRTC 在走代理时不绕过代理直连；不需要可以去掉这个参数。
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --webrtc-ip-handling-policy=disable_non_proxied_udp --new-window "%URL%"

echo [2/2] 等待调试端口就绪...
for /L %%i in (1,1,20) do (
  curl.exe -s -m 1 "http://127.0.0.1:%PORT%/json/version" >nul 2>&1 && goto :ready
  powershell -NoProfile -Command "Start-Sleep -Milliseconds 500" >nul
)
echo [!] 10 秒内端口 %PORT% 没有就绪。可能是同一个用户目录的 Chrome 已经以「无调试端口」的方式开着，请把它全部关掉后重试。
exit /b 1

:ready
echo [OK] Chrome 调试端口 %PORT% 已就绪，打开的是：%URL%
exit /b 0

:reuse
echo [i] 端口 %PORT% 上已有调试版 Chrome，直接在里面新开标签页：%URL%
curl.exe -s -m 3 -X PUT "http://127.0.0.1:%PORT%/json/new?%URL%" >nul
exit /b 0

:nochrome
echo [x] 没找到 Chrome（查过 Program Files、Program Files (x86)、LocalAppData）。
exit /b 1
