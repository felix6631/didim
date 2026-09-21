#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
[ -d frontend/node_modules ] || (cd frontend && npm install)
trap 'kill 0' EXIT
.venv/bin/python -m uvicorn app.main:app --app-dir backend --reload --port 8000 &
(cd frontend && npm run dev) &
echo "디딤: http://localhost:5173"
wait

