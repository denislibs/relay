#!/bin/sh
# Бэкап Postgres в две части (план docs/plans/2026-10-21-relay-at-rest-encryption.md, этап 6):
#   data — всё, кроме схемы keys: переписка в нём только шифром; хранится долго (DATA_DAYS, по умолчанию 30);
#   keys — только схема keys (ключи чатов, завёрнутые главным ключом KMS); хранится коротко (KEYS_DAYS, по умолчанию 7).
# Удалённый ключ чата (удаление чата, «удалить у обоих») исчезает из бэкапов ключей через KEYS_DAYS дней — после этого
# удалённое не открыть ни из какого бэкапа данных. Храните две части в разных местах и с разными правами.
#
#   DATABASE_URL=postgres://… OUT=/backups ./tools/backup/pg-backup.sh
#   PG_DUMP="docker compose … exec -T postgres pg_dump -U relay -d relay" OUT=… ./tools/backup/pg-backup.sh
#     — pg_dump внутри контейнера (deploy/backup.sh): тогда DATABASE_URL не нужен
set -eu
umask 077   # дампы — только владельцу (CRYPTO-16)
[ -n "${PG_DUMP:-}" ] || : "${DATABASE_URL:?set DATABASE_URL}"
OUT="${OUT:-./backups}"; DATA_DAYS="${DATA_DAYS:-30}"; KEYS_DAYS="${KEYS_DAYS:-7}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT/data" "$OUT/keys"

pgdump() { if [ -n "${PG_DUMP:-}" ]; then $PG_DUMP "$@"; else pg_dump "$DATABASE_URL" "$@"; fi; }
# AGE_DATA / AGE_KEYS — получатели age (разные ключи): дампы шифруются, одна утечка не даёт обоих (CRYPTO-16).
# С получателем дамп идёт в age потоком — расшифрованный на диск не ложится. Ошибку pg_dump в конвейере видно
# по файлу-метке (в POSIX sh нет pipefail).
save() {
  file="$1"; recipient="$2"; shift 2
  if [ -z "$recipient" ]; then pgdump --format=custom "$@" > "$file"; return; fi
  failed="$file.failed"; rm -f "$failed"
  { pgdump --format=custom "$@" || : > "$failed"; } | age -r "$recipient" -o "$file.age"
  if [ -e "$failed" ]; then rm -f "$failed" "$file.age"; echo "pg_dump failed: $file" >&2; return 1; fi
}
save "$OUT/data/relay-data-$stamp.dump" "${AGE_DATA:-}" --exclude-schema=keys
save "$OUT/keys/relay-keys-$stamp.dump" "${AGE_KEYS:-}" --schema=keys
# сроки хранения в минутах, а не -mtime: «+7» у find значит «8 и больше суток» (CRYPTO-16)
find "$OUT/keys" -name 'relay-keys-*.dump*' -mmin +"$((KEYS_DAYS * 1440))" -delete
find "$OUT/data" -name 'relay-data-*.dump*' -mmin +"$((DATA_DAYS * 1440))" -delete
echo "backup $stamp: data → $OUT/data, keys → $OUT/keys (keys kept $KEYS_DAYS days, data $DATA_DAYS days)"
