#!/bin/sh
set -eu

# Native agent settings may point at a desktop proxy on 127.0.0.1. Inside the
# container that address is the container itself, so bridge it to the host
# without changing the mounted host configuration.
if [ "${CODEG_HOST_PROXY_ENABLED:-1}" = "1" ]; then
  ready_file="${CODEG_HOST_PROXY_READY_FILE:-/tmp/codeg-host-proxy.ready}"
  rm -f "$ready_file"
  node /usr/local/bin/codeg-host-proxy.js >/tmp/codeg-host-proxy.log 2>&1 &
  proxy_pid=$!
  attempt=0
  while [ ! -f "$ready_file" ]; do
    if ! kill -0 "$proxy_pid" 2>/dev/null; then
      cat /tmp/codeg-host-proxy.log >&2 || true
      exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 100 ]; then
      echo "codeg host proxy did not become ready" >&2
      exit 1
    fi
    sleep 0.05
  done
fi

exec "$@"
