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

# Columns that store a host path. A column missing from an older schema is
# skipped rather than failing the import.
PATH_COLUMNS=(
  folder.path
  conversation.origin_cwd
  folder_link.target_path
  canvas_node.path
  custom_agent.skills_dir
)

# rewrite_container_paths <db> <projects dir>
# Container paths (/projects/x, /root/codes/x) become <projects dir>/x.
rewrite_container_paths() {
  local db=$1 projects=${2%/}
  local q=${projects//\'/\'\'} sql="PRAGMA wal_checkpoint(TRUNCATE);" entry table col prefix
  for entry in "${PATH_COLUMNS[@]}"; do
    table=${entry%%.*}; col=${entry#*.}
    if [ -z "$(sqlite3 "$db" "SELECT 1 FROM pragma_table_info('$table') WHERE name = '$col'")" ]; then
      continue
    fi
    for prefix in /projects/ /root/codes/; do
      sql+="
UPDATE $table SET $col = '$q/' || substr($col, length('$prefix') + 1)
  WHERE $col LIKE '$prefix%';"
    done
  done
  sqlite3 "$db" "$sql" || return 1
}

pinned_pnpm() {
  local v
  v=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$REPO/package.json")
  [ -n "$v" ] || die "packageManager missing from package.json"
  echo "$v"
}

# Fallback for a pnpm step when the configured registry (a mirror in
# ~/.npmrc, say) cannot serve pnpm or a package: the step runs again once
# against the public registry. The user's npm config is left as it is. A step
# that fails for any other reason fails again and stops the install.
PUBLIC_REGISTRY=https://registry.npmjs.org

with_registry_fallback() {
  "$@" && return 0
  echo "retrying against $PUBLIC_REGISTRY: $*" >&2
  npm_config_registry=$PUBLIC_REGISTRY "$@"
}

cmd_install() {
  [ "$(uname -s)" = Darwin ] || die "launchd install is macOS-only"
  command -v cargo >/dev/null || die "cargo not found"
  command -v npx >/dev/null || die "npx not found"

  # Homebrew's pnpm can lag the pinned major and reject this workspace file.
  local pnpm
  pnpm="pnpm@$(pinned_pnpm)"
  (cd "$REPO" && with_registry_fallback npx -y "$pnpm" install --frozen-lockfile \
    && with_registry_fallback npx -y "$pnpm" build)
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
  [ -e "$DATA" ] && die "$DATA exists; move it away before importing"

  local stage
  stage=$(mktemp -d "${DATA%/}.import.XXXXXX") || die "cannot create a stage dir"
  # Stop first so the copied SQLite files are consistent. The container is
  # kept (restart disabled) as a rollback path. Each step checks itself:
  # errexit is off when a caller runs this inside a condition.
  docker update --restart=no "$container" >/dev/null || die "docker update failed"
  docker stop "$container" >/dev/null || die "docker stop failed"
  docker cp "$container:/data/." "$stage/" || die "docker cp failed; partial copy in $stage"
  [ -f "$stage/codeg.db" ] || die "no codeg.db in $container:/data; copy in $stage"
  # Linux binaries and a credential helper pointing at /data do not carry over.
  rm -rf "$stage/acp-binaries" "$stage/cli" "$stage/git-credential-codeg.sh" \
    "$stage"/codeg.db.*lock
  rewrite_container_paths "$stage/codeg.db" "$PROJECTS" || die "path rewrite failed; copy in $stage"
  # DATA appears only once the rewrite succeeded; a failed run leaves the
  # stage directory to inspect and nothing in the way of a retry.
  mv "$stage" "$DATA" || die "cannot move $stage to $DATA"
  sqlite3 "$DATA/codeg.db" 'SELECT id, path FROM folder'
  echo "imported $container into $DATA (container kept, stopped)"
}

# Exits non-zero when the agent is not loaded or the port does not answer.
cmd_status() {
  local info
  if ! info=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null); then
    echo "not loaded"
    return 1
  fi
  printf '%s\n' "$info" | awk -F' = ' '$1 ~ /^\t(state|pid)$/ {sub(/^\t/, ""); print}'
  curl -fsS -o /dev/null -w 'http %{http_code}\n' "http://127.0.0.1:$PORT/"
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
