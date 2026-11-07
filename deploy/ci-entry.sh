#!/bin/sh
# Принудительная команда для SSH-ключа CI (~deploy/.ssh/authorized_keys, docs/deploy.md):
#   restrict,command="/opt/relay/deploy/ci-entry.sh" ssh-ed25519 AAAA… github-actions-deploy
# Ключ из GitHub может только это (из $SSH_ORIGINAL_COMMAND), без shell, пробросов и pty:
#   deploy <sha>       — deploy.sh (sha — 7–40 hex)
#   rollback [<sha>]   — rollback.sh: на прежний тег или на указанный
#   status             — status.sh
set -euf   # -f: без подстановки имён файлов при разборе команды
dir=$(dirname "$0")
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
is_sha() { case "$1" in *[!0-9a-f]* | "") return 1 ;; esac; [ "${#1}" -ge 7 ] && [ "${#1}" -le 40 ]; }
case "${1:-}:$#" in
  deploy:2) is_sha "$2" && exec sh "$dir/deploy.sh" "$2" ;;
  rollback:1) exec sh "$dir/rollback.sh" ;;
  rollback:2) is_sha "$2" && exec sh "$dir/rollback.sh" "$2" ;;
  status:1) exec sh "$dir/status.sh" ;;
esac
echo "ci-entry: allowed: 'deploy <sha>', 'rollback [<sha>]', 'status'" >&2
exit 64
