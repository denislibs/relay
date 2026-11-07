#!/bin/sh
# Что развёрнуто и в каком состоянии: версии, здоровье сервисов, OpenBao (запечатан ли), сроки сертификатов.
#   deploy/status.sh
set -eu
. "$(dirname "$0")/lib.sh"

echo "== versions"
echo "current:  $(cat "$STATE_DIR/current" 2>/dev/null || echo none)"
echo "previous: $(cat "$STATE_DIR/previous" 2>/dev/null || echo none)"
echo "checkout: $(git -C "$RELAY_DIR" rev-parse HEAD 2>/dev/null || echo '?')"
if [ -f "$STATE_DIR/history" ]; then echo "last deploys:"; tail -n 5 "$STATE_DIR/history" | sed 's/^/  /'; fi

echo
echo "== services"
for s in openbao keys server worker proxy postgres valkey s3 search turn livekit; do
  printf '  %-9s %s\n' "$s" "$(service_health "$s")"
done

echo
echo "== openbao"
state=$(bao_state)
echo "  state: $state"
case "$state" in
  sealed) echo "  → deploy/bao-unseal.sh (needs 2 of 3 unseal keys)" ;;
  unsealed)
    BAO_T=$(cat "$SECRETS_RUN/vault_token" 2>/dev/null || true)
    if [ -n "$BAO_T" ]; then
      ttl=$(bao_t token lookup -format=json < /dev/null 2>/dev/null | sed -n 's/^ *"ttl": \([0-9]*\).*/\1/p' | head -n 1)
      if [ -n "$ttl" ]; then echo "  keys service token ttl: $((ttl / 3600))h"; else echo "  keys service token: invalid or expired!"; fi
    fi ;;
esac

echo
echo "== certificates (expiry)"
# только известные сертификаты (вывод status уходит и в лог CI: никаких имён из каталогов)
for name in public/server tls/ca tls/postgres tls/valkey tls/s3 tls/search tls/keys tls/bao tls/client; do
  f="$RELAY_DIR/secrets/$name.pem"
  [ -r "$f" ] || continue
  printf '  %-22s %s\n' "${name#*/}.pem" "$(openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2)"
done
n=$(secrets_unexpected)
[ "$n" = 0 ] || echo "  WARNING: $n unexpected file(s) in secrets/run (names not shown) — deploy.sh refuses to run"

echo
echo "== disk"
for d in / /srv/relay-s3 /srv/relay-backups; do [ -d "$d" ] && df -h "$d" | tail -n 1 | sed 's/^/  /'; done
