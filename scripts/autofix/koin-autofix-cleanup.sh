#!/bin/sh
set -eu
# Only this executor's verifier children carry this label. Never prune other
# containers, images, volumes, or Home Assistant services.
ids="$(/usr/bin/docker ps -aq --filter 'label=koin.autofix.executor=koin-rocky-umpc')"
for id in $ids; do
  case "$id" in
    *[!a-f0-9]*|'') echo 'Unexpected labeled Docker container ID' >&2; exit 1 ;;
  esac
  /usr/bin/docker rm --force "$id" >/dev/null
done
