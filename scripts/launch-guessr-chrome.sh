#!/usr/bin/env bash
# ==========================================================================
#  一键启动「带调试端口的 Chrome」并打开猜猜呗房间，供出题器自动点击器连接。
#  这是 macOS / Linux 版；Windows 用 launch-guessr-chrome.bat，参数一致。
#  用法：scripts/launch-guessr-chrome.sh [房间URL] [CDP端口]
#    例：scripts/launch-guessr-chrome.sh https://anime-character-guessr.netlify.app/multiplayer/xxxx
#        scripts/launch-guessr-chrome.sh http://localhost:5173/multiplayer 9223    （本地运行的猜猜呗，调试端口 9223）
#  不给 URL 时打开线上多人大厅；端口默认 9223（与 backend/config.json 的 autoclick.cdp_port 一致）。
#  说明：
#   - 用独立的用户目录（macOS：~/Library/Application Support/outsetter/chrome-debug-profile，
#     Linux：~/.local/share/outsetter/chrome-debug-profile）。Chrome 136+ 不允许在默认用户目录上开调试端口。
#   - 如果这个端口上已经有调试版 Chrome 在跑，就直接在里面新开一个标签页，不重复启动。
#   - 关闭后台标签页节流：否则切到别的标签页后，游戏的 500ms 搜索防抖会被拖慢到 1 秒以上甚至 1 分钟。
# ==========================================================================
set -e

URL="${1:-https://anime-character-guessr.netlify.app/multiplayer}"
PORT="${2:-9223}"

if ! command -v curl >/dev/null 2>&1; then
  echo "[x] 没找到 curl，请先安装。" >&2
  exit 1
fi

if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "[i] 端口 $PORT 上已有调试版 Chrome，直接在里面新开标签页：$URL"
  curl -s -g -m 3 -X PUT "http://127.0.0.1:$PORT/json/new?$URL" >/dev/null
  exit 0
fi

# 找 Chrome：macOS 看 /Applications 和 ~/Applications，Linux 先看 PATH 里的常见命令名，再看官方安装包的位置
CHROME=""
if [ "$(uname -s)" = "Darwin" ]; then
  PROFILE="$HOME/Library/Application Support/outsetter/chrome-debug-profile"
  for p in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [ -x "$p" ]; then CHROME="$p"; break; fi
  done
else
  PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/outsetter/chrome-debug-profile"
  for c in google-chrome google-chrome-stable chromium chromium-browser /opt/google/chrome/chrome; do
    if p=$(command -v "$c" 2>/dev/null); then CHROME="$p"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  echo "[x] 没找到 Chrome（查过 /Applications、~/Applications，以及 PATH 里的 google-chrome、chromium）。" >&2
  exit 1
fi

echo "[1/2] 启动调试版 Chrome：端口 $PORT，用户目录 $PROFILE"
mkdir -p "$PROFILE"
# 可选：--webrtc-ip-handling-policy=disable_non_proxied_udp 让网页里的 WebRTC 在走代理时不绕过代理直连；不需要可以去掉这个参数。
nohup "$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --webrtc-ip-handling-policy=disable_non_proxied_udp --new-window "$URL" >/dev/null 2>&1 &
disown

echo "[2/2] 等待调试端口就绪..."
for _ in $(seq 1 20); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "[OK] Chrome 调试端口 $PORT 已就绪，打开的是：$URL"
    exit 0
  fi
  sleep 0.5
done
echo "[!] 10 秒内端口 $PORT 没有就绪。可能是同一个用户目录的 Chrome 已经以「无调试端口」的方式开着，请把它全部关掉后重试。" >&2
exit 1
