#!/bin/sh
# Распечатать OpenBao после перезапуска контейнера или сервера (до этого Relay не разворачивает ключи чатов):
#   /opt/relay/deploy/bao-unseal.sh
# Ключ вводится в приглашение самого bao внутри контейнера (без эха): он не проходит через этот скрипт,
# аргументы и историю shell. Нужно 2 ключа из 3.
set -eu
. "$(dirname "$0")/lib.sh"

[ -t 0 ] || die "interactive only: run it in a terminal (ssh -t)"
if [ -z "$(compose ps -q openbao 2>/dev/null)" ]; then
  log "openbao is not running — starting it"
  compose up -d openbao >/dev/null
  sleep 3
fi

i=0
while :; do
  state=$(bao_state)
  case "$state" in
    unsealed) log "openbao is unsealed"; break ;;
    sealed) ;;
    uninitialized) die "openbao is not initialized: deploy/bao-init.sh" ;;
    *) die "openbao does not answer (deploy/compose.sh logs openbao)" ;;
  esac
  i=$((i + 1)); [ "$i" -le 5 ] || die "still sealed after 5 attempts"
  log "enter an unseal key (input hidden)"
  compose exec openbao bao operator unseal || log "key rejected"
done

# сервисы, упавшие без ключей, пока OpenBao был запечатан, — поднять снова
if [ -f "$STATE_DIR/current" ]; then compose up -d >/dev/null && log "stack is up ($(cat "$STATE_DIR/current"))"; fi
