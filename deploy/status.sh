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
for f in "$RELAY_DIR/secrets/public/server.pem" "$RELAY_DIR"/secrets/tls/*.pem; do
  case "$f" in *-key.pem) continue ;; esac
  [ -r "$f" ] || continue
  printf '  %-22s %s\n' "$(basename "$f")" "$(openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2)"
done

echo
echo "== disk"
for d in / /srv/relay-s3 /srv/relay-backups; do [ -d "$d" ] && df -h "$d" | tail -n 1 | sed 's/^/  /'; done
