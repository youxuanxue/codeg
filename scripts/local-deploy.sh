#!/usr/bin/env bash
# scripts/local-deploy.sh — run codeg-server natively on this Mac as a
# launchd user agent, built from this checkout.
#
# Agents then run with the real user account: the same HOME, PATH, keychain,
# gh/aws/ssh binaries and absolute paths as a terminal. A Linux container
# cannot give that on macOS (its binaries and credential helpers differ), so
# a new machine would hit the same breakage again.
#
# Usage:
#   bash scripts/local-deploy.sh install          # build, install, (re)start
#   bash scripts/local-deploy.sh import-docker [container]
#                                                 # one-shot: copy a container's
#                                                 # /data in, rewrite paths
#   bash scripts/local-deploy.sh status
#   bash scripts/local-deploy.sh uninstall        # stop service; keeps data
#
# Every path is derived on the running machine. Override with:
#   CODEG_DATA_DIR      default ~/codeg
#   CODEG_PORT          default 3080
#   CODEG_HOST          default 0.0.0.0
#   CODEG_PROJECTS_DIR  default ~/Codes (target of container /projects paths)
#   CODEG_LOCAL_PROXY   e.g. http://127.0.0.1:7890 (unset: no proxy env)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${CODEG_DATA_DIR:-$HOME/codeg}"
PORT="${CODEG_PORT:-3080}"
HOST="${CODEG_HOST:-0.0.0.0}"
PROJECTS="${CODEG_PROJECTS_DIR:-$HOME/Codes}"
PROXY="${CODEG_LOCAL_PROXY:-}"
BIN="$HOME/.local/bin"
WEB="$HOME/.local/share/codeg/web"
LABEL=com.codeg.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

die() { echo "error: $*" >&2; exit 1; }

