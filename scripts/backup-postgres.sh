#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: backup-postgres.sh DATABASE_URL OUTPUT.dump MANIFEST.sha256" >&2
  exit 64
fi
case "$2" in /*.dump) ;; *) echo "output must be an absolute .dump path" >&2; exit 64;; esac
case "$3" in /*.sha256) ;; *) echo "manifest must be an absolute .sha256 path" >&2; exit 64;; esac
umask 077
pg_dump --format=custom --no-owner --no-privileges --file="$2" "$1"
sha256sum "$2" > "$3"
pg_restore --list "$2" >/dev/null
