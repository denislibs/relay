#!/bin/sh
# docker compose боевого стека: все три слоя, проект relay, тег образов — развёрнутый сейчас (deploy/state/current).
#   deploy/compose.sh ps
#   deploy/compose.sh logs -f --tail=100 server worker
#   RELAY_TAG=<sha> deploy/compose.sh config
set -eu
. "$(dirname "$0")/lib.sh"
compose "$@"
