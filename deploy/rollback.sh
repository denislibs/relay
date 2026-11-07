#!/bin/sh
# Вернуть прежнюю версию (или указанную): тот же путь, что deploy.sh — checkout, pull, migrate (ничего нового),
# up, healthy, проверки. Без отката «назад вперёд», если и она не поднимется.
#   deploy/rollback.sh            — на deploy/state/previous
#   deploy/rollback.sh <sha>      — на этот коммит (образы с этим тегом должны быть в GHCR)
# Из GitHub: Actions → deploy → Run workflow, tag = <sha>.
set -eu
. "$(dirname "$0")/lib.sh"

tag="${1:-$(cat "$STATE_DIR/previous" 2>/dev/null || true)}"
[ -n "$tag" ] || die "no previous deploy recorded ($STATE_DIR/previous): pass a sha"
log "rollback to $tag (current: $(cat "$STATE_DIR/current" 2>/dev/null || echo none))"
NO_ROLLBACK=1 exec sh "$RELAY_DIR/deploy/deploy.sh" "$tag"
