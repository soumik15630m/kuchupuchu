#!/bin/sh
set -eu

# A named volume's ownership is only initialized from the image the FIRST
# time Docker creates it -- never retroactively when the image changes.
# -R matters here, not just chowning /data itself: a volume that already
# has files in it (app.db etc, from a run before appuser existed, or from
# any run where this container happened to start as root) keeps those
# files' original ownership regardless of the directory's -- SQLite can
# then open app.db for reading (root-owned, world-readable) but not for
# writing, which is exactly "attempt to write a readonly database".
chown -R appuser /data

exec gosu appuser "$@"
