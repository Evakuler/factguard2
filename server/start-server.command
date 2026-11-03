#!/bin/bash
# FactGuard — запуск сервера на macOS / Linux. Двічі клацніть цей файл (або: bash start-server.command).
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 не знайдено. Встановіть його з https://www.python.org/downloads/ і запустіть цей файл знову."
  read -r -p "Натисніть Enter, щоб закрити…"; exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Потрібен Python 3.10 або новіший. Зараз встановлено: $(python3 --version)"
  read -r -p "Натисніть Enter, щоб закрити…"; exit 1
fi

if [ ! -x venv/bin/python ]; then
  echo "Перший запуск: створюємо середовище і встановлюємо бібліотеки (1–2 хвилини)…"
  python3 -m venv venv && ./venv/bin/pip install --quiet --disable-pip-version-check -r requirements.txt
  if [ $? -ne 0 ]; then
    rm -rf venv
    echo "Не вдалося встановити бібліотеки. Перевірте інтернет і спробуйте ще раз."
    read -r -p "Натисніть Enter, щоб закрити…"; exit 1
  fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Створено файл server/.env — впишіть у нього ключ ШІ (див. README, розділ «Підключення ШІ»)."
fi

echo "Не закривайте це вікно, поки користуєтеся перевіркою фактів. Зупинка — Ctrl+C."
./venv/bin/python main.py
