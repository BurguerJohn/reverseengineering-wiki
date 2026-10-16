@echo off
rem Starts the ReverseEngineering.wiki gateway hidden at every Windows logon (no admin rights needed).
rem Remove with uninstall-autostart.cmd.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0start-gateway.cmd"
> "%STARTUP%\REWiki Gateway.vbs" echo CreateObject("WScript.Shell").Run """%TARGET%""", 0, False
echo Installed: "%STARTUP%\REWiki Gateway.vbs"
echo Starting the gateway now...
wscript "%STARTUP%\REWiki Gateway.vbs"
