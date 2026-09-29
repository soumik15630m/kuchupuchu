#!/bin/sh
set -eu

# A named volume's ownership is only initialized from the image the FIRST
# time Docker creates it, never retroactively. -R matters: files written by
# an earlier run as root keep their ownership regardless of the directory's,
# and SQLite can then read the db but not write it -- which surfaces as
# "attempt to write a readonly database".
chown -R appuser /data

exec gosu appuser "$@"
