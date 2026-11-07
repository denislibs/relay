#!/bin/sh
# Внутренний CA и сертификаты сервисов на боевом сервере (от root): выпуск/перевыпуск (раз в год, сроки — status.sh)
#   sudo /opt/relay/deploy/certs.sh
# tools/tls/make-internal-certs.sh + владельцы ключей: ключи — 600, а процессы в контейнерах — не root, и
# прочитать ключ они могут, только если он их (на macOS/Docker Desktop это не видно, на Linux — обязательно):
#   client-key.pem, keys-key.pem — bun (uid 1000): server, worker, migrate, keys;
#   valkey-key.pem — valkey (uid 999);
#   postgres-key.pem, bao-key.pem — копирует с нужными правами entrypoint (от root); s3, search — от root.
# После перевыпуска — перезапустить стек: deploy/compose.sh up -d --force-recreate (OpenBao после этого — распечатать).
set -eu
. "$(dirname "$0")/lib.sh"

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
dir="$RELAY_DIR/secrets/tls"
sh "$RELAY_DIR/tools/tls/make-internal-certs.sh" "$dir"
chown root:root "$dir"/*.pem
chown 1000 "$dir/client-key.pem" "$dir/keys-key.pem"
chown 999 "$dir/valkey-key.pem"
chmod 600 "$dir"/*-key.pem
chmod 644 "$dir"/ca.pem "$dir"/postgres.pem "$dir"/valkey.pem "$dir"/s3.pem "$dir"/search.pem "$dir"/keys.pem "$dir"/bao.pem "$dir"/client.pem
# каталог: читать сертификаты (сроки в status.sh) может и deploy, ключи — нет
chmod 755 "$RELAY_DIR/secrets" "$dir"
log "internal certs ready in $dir"
