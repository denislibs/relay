#!/bin/sh
# Запуск coturn: свой адрес в сети контейнеров — единственный разрешённый частный «собеседник» (обмен между двумя
# релеями этого же сервера, когда оба участника звонка идут через TURN). Остальные частные сети закрыты конфигом.
set -eu
self=$(hostname -i | awk '{print $1}')
exec turnserver -c /etc/coturn/turnserver.conf \
  --static-auth-secret="$RELAY_TURN_SECRET" \
  --relay-ip="$self" \
  --external-ip="$RELAY_TURN_EXTERNAL_IP/$self" \
  --allowed-peer-ip="$self"
