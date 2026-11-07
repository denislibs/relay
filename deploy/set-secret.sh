#!/bin/sh
# Записать значение секрета в secrets/run/<имя> — без эха, не аргументом и не в историю shell:
#   /opt/relay/deploy/set-secret.sh telegram_bot_token          — спросит значение (ввод скрыт)
#   /opt/relay/deploy/set-secret.sh telegram_bot_token < файл   — или первая строка stdin
# Имя — только из списка (deploy/lib.sh: SECRET_NAMES); неизвестное имя не печатается (вдруг это и есть значение).
# Файл переписывается на месте: права, владелец и inode (он смонтирован в контейнеры) сохраняются. Потом —
# перезапустить тех, кто его читает, например: deploy/compose.sh up -d --force-recreate server worker
set -eu
. "$(dirname "$0")/lib.sh"

name="${1:-}"
if ! is_secret_name "$name"; then
  die "usage: deploy/set-secret.sh <name>; name must be one of: $SECRET_NAMES (the argument is not shown)"
fi
[ -f "$SECRETS_RUN/$name" ] || die "secrets/run/$name does not exist: run deploy/make-secrets.sh first"

if [ -t 0 ]; then
  printf 'value for %s (input hidden): ' "$name" >&2
  stty -echo
  trap 'stty echo' EXIT INT TERM
  IFS= read -r value || true
  stty echo
  printf '\n' >&2
else
  IFS= read -r value || true
fi
# без пробелов по краям; пустое — не записываем
value=$(printf '%s' "$value" | awk '{ sub(/^[ \t\r]+/, ""); sub(/[ \t\r]+$/, ""); print }')
[ -n "$value" ] || die "empty value — secrets/run/$name not changed"
[ "${#value}" -ge 8 ] || die "value is shorter than 8 characters — secrets/run/$name not changed"
secret_write "$name" "$value"
unset value
log "secrets/run/$name updated (value not shown)"
