@echo off
cd /d "%~dp0.."
if exist "runtime\node.exe" (set "NODE=runtime\node.exe") else (set "NODE=node.exe")
%NODE% scripts\desktop-agent.mjs --once
pause
