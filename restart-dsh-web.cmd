@echo off
rem dsh-logcat: restart the DSH web host so a freshly installed plugin version loads.
rem Double-click this file, then refresh the GUI (Ctrl+F5).
chcp 65001 >nul
echo.
echo === 重启 DSH Web（加载新版 dsh-logcat 0.7.0）===
echo.
set NODE="C:\Program Files\nodejs\node.exe"
set DSH=C:\Users\35081\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js

echo [1/2] 停止旧进程（端口 3080）...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3080" ^| findstr "LISTENING"') do (
  echo   - 结束进程 PID %%a
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo [2/2] 启动新进程...
start "dsh web" /min %NODE% "%DSH%" web --no-open
timeout /t 4 /nobreak >nul

echo.
echo 完成。请回浏览器按 Ctrl+F5 刷新，面板右下角应显示 v0.7.0。
echo 注意：重启瞬间当前对话页会断开几秒（会话记录在磁盘上，刷新即可恢复）。
echo 若页面打不开，等 5 秒再刷新一次（冷启动需要几秒）。
echo.
pause
