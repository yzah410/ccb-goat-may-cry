#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -f backend/config.json ]; then
  cp backend/config.example.json backend/config.json
  echo "已从示例生成 backend/config.json。请把 v2.db_path 改成出题器库 outsetter_v2.sqlite 的路径（默认 data/outsetter_v2.sqlite，相对仓库根）。"
fi

if [ ! -x backend/venv/bin/python ]; then
  echo "[!] 未检测到虚拟环境，请先运行 ./setup-deps.sh"
  exit 1
fi

# 想换端口：在 web/.env.development.local 里写 WEB_PORT=xxxx 和 VITE_API_BASE=http://127.0.0.1:xxxx
# 没写就用 5175（前端）和 8099（后端）。Vite 自己也读这个文件，所以两边端口一致。
ENV_FILE=web/.env.development.local
read_env() {  # 用法：read_env 键名。输出该键最后一次写的值，去掉空白和引号
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d "[:space:]\"'"
}
WEB_PORT=$(read_env WEB_PORT)
case "$WEB_PORT" in ''|*[!0-9]*) WEB_PORT=5175 ;; esac
# VITE_API_BASE 形如 http://127.0.0.1:8100，取主机后面的端口
API_PORT=$(read_env VITE_API_BASE | sed -n 's#^\([A-Za-z][A-Za-z0-9+.-]*://\)\{0,1\}[^:/]*:\([0-9][0-9]*\).*#\2#p')
case "$API_PORT" in ''|*[!0-9]*) API_PORT=8099 ;; esac
WEB_URL="http://127.0.0.1:$WEB_PORT"

BACKEND_PID=""
WEB_PID=""

# 退出时（正常结束、Ctrl+C、被 kill）统一把两个服务关掉，不留后台进程
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$BACKEND_PID" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [ -n "$WEB_PID" ]; then kill "$WEB_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backend/venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port "$API_PORT" &
BACKEND_PID=$!
npm --prefix web run dev &
WEB_PID=$!

echo "前端：$WEB_URL ，后端：http://127.0.0.1:$API_PORT"

# 用系统默认浏览器打开页面：macOS 用 open，Linux 用 xdg-open；没有这个命令（或没有桌面）就只打印地址，自己打开
sleep 1
if [ "$(uname -s)" = "Darwin" ]; then OPENER=open; else OPENER=xdg-open; fi
if command -v "$OPENER" >/dev/null 2>&1; then
  "$OPENER" "$WEB_URL" >/dev/null 2>&1 || true
else
  echo "请在浏览器里打开 $WEB_URL"
fi

wait
