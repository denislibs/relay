#!/bin/sh
# Бэкап Postgres в две части (план docs/plans/2026-10-21-relay-at-rest-encryption.md, этап 6):
#   data — всё, кроме схемы keys: переписка в нём только шифром; хранится долго (DATA_DAYS, по умолчанию 30);
#   keys — только схема keys (ключи чатов, завёрнутые главным ключом KMS); хранится коротко (KEYS_DAYS, по умолчанию 7).
# Удалённый ключ чата (удаление чата, «удалить у обоих») исчезает из бэкапов ключей через KEYS_DAYS дней — после этого
# удалённое не открыть ни из какого бэкапа данных. Храните две части в разных местах и с разными правами.
#
#   DATABASE_URL=postgres://… OUT=/backups ./tools/backup/pg-backup.sh
set -eu
umask 077   # дампы — только владельцу (CRYPTO-16)
: "${DATABASE_URL:?set DATABASE_URL}"
OUT="${OUT:-./backups}"; DATA_DAYS="${DATA_DAYS:-30}"; KEYS_DAYS="${KEYS_DAYS:-7}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT/data" "$OUT/keys"
# AGE_DATA / AGE_KEYS — получатели age (разные ключи): дампы шифруются, одна утечка не даёт обоих (CRYPTO-16)
pg_dump "$DATABASE_URL" --format=custom --exclude-schema=keys --file="$OUT/data/relay-data-$stamp.dump"
pg_dump "$DATABASE_URL" --format=custom --schema=keys --file="$OUT/keys/relay-keys-$stamp.dump"
if [ -n "${AGE_DATA:-}" ]; then age -r "$AGE_DATA" -o "$OUT/data/relay-data-$stamp.dump.age" "$OUT/data/relay-data-$stamp.dump" && rm "$OUT/data/relay-data-$stamp.dump"; fi
if [ -n "${AGE_KEYS:-}" ]; then age -r "$AGE_KEYS" -o "$OUT/keys/relay-keys-$stamp.dump.age" "$OUT/keys/relay-keys-$stamp.dump" && rm "$OUT/keys/relay-keys-$stamp.dump"; fi
# сроки хранения в минутах, а не -mtime: «+7» у find значит «8 и больше суток» (CRYPTO-16)
find "$OUT/keys" -name 'relay-keys-*.dump*' -mmin +"$((KEYS_DAYS * 1440))" -delete
find "$OUT/data" -name 'relay-data-*.dump*' -mmin +"$((DATA_DAYS * 1440))" -delete
echo "backup $stamp: data → $OUT/data, keys → $OUT/keys (keys kept $KEYS_DAYS days, data $DATA_DAYS days)"
