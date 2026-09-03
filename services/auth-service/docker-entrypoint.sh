#!/bin/sh
set -eu

# A named volume's ownership is only initialized from the image the FIRST
# time Docker creates it -- never retroactively when the image changes.
# A sqlite-data volume created back when this container ran as root (or on
# a machine that had one before this image added appuser) stays root-owned
# forever otherwise, and appuser can't write to it. Fix it on every start,
# as root, before dropping down -- cheap, idempotent, and doesn't depend
# on the volume's history.
chown appuser /data

exec gosu appuser "$@"
