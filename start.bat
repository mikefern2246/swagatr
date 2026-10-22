@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ยังไม่ได้ติดตั้ง Node.js กรุณาดาวน์โหลดที่ https://nodejs.org แล้วลองใหม่
  pause
  exit /b 1
)
if not exist node_modules (
  echo กำลังติดตั้งครั้งแรก รอสักครู่...
  call npm install
)
call npm start
