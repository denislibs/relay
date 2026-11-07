#!/bin/sh
# Метрики того, что ломается тихо (docs/observability.md, «Тревоги»), — файлом для node-exporter (textfile collector).
# cron пользователя deploy, раз в минуту:
#   * * * * * /opt/relay/deploy/host-metrics.sh
# Пишет deploy/state/metrics/relay_host.prom (вне git; node-exporter читает каталог), атомарно (tmp + mv):
#   relay_container_healthy{name}       1 — healthy или без проверки, 0 — unhealthy / starting / не запущен
#   relay_container_restarts{name}      RestartCount (перезапуски по кругу)
#   relay_cert_expiry_timestamp{cert}   конец срока сертификата домена и внутренних (secrets/tls)
#   relay_backup_last_timestamp{part}   время самого свежего файла бэкапа (data, keys)
#   relay_bao_token_ttl_seconds{token}  остаток срока токенов OpenBao — пишет bao-renew.sh в relay_bao.prom
#   relay_host_metrics_timestamp        когда скрипт отработал (тревога, если перестал)
# Ничего секретного: имена контейнеров, сроки, времена.
set -eu
. "$(dirname "$0")/lib.sh"

dir="${RELAY_METRICS_DIR:-$STATE_DIR/metrics}"
mkdir -p "$dir"
tmp=$(mktemp "$dir/.relay_host.XXXXXX")
trap 'rm -f "$tmp"' EXIT

{
  # одноразовые (migrate, s3-init) — выход 0 норма; строки одной метрики — подряд (формат Prometheus)
  states=$(for id in $(compose ps -aq 2>/dev/null); do
    docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$id" 2>/dev/null
  done | grep -v -E '^(migrate|s3-init) ' || true)
  echo '# TYPE relay_container_healthy gauge'
  printf '%s\n' "$states" | awk 'NF == 4 { ok = ($2 == "running" && ($3 == "healthy" || $3 == "none")) ? 1 : 0; printf "relay_container_healthy{name=\"%s\"} %d\n", $1, ok }'
  echo '# TYPE relay_container_restarts gauge'
  printf '%s\n' "$states" | awk 'NF == 4 { printf "relay_container_restarts{name=\"%s\"} %s\n", $1, $4 }'

  echo '# TYPE relay_cert_expiry_timestamp gauge'
  for f in "$RELAY_DIR/secrets/public/server.pem" "$RELAY_DIR"/secrets/tls/*.pem; do
    case "$f" in *-key.pem) continue ;; esac
    end=$(openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2) || continue
    [ -n "$end" ] || continue
    printf 'relay_cert_expiry_timestamp{cert="%s"} %s\n' "$(basename "$f" .pem)" "$(date -u -d "$end" +%s)"
  done

  echo '# TYPE relay_backup_last_timestamp gauge'
  bdir="$(env_get BACKUP_DIR)"; bdir="${bdir:-/srv/relay-backups}"
  for part in data keys; do
    last=$(find "$bdir/$part" -maxdepth 1 -name '*.age' -printf '%T@\n' 2>/dev/null | sort -n | tail -n 1 | cut -d. -f1)
    printf 'relay_backup_last_timestamp{part="%s"} %s\n' "$part" "${last:-0}"
  done

  echo '# TYPE relay_host_metrics_timestamp gauge'
  echo "relay_host_metrics_timestamp $(date +%s)"
} > "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$dir/relay_host.prom"
trap - EXIT
