#!/bin/sh
# Installed by the operator outside the repository snapshot.
set -eu
export PATH=/usr/bin:/bin
export HOME=/nonexistent
export PYTHONDONTWRITEBYTECODE=1
unset NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME
[ "$(id -u)" -ne 0 ]
[ ! -r /opt/neo-sisra-pay-bot/.env ]
[ ! -w . ]
for source in bot.js google-delivery.cjs telegram-http.cjs; do
    /usr/bin/node --check "$source"
done
/usr/bin/node --test tests/*.test.cjs
/usr/bin/python3 -I -B -m unittest discover -s deploy/tests -v
