@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] 创建 Python 虚拟环境 ...
REM 需要 Python 3.10 或更高
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [x] 没找到 Python 3.10 或更高版本。请先安装，安装时勾选 Add python.exe to PATH。
    goto :fail
)
if not exist backend\venv\Scripts\python.exe (
    python -m venv backend\venv
    if errorlevel 1 (
        echo [x] 创建虚拟环境失败，请看上面的报错。
        goto :fail
    )
)

echo [2/3] 安装 Python 依赖 ...
backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
if errorlevel 1 (
    echo [x] 安装 Python 依赖失败，请看上面的报错。多半是网络问题，可以重新运行。
    goto :fail
)

echo [3/3] 安装前端 web/ 的 npm 包 ...
cd /d "%~dp0web"
REM npm 是 npm.cmd，必须用 call，否则它跑完后这个脚本就不会继续往下执行
call npm ci
if errorlevel 1 (
    echo [x] npm ci 失败。请确认已安装 Node.js，版本满足 README 的要求，并且网络能访问 npm。
    goto :fail
)

echo.
echo ✅ 安装完成！以后可直接运行 start-all.bat 启动
pause
exit /b 0

:fail
echo.
echo 安装没有完成。解决上面的问题后，重新运行 setup-deps.bat。
pause
exit /b 1
