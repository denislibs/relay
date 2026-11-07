#!/bin/sh
# Запуск coturn: свой адрес в сети контейнеров — единственный разрешённый частный «собеседник» (обмен между двумя
# релеями этого же сервера, когда оба участника звонка идут через TURN). Остальные частные сети закрыты конфигом.
# Секрет учёток — в копию конфига (права 600), а не флагом: аргументы видно в `ps` и `docker inspect`.
# Production — из файла (RELAY_TURN_SECRET_FILE, docker secrets), dev — RELAY_TURN_SECRET.
# Аргументы (command в compose) добавляются к флагам и перекрывают turnserver.conf: production расширяет диапазон
# портов и полосу и сбрасывает права на nobody (deploy/docker-compose.prod.yml, docker-compose.secure.yml).
set -eu
self=$(hostname -i | awk '{print $1}')
if [ -n "${RELAY_TURN_SECRET_FILE:-}" ]; then secret=$(cat "$RELAY_TURN_SECRET_FILE"); else secret="${RELAY_TURN_SECRET:?set RELAY_TURN_SECRET or RELAY_TURN_SECRET_FILE}"; fi
conf=$(mktemp)   # 600: только владелец процесса
{ cat /etc/coturn/turnserver.conf; printf 'static-auth-secret=%s\n' "$secret"; } > "$conf"
unset secret RELAY_TURN_SECRET
exec turnserver -c "$conf" \
  --relay-ip="$self" \
  --external-ip="$RELAY_TURN_EXTERNAL_IP/$self" \
  --allowed-peer-ip="$self" \
  "$@"
