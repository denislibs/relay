#!/bin/sh
# Ночной бэкап боевого сервера (cron, пользователь deploy — docs/deploy.md, «Бэкапы»):
#   15 3 * * * /opt/relay/deploy/backup.sh >> /var/log/relay-backup.log 2>&1
# Что и куда (BACKUP_DIR, по умолчанию /srv/relay-backups), всё — age, расшифрованное на диск не ложится:
#   data/relay-data-*.dump.age   Postgres без схемы keys (tools/backup/pg-backup.sh)   → AGE_DATA, DATA_DAYS (30)
#   keys/relay-keys-*.dump.age   Postgres, схема keys (ключи чатов под главным ключом)  → AGE_KEYS, KEYS_DAYS (7)
#   keys/relay-bao-*.snap.age    снимок raft OpenBao (главный ключ; без ключей распечатки бесполезен) → AGE_KEYS, BAO_DAYS (90)
#   data/relay-s3-*.tar.age      /srv/relay-s3 (вложения — уже шифром на файл) → AGE_DATA, S3_DAYS (3); BACKUP_S3=0 — пропустить
# Получатели age и rclone — в .env (make-secrets.sh завёл пустые): AGE_DATA, AGE_KEYS — открытые ключи age, секретные
# части — не на этом сервере; BACKUP_RCLONE_DATA / BACKUP_RCLONE_KEYS — удалённые места (rclone copy: удалённые
# старые файлы — правилом хранилища, не отсюда). Разные места для data и keys — см. pg-backup.sh.
set -eu
. "$(dirname "$0")/lib.sh"

command -v age >/dev/null || die "age is required (apt install age)"
AGE_DATA=$(env_get AGE_DATA); AGE_KEYS=$(env_get AGE_KEYS)
if [ -z "$AGE_DATA" ] || [ -z "$AGE_KEYS" ]; then die "set AGE_DATA and AGE_KEYS (age public keys) in .env — unencrypted backups are not made"; fi
BACKUP_DIR="${BACKUP_DIR:-$(env_get BACKUP_DIR)}"; BACKUP_DIR="${BACKUP_DIR:-/srv/relay-backups}"
BAO_DAYS="${BAO_DAYS:-90}"; S3_DAYS="${S3_DAYS:-3}"; BACKUP_S3="${BACKUP_S3:-1}"
S3_DIR="$(env_get RELAY_S3_DIR)"; S3_DIR="${S3_DIR:-/srv/relay-s3}"

umask 077
mkdir -p "$BACKUP_DIR/data" "$BACKUP_DIR/keys"
if ! mkdir "$BACKUP_DIR/.lock" 2>/dev/null; then die "another backup is running ($BACKUP_DIR/.lock)"; fi
trap 'rmdir "$BACKUP_DIR/.lock" 2>/dev/null || true' EXIT INT TERM
stamp=$(date -u +%Y%m%dT%H%M%SZ)

# поток → age; ошибка источника видна по файлу-метке (как в pg-backup.sh)
stream() {
  out="$1"; recipient="$2"; shift 2
  failed="$out.failed"; rm -f "$failed"
  { "$@" || : > "$failed"; } | age -r "$recipient" -o "$out"
  if [ -e "$failed" ]; then rm -f "$failed" "$out"; die "backup step failed: $*"; fi
}

log "postgres"
PG_DUMP="sh $RELAY_DIR/deploy/compose.sh exec -T postgres pg_dump -U relay -d relay" OUT="$BACKUP_DIR" \
  AGE_DATA="$AGE_DATA" AGE_KEYS="$AGE_KEYS" sh "$RELAY_DIR/tools/backup/pg-backup.sh"

log "openbao snapshot"
# снимок raft — согласованный (копия файлов тома на ходу — нет); токен только на снимок (bao-init.sh)
[ -s "$SECRETS_RUN/bao_backup_token" ] || die "secrets/run/bao_backup_token is empty (deploy/bao-init.sh)"
# токен — первой строкой stdin контейнера (не аргументом и не окружением)
# shellcheck disable=SC2016  # $f раскрывается в контейнере
stream "$BACKUP_DIR/keys/relay-bao-$stamp.snap.age" "$AGE_KEYS" compose exec -T openbao sh -c \
  'read -r BAO_TOKEN; export BAO_TOKEN; f=/tmp/relay-backup.snap; bao operator raft snapshot save "$f" >/dev/null && cat "$f"; rc=$?; rm -f "$f"; exit $rc' \
  < "$SECRETS_RUN/bao_backup_token"
find "$BACKUP_DIR/keys" -name 'relay-bao-*.snap.age' -mmin +"$((BAO_DAYS * 1440))" -delete

if [ "$BACKUP_S3" = 1 ]; then
  log "s3 data ($S3_DIR)"
  # читает root в контейнере: файлы SeaweedFS принадлежат root, у deploy прав на них нет
  stream "$BACKUP_DIR/data/relay-s3-$stamp.tar.age" "$AGE_DATA" \
    docker run --rm --network none -v "$S3_DIR:/d:ro" --entrypoint tar chrislusf/seaweedfs:4.48 -C /d -cf - .
  find "$BACKUP_DIR/data" -name 'relay-s3-*.tar.age' -mmin +"$((S3_DAYS * 1440))" -delete
fi

for part in data keys; do
  var=BACKUP_RCLONE_DATA; [ "$part" = keys ] && var=BACKUP_RCLONE_KEYS
  remote=$(env_get "$var")
  [ -n "$remote" ] || { log "offsite $part: $var not set — local only"; continue; }
  command -v rclone >/dev/null || die "rclone is required for offsite copies (apt install rclone)"
  log "offsite $part → $remote"
  rclone copy --no-traverse --max-age 48h "$BACKUP_DIR/$part" "$remote"
done
log "backup $stamp done ($(du -sh "$BACKUP_DIR" | cut -f1) in $BACKUP_DIR)"
