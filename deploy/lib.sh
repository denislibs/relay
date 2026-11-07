# Общее для deploy/*.sh (подключается через «.»). POSIX sh.
# RELAY_DIR — корень checkout на сервере (/opt/relay); состояние развёртывания — deploy/state/ (вне git).

RELAY_DIR="${RELAY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
STATE_DIR="$RELAY_DIR/deploy/state"
ENV_FILE="$RELAY_DIR/.env"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-relay}"   # проверка на машине с dev-стеком — другое имя

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# docker compose со всеми тремя слоями. RELAY_TAG — из окружения или текущего развёрнутого (state/current).
# RELAY_COMPOSE_EXTRA — ещё один слой поверх (проверка на другой машине: свои порты; на сервере не нужен)
compose() {
  if [ -z "${RELAY_TAG:-}" ] && [ -f "$STATE_DIR/current" ]; then RELAY_TAG=$(cat "$STATE_DIR/current"); fi
  RELAY_TAG="${RELAY_TAG:-none}" docker compose --project-directory "$RELAY_DIR" --env-file "$ENV_FILE" \
    -f "$RELAY_DIR/docker-compose.yml" -f "$RELAY_DIR/docker-compose.secure.yml" -f "$RELAY_DIR/deploy/docker-compose.prod.yml" \
    ${RELAY_COMPOSE_EXTRA:+-f "$RELAY_COMPOSE_EXTRA"} "$@"
}

# значение из .env без загрузки всего файла в окружение (секреты не расползаются по дочерним процессам)
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# состояние контейнера сервиса: healthy | unhealthy | starting | running (без healthcheck) | exited | missing
service_health() {
  id=$(compose ps -q "$1" 2>/dev/null | head -n 1)
  [ -n "$id" ] || { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
}

# секреты на хосте (docker secrets): deploy/make-secrets.sh, deploy/bao-init.sh
SECRETS_RUN="$RELAY_DIR/secrets/run"

# bao <аргументы> с токеном из переменной shell BAO_T (не окружения): токен уходит в контейнер первой строкой
# stdin, а не аргументом или `exec -e` — его не видно ни в ps, ни в docker inspect. bao_t_in — то же, и дальше
# stdin вызывающего (политика, снимок для восстановления).
bao_t() { printf '%s\n' "$BAO_T" | compose exec -T openbao sh -c 'read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' sh "$@"; }
bao_t_in() { { printf '%s\n' "$BAO_T"; cat; } | compose exec -T openbao sh -c 'read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' sh "$@"; }

# записать значение в уже существующий файл секрета НА МЕСТЕ (смонтированный в контейнер файл не подменять: bind mount
# держит старый inode), права и владелец сохраняются
secret_write() { printf '%s\n' "$2" > "$SECRETS_RUN/$1"; }

# OpenBao: sealed | unsealed | uninitialized | down
bao_state() {
  out=$(compose exec -T openbao bao status -format=json 2>/dev/null) || true
  case "$out" in
    *'"initialized": false'*) echo uninitialized ;;
    *'"sealed": true'*) echo sealed ;;
    *'"sealed": false'*) echo unsealed ;;
    *) echo down ;;
  esac
}
