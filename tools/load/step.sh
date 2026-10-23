#!/usr/bin/env bash
# Одна ступень: прогон run.ts + пики CPU/памяти контейнеров (docker stats раз в ~2 с).
# USERS=1000 RATE=100 GROUP=2 DURATION=30 tools/load/step.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp)
( while true; do docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' $(docker compose ps -q server postgres valkey worker) >> "$OUT" 2>/dev/null; done ) &
SAMPLER=$!
docker compose run -T --rm --no-deps -v ./tools:/app/tools \
  -e USERS="${USERS:-200}" -e RATE="${RATE:-50}" -e GROUP="${GROUP:-2}" -e DURATION="${DURATION:-30}" -e CONNECT_RATE="${CONNECT_RATE:-200}" \
  server bun tools/load/run.ts </dev/null 2>&1 | grep -v 'Container\|^$' | grep -v '^  t=' | tr -d '\n' | sed 's/  */ /g'; echo
kill $SAMPLER 2>/dev/null || true
# пик CPU и памяти по каждому контейнеру
awk '{ name=$1; sub(/^relay-/,"",name); sub(/-1$/,"",name); cpu=$2; sub(/%/,"",cpu); if (cpu+0 > max[name]) max[name]=cpu+0; mem[name]=$3 } END { for (n in max) printf "  %-9s cpu max %5.0f%%  mem %s\n", n, max[n], mem[n] }' "$OUT" | sort
rm -f "$OUT"
