#!/bin/sh
# Хук certbot после выпуска/продления сертификата домена (deploy-hook, от root): скопировать в secrets/public и
# перечитать nginx без простоя. Ставится один раз (docs/deploy.md, «Сертификат домена»):
#   ln -s /opt/relay/deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/relay.sh
# certbot передаёт RENEWED_LINEAGE (/etc/letsencrypt/live/<домен>); без него — RELAY_DOMAIN из .env.
set -eu
. "$(dirname "$0")/lib.sh"

lineage="${RENEWED_LINEAGE:-/etc/letsencrypt/live/$(env_get RELAY_DOMAIN)}"
[ -f "$lineage/fullchain.pem" ] || die "no certificate in $lineage"
out="$RELAY_DIR/secrets/public"
install -d -m 755 "$out"
# ключ читает мастер-процесс nginx (root) — владельцу root и 600 достаточно
install -m 644 -o root -g root "$lineage/fullchain.pem" "$out/server.pem"
install -m 600 -o root -g root "$lineage/privkey.pem" "$out/server-key.pem"
log "certificate from $lineage → $out"

if [ -n "$(compose ps -q proxy 2>/dev/null)" ]; then
  compose exec -T proxy nginx -s reload && log "nginx reloaded"
fi
