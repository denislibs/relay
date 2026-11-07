#!/bin/sh
# Секреты боевого стека — файлами (docker secrets) и несекретные настройки — в .env. Ничего не печатает, кроме имён.
#   sudo env RELAY_DOMAIN=denigram.site RELAY_PUBLIC_IP=158.69.233.92 /opt/relay/deploy/make-secrets.sh
# secrets/run/<имя> — одно значение на файл; владелец — хозяин /opt/relay (deploy), группа 1000, права 640:
# процессы bun в контейнерах (uid/gid 1000) читают свои секреты, остальные сервисы читают их от root при старте.
# Идемпотентно: есть файл — не трогает (секреты не меняются под работающими данными), нет — создаёт; есть ключ в
# .env — не трогает. Пустые файлы telegram_bot_token и vault_token заполняют владелец (docs/code-delivery.md) и
# deploy/bao-init.sh; пока токена бота нет, production не стартует (tls.ts).
set -eu
. "$(dirname "$0")/lib.sh"

[ "$(id -u)" = 0 ] || die "run as root (sudo): secret files get owner deploy and group ${RELAY_SECRETS_GID:-1000}"
command -v openssl >/dev/null || die "openssl is required"
umask 077
owner=$(stat -c %u "$RELAY_DIR" 2>/dev/null || stat -f %u "$RELAY_DIR")
gid="${RELAY_SECRETS_GID:-1000}"
run="$RELAY_DIR/secrets/run"
install -d -m 750 -o "$owner" -g "$gid" "$RELAY_DIR/secrets" "$run"

made=""
# secret <имя> <команда, печатающая значение> — только если файла ещё нет
secret() {
  f="$run/$1"; shift
  [ -e "$f" ] && return 0
  "$@" > "$f.tmp"
  chown "$owner:$gid" "$f.tmp"; chmod 640 "$f.tmp"; mv "$f.tmp" "$f"
  made="$made $(basename "$f")"
}
hex() { openssl rand -hex "$1"; }
alnum() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | cut -c "1-$1"; }
empty() { :; }
read_secret() { cat "$run/$1"; }

secret pg_password hex 32
secret valkey_password hex 32
secret s3_access_key_id sh -c 'printf relay; openssl rand -base64 64 | tr -dc A-Za-z0-9 | cut -c 1-15'
secret s3_secret_access_key alnum 40

# Meilisearch: ключ «только поиск» Meilisearch выводит из мастер-ключа и uid ключа — HMAC-SHA256(мастер, uid),
# hex (meilisearch-auth: generate_key_as_hexa). Создаёт ключ с этим uid и сверяет значение deploy.sh
# (apps/server/src/dev/meiliKeys.ts, UID ниже должен совпадать с UID там). Мастер-ключ — через stdin, не аргументом.
MEILI_SEARCH_UID=6f1b0c52-5e2a-4c1e-9a7d-0000000000a1
secret meili_master_key hex 32
meili_search() {
  # openssl берёт ключ HMAC только аргументом (виден в ps) — поэтому python3 с ключом из stdin; нет его — openssl
  if command -v python3 >/dev/null; then
    python3 -c 'import hmac,hashlib,sys; k=sys.stdin.read().strip().encode(); print(hmac.new(k, sys.argv[1].encode(), hashlib.sha256).hexdigest())' "$MEILI_SEARCH_UID" < "$run/meili_master_key"
  else
    printf '%s' "$MEILI_SEARCH_UID" | openssl dgst -sha256 -mac HMAC -macopt "key:$(read_secret meili_master_key)" -r | cut -d' ' -f1
  fi
}
secret meili_search_key meili_search

# сервис ключей: токены server и worker, их же список для keys, ключ журнала аудита
secret key_token_server hex 32
secret key_token_worker hex 32
key_tokens() { printf 'server:%s,worker:%s\n' "$(read_secret key_token_server)" "$(read_secret key_token_worker)"; }
secret key_service_tokens key_tokens
secret key_service_audit_key openssl rand -base64 32
# токены OpenBao выпустит deploy/bao-init.sh (пишет в эти файлы на месте — смонтированные файлы не подменяются)
secret vault_token empty
secret bao_backup_token empty

# звонки: секрет TURN; ключ и секрет LiveKit — для server, и они же одной строкой «ключ: секрет» — для livekit
secret turn_secret hex 32
secret livekit_api_key sh -c 'printf relay; openssl rand -base64 64 | tr -dc A-Za-z0-9 | cut -c 1-12'
secret livekit_api_secret alnum 48
livekit_keys() { printf '%s: %s\n' "$(read_secret livekit_api_key)" "$(read_secret livekit_api_secret)"; }
secret livekit_keys livekit_keys

# Telegram: токен бота вписывает владелец (sudo -u deploy sh -c 'cat > /opt/relay/secrets/run/telegram_bot_token')
secret telegram_bot_token empty
secret telegram_webhook_secret hex 32

log "secrets in $run:${made:- nothing generated (all present)}"

# несекретное — в .env (в git не попадает, но и тайны в нём нет)
[ -f "$ENV_FILE" ] || install -m 600 -o "$owner" /dev/null "$ENV_FILE"
added=""
put() {
  grep -q "^$1=" "$ENV_FILE" && return 0
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  added="$added $1"
}
domain="${RELAY_DOMAIN:-}"; ip="${RELAY_PUBLIC_IP:-}"
grep -q '^# Relay' "$ENV_FILE" || printf '%s\n' "# Relay production settings (deploy/make-secrets.sh). No secrets here: they live in secrets/run/." >> "$ENV_FILE"
put RELAY_DOMAIN "$domain"
put S3_PUBLIC_ENDPOINT "${domain:+https://$domain:8333}"
put RELAY_TURN_HOST "${domain:+turn.$domain}"
put RELAY_TURN_EXTERNAL_IP "$ip"
put LIVEKIT_NODE_IP "$ip"
put VAULT_ADDR "https://openbao:8200"
put TELEGRAM_OWNER_CHAT_ID ""
put TELEGRAM_BOT_USERNAME ""
put TELEGRAM_LOGIN "0"
put TELEGRAM_WEBHOOK_URL "${domain:+https://$domain/auth/telegram/webhook}"
put AGE_DATA ""
put AGE_KEYS ""
put BACKUP_RCLONE_DATA ""
put BACKUP_RCLONE_KEYS ""
chown "$owner" "$ENV_FILE"; chmod 600 "$ENV_FILE"
log ".env:${added:- nothing added}"

missing=""
for k in RELAY_DOMAIN RELAY_TURN_EXTERNAL_IP TELEGRAM_OWNER_CHAT_ID AGE_DATA AGE_KEYS; do
  [ -n "$(env_get "$k")" ] || missing="$missing $k"
done
[ -s "$run/telegram_bot_token" ] || missing="$missing secrets/run/telegram_bot_token"
[ -z "$missing" ] || log "fill in by hand:$missing"
