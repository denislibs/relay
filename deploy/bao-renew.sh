#!/bin/sh
# Продлить периодические токены OpenBao (период 768h, secrets/run): vault_token сервиса ключей — без продления он
# истечёт, и сервис ключей перестанет разворачивать ключи чатов; bao_backup_token — снимки для бэкапа.
# Вызывается из deploy.sh и cron (docs/deploy.md) — раз в сутки.
set -eu
. "$(dirname "$0")/lib.sh"

# renew <файл секрета>: продлить его токен (в контейнер — через stdin, lib.sh: bao_t)
renew() {
  BAO_T=$(cat "$SECRETS_RUN/$1" 2>/dev/null || true)
  [ -n "$BAO_T" ] || { log "$1 is empty (deploy/bao-init.sh) — skipped"; return 0; }
  bao_t token renew -format=json < /dev/null >/dev/null || { log "$1: renew failed"; return 1; }
  ttl=$(bao_t token lookup -format=json < /dev/null | sed -n 's/^ *"ttl": \([0-9]*\).*/\1/p' | head -n 1)
  unset BAO_T
  log "$1 renewed, ttl $(( ${ttl:-0} / 3600 ))h"
}
rc=0
renew vault_token || rc=1
renew bao_backup_token || rc=1
exit "$rc"
