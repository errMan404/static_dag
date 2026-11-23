#!/bin/sh
# The Git configuration passes the managed URL and account before the action.
case "${3-}" in get) ;; *) exit 0 ;; esac

expected=${1#http://}
protocol=
host=
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    protocol=*) protocol=${line#protocol=} ;;
    host=*) host=${line#host=} ;;
  esac
done
[ "$protocol" = http ] && [ "$host" = "$expected" ] || exit 0
case "$host" in 127.0.0.1:*) ;; *) exit 0 ;; esac
port=${host#127.0.0.1:}
case "$port" in ''|*[!0-9]*) exit 0 ;; esac

token=
IFS= read -r token < "${0%/*}/secrets/token" || [ -n "$token" ] || exit 0
case "$token" in ''|*[!0123456789abcdefABCDEF]*) exit 0 ;; esac
[ "${#token}" -ge 40 ] && [ "${#token}" -le 128 ] || exit 0
printf 'username=%s\npassword=%s\n\n' "$2" "$token"
