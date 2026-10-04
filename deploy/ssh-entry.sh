#!/bin/sh
# Root-owned forced-command wrapper; SSH input is data, never shell source.
set -eu

command=${SSH_ORIGINAL_COMMAND-}
case "$command" in
  'deploy '*) sha=${command#deploy } ;;
  *) printf '%s\n' 'Only deploy <full-lowercase-commit-SHA> is permitted.' >&2; exit 64 ;;
esac

case "$sha" in
  ''|*[!0-9a-f]*) printf '%s\n' 'Invalid deployment SHA.' >&2; exit 64 ;;
esac
if [ "${#sha}" -ne 40 ] || [ "$command" != "deploy $sha" ]; then
  printf '%s\n' 'Invalid deployment command.' >&2
  exit 64
fi

exec /usr/bin/sudo -n -- /usr/local/sbin/neo-sisra-bot-deploy "$sha"
