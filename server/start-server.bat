@echo off
rem FactGuard — запуск сервера на Windows. Двічі клацніть цей файл.
chcp 65001 >nul
cd /d "%~dp0"

set PY=python
where python >nul 2>nul || set PY=py
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo Потрібен Python 3.10 або новіший: https://www.python.org/downloads/
  echo Під час встановлення поставте галочку "Add Python to PATH".
  pause
  exit /b 1
)

if not exist venv\Scripts\python.exe (
  echo Перший запуск: створюємо середовище і встановлюємо бібліотеки ^(1-2 хвилини^)...
  %PY% -m venv venv
  venv\Scripts\python -m pip install --quiet --disable-pip-version-check -r requirements.txt
  if errorlevel 1 (
    rmdir /s /q venv
    echo Не вдалося встановити бібліотеки. Перевірте інтернет і спробуйте ще раз.
    pause
    exit /b 1
  )
)

if not exist .env (
  copy /y .env.example .env >nul
  echo Створено файл server\.env - впишіть у нього ключ ШІ ^(див. README, розділ "Підключення ШІ"^).
)

echo Не закривайте це вікно, поки користуєтеся перевіркою фактів. Зупинка - Ctrl+C.
venv\Scripts\python main.py
pause
