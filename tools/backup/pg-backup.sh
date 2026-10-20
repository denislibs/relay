#!/bin/sh
# Бэкап Postgres в две части (план docs/plans/2026-10-21-relay-at-rest-encryption.md, этап 6):
#   data — всё, кроме схемы keys: переписка в нём только шифром; хранится долго (DATA_DAYS, по умолчанию 30);
#   keys — только схема keys (ключи чатов, завёрнутые главным ключом KMS); хранится коротко (KEYS_DAYS, по умолчанию 7).
# Удалённый ключ чата (удаление чата, «удалить у обоих») исчезает из бэкапов ключей через KEYS_DAYS дней — после этого
# удалённое не открыть ни из какого бэкапа данных. Храните две части в разных местах и с разными правами.
#
#   DATABASE_URL=postgres://… OUT=/backups ./tools/backup/pg-backup.sh
set -eu
: "${DATABASE_URL:?set DATABASE_URL}"
OUT="${OUT:-./backups}"; DATA_DAYS="${DATA_DAYS:-30}"; KEYS_DAYS="${KEYS_DAYS:-7}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT/data" "$OUT/keys"
pg_dump "$DATABASE_URL" --format=custom --exclude-schema=keys --file="$OUT/data/relay-data-$stamp.dump"
pg_dump "$DATABASE_URL" --format=custom --schema=keys --file="$OUT/keys/relay-keys-$stamp.dump"
# сроки хранения: ключи — коротко, данные — дольше
find "$OUT/keys" -name 'relay-keys-*.dump' -mtime +"$KEYS_DAYS" -delete
find "$OUT/data" -name 'relay-data-*.dump' -mtime +"$DATA_DAYS" -delete
echo "backup $stamp: data → $OUT/data, keys → $OUT/keys (keys kept $KEYS_DAYS days, data $DATA_DAYS days)"
