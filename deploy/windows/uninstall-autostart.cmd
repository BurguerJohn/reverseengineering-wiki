@echo off
rem Removes the logon entry and stops a gateway started by it.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\REWiki Gateway.vbs" 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start-gateway.cmd*' } | ForEach-Object { taskkill /pid $_.ProcessId /t /f | Out-Null }"
echo Removed. The gateway is stopped.
