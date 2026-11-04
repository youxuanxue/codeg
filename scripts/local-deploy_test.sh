#!/usr/bin/env bash
# Tests for the pure parts of scripts/local-deploy.sh (no launchd, no docker).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/local-deploy.sh
source "$here/local-deploy.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Path rewrite: container paths map onto the given host projects dir; other
# rows and a prefix that only looks similar stay as they are.
db="$tmp/codeg.db"
sqlite3 "$db" <<'SQL'
CREATE TABLE folder (id INTEGER PRIMARY KEY, path TEXT);
CREATE TABLE conversation (id INTEGER PRIMARY KEY, origin_cwd TEXT);
INSERT INTO folder VALUES
  (1, '/projects/a/b'), (2, '/root/codes/c'), (3, '/Users/x/d'), (4, '/projectsX/e');
INSERT INTO conversation VALUES (1, '/projects/a'), (2, NULL);
SQL
rewrite_container_paths "$db" "/Users/o'neil/Codes/" >/dev/null
got=$(sqlite3 "$db" 'SELECT path FROM folder ORDER BY id' | tr '\n' '|')
want="/Users/o'neil/Codes/a/b|/Users/o'neil/Codes/c|/Users/x/d|/projectsX/e|"
[ "$got" = "$want" ] || fail "folder paths: $got"
got=$(sqlite3 "$db" "SELECT ifnull(origin_cwd,'-') FROM conversation ORDER BY id" | tr '\n' '|')
[ "$got" = "/Users/o'neil/Codes/a|-|" ] || fail "origin_cwd: $got"

# Plist: values come from arguments (no hardcoded home), XML is escaped, and
# proxy keys appear only when a proxy is given.
render_plist "/h/a&b/bin" "/h/data" "/h/web" 0.0.0.0 3080 "" "/h" "/h/bin:/usr/bin" >"$tmp/a.plist"
grep -q '/h/a&amp;b/bin' "$tmp/a.plist" || fail "escape"
grep -q 'proxy' "$tmp/a.plist" && fail "proxy keys without proxy"
grep -q '<key>PATH</key><string>/h/bin:/usr/bin</string>' "$tmp/a.plist" || fail "PATH"
grep -q '/Users/' "$tmp/a.plist" && fail "hardcoded home"
render_plist /b /d /w 127.0.0.1 1 "http://127.0.0.1:7890" /h /usr/bin >"$tmp/b.plist"
grep -q '<key>https_proxy</key><string>http://127.0.0.1:7890</string>' "$tmp/b.plist" \
  || fail "proxy keys"
if command -v plutil >/dev/null; then
  plutil -lint "$tmp/a.plist" "$tmp/b.plist" >/dev/null || fail "plist lint"
elif command -v xmllint >/dev/null; then
  xmllint --noout "$tmp/a.plist" "$tmp/b.plist" || fail "xml lint"
fi

echo "local-deploy: ok"
