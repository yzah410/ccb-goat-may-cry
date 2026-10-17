#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# 需要 Python 3.10 或更高
if ! command -v python3 >/dev/null 2>&1; then
  echo "[x] 没找到 python3。请先安装 Python 3.10 或更高版本。" >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "[x] Python 版本太低（当前是 $(python3 --version 2>&1)），需要 3.10 或更高。" >&2
  exit 1
fi

# 虚拟环境放在 backend/venv，和 Windows 的 setup-deps.bat 一致
if [ ! -x backend/venv/bin/python ]; then
  if ! python3 -m venv backend/venv; then
    rm -rf backend/venv
    echo "[x] 创建虚拟环境失败。Debian/Ubuntu 需要先装 python3-venv：sudo apt install python3-venv" >&2
    exit 1
  fi
fi

if ! backend/venv/bin/python -m pip install --upgrade pip \
  || ! backend/venv/bin/python -m pip install -r backend/requirements.txt; then
  echo "[x] 安装 Python 依赖失败，请看上面的报错（多半是网络问题，可以重新运行）。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[x] 没找到 npm。请先安装 Node.js，版本要求见 README。" >&2
  exit 1
fi
cd web
if ! npm ci; then
  echo "[x] npm ci 失败。请确认 Node.js 版本满足 README 的要求，并且网络能访问 npm。" >&2
  exit 1
fi

echo "[OK] 依赖安装完成。后续可直接运行 ./start-all.sh"
