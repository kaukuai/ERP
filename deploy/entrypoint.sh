#!/bin/sh
set -eu

# A new managed disk may be mounted as root even when the image directory
# belongs to node. Initialize only this fixed data volume, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /var/lib/erp
  chown -R -h node:node /var/lib/erp
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs "$@"
fi
exec "$@"
