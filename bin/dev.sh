#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

use_proxy=1
args=()
for arg in "$@"; do
  case "$arg" in
    --no-proxy) use_proxy=0 ;;
    -h | --help)
      printf '%s\n' \
        'Usage: ./bin/dev.sh [--no-proxy] [docker compose up options]' \
        '  Default:    http://createratio.localhost (shared Traefik, devproxy network)' \
        '  --no-proxy: http://127.0.0.1:4173 (override with WEB_PORT)' \
        '  -d:         run in the background'
      exit 0
      ;;
    *) args+=("$arg") ;;
  esac
done

compose=(docker compose --env-file /dev/null -f docker-compose.yml)
if ((use_proxy)); then
  compose+=(-f docker-compose.dev-proxy.yml)
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: can't reach the Docker daemon -- is Docker running?" >&2
  exit 1
fi

if ((use_proxy)) && ! docker network inspect devproxy >/dev/null 2>&1; then
  echo "error: the shared 'devproxy' network doesn't exist yet." >&2
  echo '       Start your shared Traefik stack, or create its network once:' >&2
  echo '         docker network create devproxy' >&2
  echo '       Without a proxy: ./bin/dev.sh --no-proxy' >&2
  exit 1
fi

if ((use_proxy)) && [ -z "$(docker ps -q -f label=com.docker.compose.service=traefik)" ]; then
  echo 'warning: no Compose service named traefik appears to be running.' >&2
  echo '         Start your shared proxy, or use ./bin/dev.sh --no-proxy.' >&2
fi

exec "${compose[@]}" up ${args[@]+"${args[@]}"}
