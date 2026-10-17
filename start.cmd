@echo off
rem REL-02: double-click to start Agent Chat. Logic lives in scripts\start.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
