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
#
# Verifier children can leave directories owned by a non-root container UID.
# Clear only this service's disposable workspaces before the controller starts;
# durable claim receipts, the bare Git cache, and other host services stay intact.
if [ -d /var/lib/koin-autofix/jobs ]; then
  /usr/bin/find /var/lib/koin-autofix/jobs -mindepth 1 -maxdepth 1 -type d \
    \( -name 'run-*' -o -name 'error-verification-*' \) \
    -exec /usr/bin/rm -rf -- {} +
fi
