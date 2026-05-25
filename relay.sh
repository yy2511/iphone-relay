#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/.relay.pid"

case "${1:-start}" in
  start)
    cd "$ROOT_DIR"
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Relay already running (PID $(cat "$PID_FILE"))"
      exit 0
    fi
    nohup node src/server.mjs >> .relay.log 2>&1 &
    echo $! > "$PID_FILE"
    echo "Relay started (PID $!) — log: .relay.log, stop: $0 stop"
    ;;
  stop)
    if [[ ! -f "$PID_FILE" ]]; then
      echo "No PID file found"
      exit 0
    fi
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Relay stopped"
    ;;
  status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Relay running (PID $(cat "$PID_FILE"))"
    else
      echo "Relay not running"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|status}"
    exit 1
    ;;
esac
