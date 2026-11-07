#!/bin/sh
# Первый запуск OpenBao (один раз, от root, после make-secrets.sh и certs.sh — docs/deploy.md):
#   sudo /opt/relay/deploy/bao-init.sh
# 1. init: 3 ключа распечатки, нужно 2. Вывод (ключи и root-токен) — ТОЛЬКО в файл root с правами 600
#    (BAO_INIT_FILE, по умолчанию /root/relay-openbao-init.json); на экран не печатается.
# 2. распечатать двумя ключами из файла, включить transit, создать ключ relay-chat-keys;
# 3. политика relay-keys: encrypt/decrypt/rewrap этим ключом и чтение его версии (crypto/kms.ts: stale) — и всё;
# 4. периодический токен с этой политикой — в secrets/run/vault_token (docker secret сервиса ключей), не печатая;
#    второй — только снимок raft для бэкапа (secrets/run/bao_backup_token, deploy/backup.sh); продление —
#    deploy/bao-renew.sh; в контейнер токены идут через stdin, не аргументом и не окружением;
# 5. отозвать root-токен (он больше не нужен; при необходимости — bao operator generate-root ключами распечатки).
# Повторный запуск продолжает с прерванного шага; после шага 5 — ничего не делает.
# Потом: разнести 3 ключа распечатки по трём разным местам (менеджер паролей, бумага в сейфе, …) и удалить файл.
set -eu
. "$(dirname "$0")/lib.sh"

INIT_FILE="${BAO_INIT_FILE:-/root/relay-openbao-init.json}"
KEY=relay-chat-keys
POLICY=relay-keys

[ "$(id -u)" = 0 ] || die "run as root (sudo): the init output must be readable by root only"
command -v jq >/dev/null || die "jq is required (apt install jq)"
[ -f "$SECRETS_RUN/vault_token" ] || die "$SECRETS_RUN missing: run deploy/make-secrets.sh first"

log "starting openbao"
compose up -d openbao >/dev/null
# отвечает: bao status — 0 (распечатан) или 2 (запечатан); 1 — ошибка связи
answers() { rc=0; compose exec -T openbao bao status >/dev/null 2>&1 || rc=$?; [ "$rc" = 0 ] || [ "$rc" = 2 ]; }
i=0
until answers; do
  i=$((i + 1)); [ "$i" -lt 30 ] || die "openbao does not answer (deploy/compose.sh logs openbao)"
  sleep 2
done

state=$(bao_state)
if [ "$state" = uninitialized ]; then
  log "init: 3 key shares, threshold 2 → $INIT_FILE"
  (umask 077; compose exec -T openbao bao operator init -key-shares=3 -key-threshold=2 -format=json > "$INIT_FILE.tmp")
  jq -e '.unseal_keys_b64 | length == 3' "$INIT_FILE.tmp" >/dev/null || die "unexpected init output (kept in $INIT_FILE.tmp)"
  mv "$INIT_FILE.tmp" "$INIT_FILE"
  chmod 600 "$INIT_FILE"
elif [ ! -f "$INIT_FILE" ] || [ "$(jq -r '.root_token // empty' "$INIT_FILE")" = "" ]; then
  [ -s "$SECRETS_RUN/vault_token" ] || die "OpenBao is initialized, but $INIT_FILE has no root token: finish by hand (bao operator generate-root)"
  log "already initialized and set up (root token revoked) — nothing to do"
  exit 0
fi

if [ "$(bao_state)" = sealed ]; then
  log "unsealing with 2 of 3 keys from $INIT_FILE"
  # ключ — через stdin (key=-): ни в аргументах, ни в списке процессов хоста
  for n in 0 1; do
    jq -r ".unseal_keys_b64[$n]" "$INIT_FILE" | compose exec -T openbao bao write sys/unseal key=- >/dev/null
  done
fi
[ "$(bao_state)" = unsealed ] || die "openbao is still sealed"

# root-токен — только в переменной shell (BAO_T, не экспортируется): в контейнер — через stdin (lib.sh: bao_t)
BAO_T=$(jq -r .root_token "$INIT_FILE")

if ! bao_t secrets list -format=json < /dev/null | jq -e 'has("transit/")' >/dev/null; then
  log "enable transit"
  bao_t secrets enable transit < /dev/null >/dev/null
fi
if ! bao_t read -format=json "transit/keys/$KEY" < /dev/null >/dev/null 2>&1; then
  log "create transit key $KEY (aes256-gcm96, not exportable, deletion not allowed)"
  bao_t write -f "transit/keys/$KEY" type=aes256-gcm96 < /dev/null >/dev/null
fi

log "policy $POLICY"
bao_t_in policy write "$POLICY" - >/dev/null <<HCL
# сервис ключей Relay (apps/server/src/keyService.ts): завернуть/развернуть/перезавернуть ключ чата, узнать версию
path "transit/encrypt/$KEY" { capabilities = ["update"] }
path "transit/decrypt/$KEY" { capabilities = ["update"] }
path "transit/rewrap/$KEY"  { capabilities = ["update"] }
path "transit/keys/$KEY"    { capabilities = ["read"] }
HCL
# бэкап (deploy/backup.sh): снимок raft — и больше ничего
log "policy relay-backup"
bao_t_in policy write relay-backup - >/dev/null <<HCL
path "sys/storage/raft/snapshot" { capabilities = ["read"] }
HCL

# token <файл секрета> <политика> <имя>: есть действующий — оставить, нет — выпустить периодический и записать
# в файл на месте (не печатая)
token() {
  file="$1"; policy="$2"; name="$3"
  [ -f "$SECRETS_RUN/$file" ] || die "$SECRETS_RUN/$file missing: run deploy/make-secrets.sh first"
  current=$(cat "$SECRETS_RUN/$file")
  # shellcheck disable=SC2034  # BAO_T читает bao_t (lib.sh)
  if [ -n "$current" ] && (BAO_T="$current"; bao_t token lookup < /dev/null >/dev/null 2>&1); then
    log "$file: valid token kept"
    return 0
  fi
  log "$file: periodic token ($policy, 768h) generated"
  t=$(bao_t token create -orphan -policy="$policy" -period=768h -display-name="$name" -format=json < /dev/null | jq -r .auth.client_token)
  if [ -z "$t" ] || [ "$t" = null ]; then die "token create failed"; fi
  secret_write "$file" "$t"
  unset t
}
token vault_token "$POLICY" relay-keys-service
token bao_backup_token relay-backup relay-backup

log "revoke root token"
bao_t token revoke -self < /dev/null >/dev/null
unset BAO_T
tmp="$INIT_FILE.tmp"
(umask 077; jq 'del(.root_token) | .root_token_revoked = true' "$INIT_FILE" > "$tmp")
mv "$tmp" "$INIT_FILE"

# сервис ключей уже запущен (повторная настройка) — перечитать токен из файла
if [ -n "$(compose ps -q keys 2>/dev/null)" ]; then compose restart keys >/dev/null; fi

log "done. Unseal keys: $INIT_FILE (root only). Put each of the 3 keys in a separate safe place, then: shred -u $INIT_FILE"
