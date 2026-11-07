# Общее для deploy/*.sh (подключается через «.»). POSIX sh.
# RELAY_DIR — корень checkout на сервере (/opt/relay); состояние развёртывания — deploy/state/ (вне git).

RELAY_DIR="${RELAY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
STATE_DIR="$RELAY_DIR/deploy/state"
ENV_FILE="$RELAY_DIR/.env"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-relay}"   # проверка на машине с dev-стеком — другое имя

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# docker compose со всеми слоями. RELAY_TAG — из окружения или текущего развёрнутого (state/current).
# RELAY_OBSERVABILITY=1 в .env — ещё и deploy/docker-compose.observability.yml с профилем observability (метрики,
# тревоги, панель — docs/observability.md). RELAY_COMPOSE_EXTRA — ещё один слой (проверка на другой машине: свои порты)
compose() {
  if [ -z "${RELAY_TAG:-}" ] && [ -f "$STATE_DIR/current" ]; then RELAY_TAG=$(cat "$STATE_DIR/current"); fi
  obs=""
  if [ "$(env_get RELAY_OBSERVABILITY)" = 1 ]; then obs="$RELAY_DIR/deploy/docker-compose.observability.yml"; fi
  RELAY_TAG="${RELAY_TAG:-none}" COMPOSE_PROFILES="${obs:+observability}" docker compose --project-directory "$RELAY_DIR" --env-file "$ENV_FILE" \
    -f "$RELAY_DIR/docker-compose.yml" -f "$RELAY_DIR/docker-compose.secure.yml" -f "$RELAY_DIR/deploy/docker-compose.prod.yml" \
    ${obs:+-f "$obs"} ${RELAY_COMPOSE_EXTRA:+-f "$RELAY_COMPOSE_EXTRA"} "$@"
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

# секреты на хосте (docker secrets): deploy/make-secrets.sh, deploy/bao-init.sh, deploy/set-secret.sh
SECRETS_RUN="$RELAY_DIR/secrets/run"

# Все секреты стека — файлы secrets/run/<имя>, и только эти имена. Список один: make-secrets.sh создаёт ровно их,
# проверки читают только их (tools/ci/deploy.test.ts сверяет со списком secrets: в compose-файлах).
# ПЕЧАТАТЬ можно только эти имена — и никогда значения или имена других файлов: по ошибке именем файла может
# оказаться сам секрет (вставили токен вместо имени), а вывод deploy.sh виден в публичном логе GitHub Actions.
SECRET_NAMES="pg_password valkey_password s3_access_key_id s3_secret_access_key meili_master_key meili_search_key
key_token_server key_token_worker key_service_tokens key_service_audit_key vault_token bao_backup_token turn_secret
livekit_api_key livekit_api_secret livekit_keys telegram_bot_token telegram_webhook_secret grafana_admin_password"
SECRET_NAMES=$(printf '%s' "$SECRET_NAMES" | tr '\n' ' ')   # одной строкой через пробел

is_secret_name() { case " $SECRET_NAMES " in *" $1 "*) [ -n "$1" ] ;; *) return 1 ;; esac; }

# сколько в secrets/run файлов с неизвестными именами (сами имена не выводятся никогда)
secrets_unexpected() {
  n=0
  for f in "$SECRETS_RUN"/* "$SECRETS_RUN"/.[!.]* "$SECRETS_RUN"/..?*; do
    [ -e "$f" ] || continue
    is_secret_name "${f##*/}" || n=$((n + 1))
  done
  echo "$n"
}

# secrets_leak_check <файл>: есть ли в файле (вывод docker inspect) значение какого-либо секрета.
# 0 — нет; 1 — есть (печатаются только имена из SECRET_NAMES); 2 — в secrets/run посторонние файлы (печатается число).
# Шаблоны — строки файла секрета без пробелов по краям, не короче 8 символов (пустая строка как шаблон grep совпала бы
# со всем), через временный файл 600: значения не попадают ни в вывод, ни в аргументы.
secrets_leak_check() {
  n=$(secrets_unexpected)
  if [ "$n" -gt 0 ]; then
    log "unexpected file(s) in secrets/run: $n — names not shown (a name may itself be a secret). Allowed: $SECRET_NAMES"
    return 2
  fi
  pat=$(mktemp); chmod 600 "$pat"
  leaked=""
  for name in $SECRET_NAMES; do
    [ -s "$SECRETS_RUN/$name" ] || continue
    awk '{ sub(/^[ \t\r]+/, ""); sub(/[ \t\r]+$/, ""); if (length($0) >= 8) print }' "$SECRETS_RUN/$name" > "$pat"
    [ -s "$pat" ] || continue
    if grep -qF -f "$pat" "$1"; then leaked="$leaked $name"; fi
  done
  rm -f "$pat"
  if [ -n "$leaked" ]; then log "SECRET LEAK: value of$leaked is visible in docker inspect — secrets must be files only"; return 1; fi
  return 0
}

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
