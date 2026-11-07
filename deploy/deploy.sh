#!/bin/sh
# Выкатить версию <sha> на этот сервер (запускает .github/workflows/deploy.yml по SSH, можно и руками):
#   /opt/relay/deploy/deploy.sh <git sha>
# Шаги: checkout того же коммита (конфиги compose/nginx) → pull образов → migrate → up -d → ждать healthy
# server/worker/keys/proxy → проверка https://<домен>/ (/version.json = sha) и API (/health, /ready) → записать тег.
# Ошибка на любом шаге после checkout — откат на прежний тег тем же путём и выход с ненулевым кодом.
# Миграции не откатываются: CI пропускает только совместимые с прежним кодом (tools/ci/migration-lint.ts).
#
# Всё тело — в функции: sh читает файл по ходу выполнения, а git checkout ниже может его подменить.
set -eu
. "$(dirname "$0")/lib.sh"

HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"     # секунд на healthy всех сервисов
WAIT_SERVICES="keys server worker proxy"

main() {
  sha="${1:-}"
  case "$sha" in
    *[!0-9a-f]* | "") die "usage: deploy.sh <git sha (hex)>" ;;
  esac
  [ "${#sha}" -ge 7 ] || die "sha too short: $sha"
  NO_ROLLBACK="${NO_ROLLBACK:-0}"

  mkdir -p "$STATE_DIR"
  # одно развёртывание за раз (CI тоже держит concurrency-группу; это — от ручного запуска параллельно)
  if ! mkdir "$STATE_DIR/lock" 2>/dev/null; then
    die "another deploy is running ($STATE_DIR/lock; remove it if no deploy.sh is running)"
  fi
  trap 'rmdir "$STATE_DIR/lock" 2>/dev/null || true' EXIT INT TERM

  preflight
  # образы помечены полным sha (deploy.yml) — короткий из командной строки раскрываем по git
  if ! git -C "$RELAY_DIR" cat-file -e "$sha^{commit}" 2>/dev/null; then
    git -C "$RELAY_DIR" fetch --quiet origin || die "git fetch failed"
  fi
  sha=$(git -C "$RELAY_DIR" rev-parse --verify --quiet "$sha^{commit}") || die "unknown commit: $1 (pushed to origin?)"
  prev=$(cat "$STATE_DIR/current" 2>/dev/null || true)
  log "deploy $sha (current: ${prev:-none})"

  if release "$sha"; then
    [ "$prev" = "$sha" ] || printf '%s\n' "$prev" > "$STATE_DIR/previous"
    printf '%s\n' "$sha" > "$STATE_DIR/current"
    printf '%s deploy %s ok\n' "$(date -u +%FT%TZ)" "$sha" >> "$STATE_DIR/history"
    log "deployed $sha"
    return 0
  fi

  printf '%s deploy %s FAILED\n' "$(date -u +%FT%TZ)" "$sha" >> "$STATE_DIR/history"
  if [ "$NO_ROLLBACK" = 1 ] || [ -z "$prev" ] || [ "$prev" = "$sha" ]; then
    log "deploy of $sha failed; no rollback (previous: ${prev:-none})"
    compose ps >&2 || true
    return 1
  fi
  log "deploy of $sha failed — rolling back to $prev"
  if release "$prev"; then
    printf '%s rollback %s ok (after failed %s)\n' "$(date -u +%FT%TZ)" "$prev" "$sha" >> "$STATE_DIR/history"
    log "rolled back to $prev; $sha is NOT deployed"
    return 1
  fi
  printf '%s rollback %s FAILED\n' "$(date -u +%FT%TZ)" "$prev" >> "$STATE_DIR/history"
  log "rollback to $prev FAILED too — manual action needed (deploy/status.sh, deploy/compose.sh logs)"
  return 2
}

preflight() {
  command -v docker >/dev/null || die "docker not found"
  command -v git >/dev/null || die "git not found"
  command -v curl >/dev/null || die "curl not found"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing: run deploy/make-secrets.sh first (docs/deploy.md)"
  [ -s "$SECRETS_RUN/pg_password" ] || die "$SECRETS_RUN missing: run deploy/make-secrets.sh first (docs/deploy.md)"
  [ -s "$SECRETS_RUN/telegram_bot_token" ] || die "secrets/run/telegram_bot_token is empty (docs/code-delivery.md)"
  [ -s "$SECRETS_RUN/vault_token" ] || die "secrets/run/vault_token is empty: run deploy/bao-init.sh"
  case "$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")" in
    600 | 400) ;;
    *) die "$ENV_FILE must be chmod 600" ;;
  esac
  [ -n "$(env_get RELAY_DOMAIN)" ] || die "RELAY_DOMAIN is empty in .env"
  [ -f "$RELAY_DIR/secrets/public/server.pem" ] || die "secrets/public/server.pem missing (docs/deploy.md, «Сертификат домена»)"
  # пакеты ghcr.io приватные — нужен docker login; публичные тянутся и без него
  if ! grep -q '"ghcr.io"' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null; then
    log "note: no docker login for ghcr.io — fine for public packages (docs/deploy.md, «Доступ к GHCR»)"
  fi
  # без распечатанного OpenBao сервис ключей не развернёт ни одного ключа чата — не начинаем
  state=$(bao_state)
  case "$state" in
    unsealed) ;;
    sealed) die "OpenBao is sealed: run deploy/bao-unseal.sh, then retry" ;;
    uninitialized) die "OpenBao is not initialized: run deploy/bao-init.sh (docs/deploy.md)" ;;
    *) die "OpenBao is not running: deploy/compose.sh up -d openbao, then deploy/bao-unseal.sh" ;;
  esac
}

