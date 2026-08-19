@echo off
rem dsh-logcat: stop the running DSH web host so the plugin can load.
rem Usage: double-click this file, then restart DSH web with your usual
rem command (e.g. `npx @deepseek-ai/dsh web`) and open the GUI again.
chcp 65001 >nul
echo 正在停止 DSH Web 宿主进程（端口 3080）...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3080" ^| findstr "LISTENING"') do (
  echo 结束进程 PID %%a
  taskkill /F /PID %%a >nul 2>&1
)
echo.
echo 已停止。请用你平时的启动方式重新运行 DSH Web，例如：
echo   npx @deepseek-ai/dsh web
echo 然后打开 http://127.0.0.1:3080 ，左侧栏会出现「Logcat」入口。
echo.
pause
