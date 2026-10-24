#!/usr/bin/env bash
# Одна ступень: прогон run.ts + пики CPU/памяти контейнеров (docker stats раз в ~2 с).
# USERS=1000 RATE=100 GROUP=2 DURATION=30 tools/load/step.sh
# канал: KIND=channel USERS=2000 OFFLINE=198000 ADMINS=5 RATE=10 DURATION=25 [PUSH_SINK=2000] tools/load/step.sh
# комментарии: COMMENTS=1 USERS=3000 RATE=20 DURATION=25 tools/load/step.sh   (push и replies — нужен worker)
set -euo pipefail
# между ступенями — пауза (PAUSE секунд, перед прогоном): уход тысяч сокетов прошлой ступени — это тысячи
# update users.last_seen_at и объявлений присутствия через RELAY_PRESENCE_GRACE_MS; без паузы они попадают в замер
sleep "${PAUSE:-0}"
cd "$(dirname "$0")/../.."
OUT=$(mktemp)
NAME="relay-load-$$"   # имя контейнера генератора: адрес заглушки push для воркера (PUSH_SINK) и строка «load» в пиках
( while true; do docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' $(docker compose ps -q server postgres valkey worker) $(docker ps -q -f name="$NAME") >> "$OUT" 2>/dev/null; done ) &
SAMPLER=$!
docker compose run -T --rm --no-deps --name "$NAME" -v ./tools:/app/tools \
  -e USERS="${USERS:-200}" -e RATE="${RATE:-50}" -e GROUP="${GROUP:-2}" -e DURATION="${DURATION:-30}" -e CONNECT_RATE="${CONNECT_RATE:-200}" \
  -e KIND="${KIND:-}" -e COMMENTS="${COMMENTS:-0}" -e OFFLINE="${OFFLINE:-0}" -e ADMINS="${ADMINS:-1}" -e PUSH_SINK="${PUSH_SINK:-0}" -e SINK_HOST="$NAME" -e TAIL_PUSH="${TAIL_PUSH:-300}" \
  server bun tools/load/run.ts </dev/null 2>&1 | grep -v 'Container\|^$' | grep -v '^  t=' | tr -d '\n' | sed 's/  */ /g'; echo
kill $SAMPLER 2>/dev/null || true
# пик CPU и памяти по каждому контейнеру
awk '{ name=$1; sub(/^relay-channels-/,"",name); sub(/^relay-/,"",name); sub(/-1$/,"",name); sub(/^load-[0-9]+$/,"load",name); cpu=$2; sub(/%/,"",cpu); if (cpu+0 > max[name]) max[name]=cpu+0; mem[name]=$3 } END { for (n in max) printf "  %-9s cpu max %5.0f%%  mem %s\n", n, max[n], mem[n] }' "$OUT" | sort
rm -f "$OUT"
