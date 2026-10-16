@echo off
rem Runs the ReverseEngineering.wiki gateway and restarts it if it exits. Logs: gateway\data\gateway.log
rem Started hidden at logon by the Startup entry created with install-autostart.cmd.
cd /d "%~dp0..\..\gateway"
if not exist data mkdir data
:loop
echo [%date% %time%] starting gateway>> data\gateway.log
node --disable-warning=ExperimentalWarning src\main.ts >> data\gateway.log 2>&1
echo [%date% %time%] gateway exited with code %errorlevel%, restarting in 5 s>> data\gateway.log
timeout /t 5 /nobreak > nul
goto loop
