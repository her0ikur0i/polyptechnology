#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: restore-postgres.sh CLEAN_DATABASE_URL INPUT.dump MANIFEST.sha256" >&2
  exit 64
fi
case "$2" in /*.dump) ;; *) echo "input must be an absolute .dump path" >&2; exit 64;; esac
case "$3" in /*.sha256) ;; *) echo "manifest must be an absolute .sha256 path" >&2; exit 64;; esac
(cd "$(dirname "$2")" && sha256sum --check "$(basename "$3")")
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$1" "$2"
