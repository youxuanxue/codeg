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
# rows and a prefix that only looks similar stay as they are. Every listed
# column is covered, and a column absent from this schema is skipped.
db="$tmp/codeg.db"
sqlite3 "$db" <<'SQL'
CREATE TABLE folder (id INTEGER PRIMARY KEY, path TEXT);
CREATE TABLE conversation (id INTEGER PRIMARY KEY, origin_cwd TEXT);
CREATE TABLE folder_link (id INTEGER PRIMARY KEY, target_path TEXT);
CREATE TABLE canvas_node (id INTEGER PRIMARY KEY, path TEXT);
INSERT INTO folder VALUES
  (1, '/projects/a/b'), (2, '/root/codes/c'), (3, '/Users/x/d'), (4, '/projectsX/e');
INSERT INTO conversation VALUES (1, '/projects/a'), (2, NULL);
INSERT INTO folder_link VALUES (1, '/root/codes/link');
INSERT INTO canvas_node VALUES (1, '/projects/a/n.md');
SQL
rewrite_container_paths "$db" "/Users/o'neil/Codes/" >/dev/null
got=$(sqlite3 "$db" 'SELECT path FROM folder ORDER BY id' | tr '\n' '|')
want="/Users/o'neil/Codes/a/b|/Users/o'neil/Codes/c|/Users/x/d|/projectsX/e|"
[ "$got" = "$want" ] || fail "folder paths: $got"
got=$(sqlite3 "$db" "SELECT ifnull(origin_cwd,'-') FROM conversation ORDER BY id" | tr '\n' '|')
[ "$got" = "/Users/o'neil/Codes/a|-|" ] || fail "origin_cwd: $got"
got=$(sqlite3 "$db" 'SELECT target_path FROM folder_link')
[ "$got" = "/Users/o'neil/Codes/link" ] || fail "folder_link: $got"
got=$(sqlite3 "$db" 'SELECT path FROM canvas_node')
[ "$got" = "/Users/o'neil/Codes/a/n.md" ] || fail "canvas_node: $got"

# A failed import leaves no data dir behind, so a retry is not blocked.
mkdir -p "$tmp/fakebin"
cat >"$tmp/fakebin/docker" <<'SH'
#!/bin/sh
[ "$1" = cp ] && exit 1
exit 0
SH
chmod +x "$tmp/fakebin/docker"
if (PATH="$tmp/fakebin:$PATH" DATA="$tmp/data" cmd_import_docker x) 2>/dev/null; then
  fail "import should fail when docker cp fails"
fi
[ -e "$tmp/data" ] && fail "failed import left a data dir"
rm -rf "$tmp"/data.import.*
# A successful import moves the rewritten copy into place, minus Linux-only
# files.
mkdir -p "$tmp/src"
sqlite3 "$tmp/src/codeg.db" "CREATE TABLE folder (id INTEGER PRIMARY KEY, path TEXT);
  INSERT INTO folder VALUES (1, '/projects/p');"
mkdir "$tmp/src/acp-binaries"
cat >"$tmp/fakebin/docker" <<SH
#!/bin/sh
[ "\$1" = cp ] && cp -R "$tmp/src/." "\$3"
exit 0
SH
(PATH="$tmp/fakebin:$PATH" DATA="$tmp/ok" PROJECTS=/h/Codes cmd_import_docker x) >/dev/null \
  || fail "import success path"
[ "$(sqlite3 "$tmp/ok/codeg.db" 'SELECT path FROM folder')" = /h/Codes/p ] || fail "imported path"
[ -e "$tmp/ok/acp-binaries" ] && fail "Linux binaries carried over"

mkdir "$tmp/data"
out=$( (PATH="$tmp/fakebin:$PATH" DATA="$tmp/data" cmd_import_docker x) 2>&1 ) && fail "import over existing dir"
case $out in *exists*) ;; *) fail "existing dir message: $out" ;; esac

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