xml_escape() {
  local s=$1
  s=${s//&/&amp;}; s=${s//</&lt;}; s=${s//>/&gt;}
  printf '%s' "$s"
}

# render_plist <bin> <data> <web> <host> <port> <proxy> <home> <path>
render_plist() {
  local bin data web host port proxy home path
  bin=$(xml_escape "$1"); data=$(xml_escape "$2"); web=$(xml_escape "$3")
  host=$(xml_escape "$4"); port=$(xml_escape "$5"); proxy=$(xml_escape "$6")
  home=$(xml_escape "$7"); path=$(xml_escape "$8")
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- Login shell for ~/.zprofile; PATH below adds what ~/.zshrc sets. -->
    <string>/bin/zsh</string><string>-lc</string>
    <string>exec "\$CODEG_BIN/codeg-server"</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEG_BIN</key><string>$bin</string>
    <key>PATH</key><string>$path</string>
    <key>CODEG_HOST</key><string>$host</string>
    <key>CODEG_PORT</key><string>$port</string>
    <key>CODEG_DATA_DIR</key><string>$data</string>
    <key>CODEG_STATIC_DIR</key><string>$web</string>
EOF
  if [ -n "$6" ]; then
    cat <<EOF
    <key>http_proxy</key><string>$proxy</string>
    <key>https_proxy</key><string>$proxy</string>
    <key>HTTP_PROXY</key><string>$proxy</string>
    <key>HTTPS_PROXY</key><string>$proxy</string>
    <key>no_proxy</key><string>localhost,127.0.0.1,::1</string>
    <key>NO_PROXY</key><string>localhost,127.0.0.1,::1</string>
EOF
  fi
  cat <<EOF
  </dict>
  <key>WorkingDirectory</key><string>$home</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$data/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$data/logs/launchd.err.log</string>
</dict>
</plist>
EOF
}

# rewrite_container_paths <db> <projects dir>
# Container folder paths (/projects/x, /root/codes/x) become host paths.
rewrite_container_paths() {
  local db=$1 projects=${2%/}
  local q=${projects//\'/\'\'}
  sqlite3 "$db" <<SQL
PRAGMA wal_checkpoint(TRUNCATE);
UPDATE folder SET path = '$q/' || substr(path, length('/projects/') + 1)
  WHERE path LIKE '/projects/%';
UPDATE folder SET path = '$q/' || substr(path, length('/root/codes/') + 1)
  WHERE path LIKE '/root/codes/%';
UPDATE conversation SET origin_cwd = '$q/' || substr(origin_cwd, length('/projects/') + 1)
  WHERE origin_cwd LIKE '/projects/%';
UPDATE conversation SET origin_cwd = '$q/' || substr(origin_cwd, length('/root/codes/') + 1)
  WHERE origin_cwd LIKE '/root/codes/%';
SQL
}

pinned_pnpm() {
  local v
  v=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$REPO/package.json")
  [ -n "$v" ] || die "packageManager missing from package.json"
  echo "$v"
}

cmd_install() {
  [ "$(uname -s)" = Darwin ] || die "launchd install is macOS-only"
  command -v cargo >/dev/null || die "cargo not found"
  command -v npx >/dev/null || die "npx not found"

  # Homebrew's pnpm can lag the pinned major and reject this workspace file.
  (cd "$REPO" && npx -y "pnpm@$(pinned_pnpm)" install --frozen-lockfile \
    && npx -y "pnpm@$(pinned_pnpm)" build)
  (cd "$REPO/src-tauri" \
    && cargo build --release --no-default-features --features server-bin --bin codeg-server \
    && cargo build --release --no-default-features --features mcp-bin --bin codeg-mcp)

  mkdir -p "$BIN" "$WEB" "$DATA/logs" "$(dirname "$PLIST")"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  install -m 755 "$REPO/src-tauri/target/release/codeg-server" "$BIN/codeg-server"
  install -m 755 "$REPO/src-tauri/target/release/codeg-mcp" "$BIN/codeg-mcp"
  rsync -a --delete "$REPO/out/" "$WEB/"

  # The PATH of the terminal running install: interactive-shell additions
  # (e.g. ~/.local/bin for claude) are absent from a launchd login shell.
  render_plist "$BIN" "$DATA" "$WEB" "$HOST" "$PORT" "$PROXY" "$HOME" \
    "$BIN:$PATH" >"$PLIST"
  plutil -lint "$PLIST" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "codeg-server: http://localhost:$PORT  data: $DATA"
}

cmd_import_docker() {
  local container=${1:-codeg-local}
  command -v docker >/dev/null || die "docker not found"
  command -v sqlite3 >/dev/null || die "sqlite3 not found"
  if [ -e "$DATA/codeg.db" ]; then
    die "$DATA/codeg.db exists; move it away before importing"
  fi
  local backup="$HOME/.local/share/codeg-migrate/$container-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$backup" "$DATA"

  # Stop first so the copied SQLite files are consistent. The container is
  # kept (restart disabled) as a rollback path.
  docker update --restart=no "$container" >/dev/null
  docker stop "$container" >/dev/null
  docker cp "$container:/data/." "$backup/"
  cp -R "$backup/." "$DATA/"
  # Linux binaries and a credential helper pointing at /data do not carry over.
  rm -rf "$DATA/acp-binaries" "$DATA/cli" "$DATA/git-credential-codeg.sh" \
    "$DATA"/codeg.db.*lock
  rewrite_container_paths "$DATA/codeg.db" "$PROJECTS"
  sqlite3 "$DATA/codeg.db" 'SELECT id, path FROM folder'
  echo "container data backup: $backup"
}

cmd_status() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n '/state =/p;/pid =/p' \
    || echo "not loaded"
  curl -fsS -o /dev/null -w 'http %{http_code}\n' "http://127.0.0.1:$PORT/" || true
}

cmd_uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "stopped; data kept at $DATA"
}

main() {
  case "${1:-}" in
    install) cmd_install ;;
    import-docker) shift; cmd_import_docker "$@" ;;
    status) cmd_status ;;
    uninstall) cmd_uninstall ;;
    *) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 2 ;;
  esac
}

# Sourced by scripts/local-deploy_test.sh for the pure functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