# выкатить один тег; 0 — всё здорово и проверки прошли
release() {
  tag="$1"
  export RELAY_TAG="$tag"
  log "[$tag] checkout"
  # правленые руками файлы checkout не затирает — лучше остановиться, чем выкатить не то
  if [ -n "$(git -C "$RELAY_DIR" status --porcelain --untracked-files=no)" ]; then
    log "local changes in $RELAY_DIR (git status) — refusing to checkout"; return 1
  fi
  git -C "$RELAY_DIR" -c advice.detachedHead=false checkout --quiet --detach "$tag" || { log "git checkout $tag failed"; return 1; }

  log "[$tag] pull images"
  compose pull --quiet --ignore-buildable || { log "pull failed"; return 1; }
  log "[$tag] migrate"
  compose run --rm -T migrate || { log "migrate failed"; return 1; }
  log "[$tag] up"
  compose up -d --remove-orphans || { log "compose up failed"; return 1; }
  wait_healthy || return 1
  no_secrets_in_inspect || return 1
  meili_key || return 1
  bao_renew
  smoke "$tag" || return 1
}

wait_healthy() {
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    pending=""
    for s in $WAIT_SERVICES; do
      h=$(service_health "$s")
      case "$h" in
        healthy) ;;
        # упавший может ещё подняться (restart), пока не вышло время
        unhealthy | exited | dead | missing) pending="$pending $s:$h" ;;
        *) pending="$pending $s:$h" ;;
      esac
    done
    [ -z "$pending" ] && { log "healthy: $WAIT_SERVICES"; return 0; }
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "not healthy after ${HEALTH_TIMEOUT}s:$pending"
      for s in $pending; do compose logs --tail=40 "${s%%:*}" >&2 || true; done
      return 1
    fi
    sleep 3
  done
}

# ни одного значения из secrets/run в `docker inspect` контейнеров стека (окружение, аргументы, метки): секреты —
# только файлами. Сравнение — grep -F -f по файлу секрета: значения не попадают ни в аргументы, ни в вывод
no_secrets_in_inspect() {
  ids=$(compose ps -q)
  [ -n "$ids" ] || return 0
  dump=$(mktemp); chmod 600 "$dump"
  # shellcheck disable=SC2086
  docker inspect $ids > "$dump"
  leaked=""
  for f in "$SECRETS_RUN"/*; do
    [ -s "$f" ] || continue
    grep -qF -f "$f" "$dump" && leaked="$leaked $(basename "$f")"
  done
  rm -f "$dump"
  [ -z "$leaked" ] || { log "SECRET LEAK: value of$leaked is visible in docker inspect — secrets must be files only"; return 1; }
  log "docker inspect: no secret values"
}

# ключ «только поиск» у Meilisearch: make-secrets.sh вывел его из мастер-ключа заранее (meili_search_key), здесь —
# создать ключ с тем же uid (идемпотентно) и сверить, что Meilisearch выдал именно его. Значение не печатается.
meili_key() {
  got=$(compose exec -T worker bun apps/server/src/dev/meiliKeys.ts 2>/dev/null | sed -n 's/^MEILI_API_KEY=\([0-9a-f]*\).*/\1/p')
  [ -n "$got" ] || { log "meilisearch: cannot create the search-only key (apps/server/src/dev/meiliKeys.ts)"; return 1; }
  [ "$got" = "$(cat "$SECRETS_RUN/meili_search_key")" ] || { log "meilisearch: secrets/run/meili_search_key does not match the key Meilisearch derived — search in server is broken"; return 1; }
}

# токен сервиса ключей периодический: продлеваем на каждом развёртывании (и cron, docs/deploy.md)
bao_renew() {
  sh "$RELAY_DIR/deploy/bao-renew.sh" >/dev/null 2>&1 || log "warning: OpenBao token renew failed (deploy/bao-renew.sh)"
}

smoke() {
  tag="$1"; domain=$(env_get RELAY_DOMAIN)
  # по умолчанию — на этот же хост (127.0.0.1:443), но с проверкой сертификата по имени домена;
  # SMOKE_CONNECT=адрес:порт — другой вход, SMOKE_DIRECT=1 — через DNS, как браузер
  resolve="--connect-to $domain:443:${SMOKE_CONNECT:-127.0.0.1:443}"
  [ "${SMOKE_DIRECT:-0}" = 1 ] && resolve=""
  i=0
  while :; do
    # shellcheck disable=SC2086
    build=$(curl -fsS --max-time 10 $resolve "https://$domain/version.json" 2>/dev/null || true)
    # shellcheck disable=SC2086
    health=$(curl -fsS --max-time 10 $resolve "https://$domain/health" 2>/dev/null || true)
    # shellcheck disable=SC2086
    ready=$(curl -fsS --max-time 10 $resolve "https://$domain/ready" 2>/dev/null || true)
    # shellcheck disable=SC2086
    page=$(curl -fsS --max-time 10 $resolve -o /dev/null -w '%{http_code}' "https://$domain/" 2>/dev/null || true)
    case "$build|$health|$ready|$page" in
      *"\"build\":\"$tag\""*'|'*'"ok":true'*'|'*'"ok":true'*'|200') log "smoke ok: https://$domain/ serves $tag, API healthy and ready"; return 0 ;;
    esac
    i=$((i + 1))
    if [ "$i" -ge 10 ]; then
      log "smoke failed: version.json=[$build] /health=[$health] /ready=[$ready] / → [$page]"
      return 1
    fi
    sleep 3
  done
}

main "$@"; exit $?
