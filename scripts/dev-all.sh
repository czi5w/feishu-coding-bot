#!/usr/bin/env bash
# Run bot-host and agent-core dev watchers in parallel.
# Uses trap to propagate signals and kill both on exit.

set -euo pipefail

pids=()

cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

pnpm --filter @feishu-bot/bot-host dev &
pids+=($!)

pnpm --filter @feishu-bot/agent-core dev &
pids+=($!)

# Wait for any child to exit; when one dies, cleanup will tear down the other.
wait -n
