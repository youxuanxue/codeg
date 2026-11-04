#!/bin/bash
# Behavior of the host-home helpers. No container and no network.
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$root/host-home.sh"

fail() {
  echo "host-home_test: $*" >&2
  exit 1
}

tmp=$(mktemp -d)
trap '/bin/rm -rf "$tmp"' EXIT

# Same directory must keep the file. ln -sfn onto itself would destroy it.
mkdir -p "$tmp/same"
echo keep >"$tmp/same/config.toml"
host_home_link_codex "$tmp/same" "$tmp/same"
[ "$(cat "$tmp/same/config.toml")" = "keep" ] || fail "same-dir link destroyed config.toml"
[ ! -L "$tmp/same/config.toml" ] || fail "same-dir link replaced config.toml"

# A different dest links config and skips SQLite.
mkdir -p "$tmp/host" "$tmp/dest"
echo toml >"$tmp/host/config.toml"
echo db >"$tmp/host/logs_2.sqlite"
echo wal >"$tmp/host/logs_2.sqlite-wal"
echo hidden >"$tmp/host/.hidden"
host_home_link_codex "$tmp/host" "$tmp/dest"
[ -L "$tmp/dest/config.toml" ] || fail "config.toml was not linked"
[ "$(cat "$tmp/dest/config.toml")" = "toml" ] || fail "linked config.toml is not readable"
[ ! -e "$tmp/dest/logs_2.sqlite" ] || fail "sqlite was linked"
[ ! -e "$tmp/dest/logs_2.sqlite-wal" ] || fail "sqlite wal was linked"
[ -L "$tmp/dest/.hidden" ] || fail "hidden file was not linked"

# passwd home follows HOME, and a colon is rejected.
printf '%s\n' 'root:x:0:0:root:/root:/bin/bash' >"$tmp/passwd"
host_home_rewrite_passwd /Users/someone "$tmp/passwd"
grep -q '^root:x:0:0:root:/Users/someone:/bin/bash$' "$tmp/passwd" || fail "passwd home was not rewritten"
cp "$tmp/passwd" "$tmp/passwd.keep"
host_home_rewrite_passwd '/Users/someone:evil' "$tmp/passwd"
cmp -s "$tmp/passwd" "$tmp/passwd.keep" || fail "colon in HOME was written into passwd"

# PATH prefix is added once. Run in a subshell so this process keeps rm.
host_home_write_linux_path "$tmp/linux-path.sh"
(
  PATH=/usr/bin
  # shellcheck disable=SC1091
  source "$tmp/linux-path.sh"
  once=$PATH
  # shellcheck disable=SC1091
  source "$tmp/linux-path.sh"
  [ "$PATH" = "$once" ] || exit 1
) || fail "linux path was prepended twice"

echo "host-home_test: ok"
