#!/bin/bash
# Project the host account into this container, then start the server.
# The image entrypoint starts the loopback proxy first and then execs this
# script, so GitHub downloads below can use 127.0.0.1:7890.
set -euo pipefail

# True when both paths are the same directory. Linking a file onto itself
# replaces it with a symlink that points at itself.
host_home_same_dir() {
  [ -d "$1" ] && [ -d "$2" ] && [ "$1" -ef "$2" ]
}

# Skip SQLite. Sharing those files with a desktop Codex across a macOS bind
# mount corrupts them. Never link when source and dest are the same directory.
host_home_link_codex() {
  local host=$1
  local local_dir=$2
  local path name
  mkdir -p "$local_dir"
  if host_home_same_dir "$host" "$local_dir"; then
    echo "host-home: Codex source and dest are the same directory; not linking" >&2
    return 0
  fi
  [ -d "$host" ] || return 0
  shopt -s nullglob dotglob
  for path in "$host"/*; do
    name=$(basename "$path")
    case "$name" in
      . | .. | *.sqlite | *.sqlite-* | *.db | *.db-*) continue ;;
    esac
    ln -sfn "$path" "$local_dir/$name"
  done
  shopt -u dotglob
}

# OpenSSH expands ~ from passwd, not from $HOME. A colon or newline in HOME
# would break the passwd record, so leave the file alone in that case.
host_home_rewrite_passwd() {
  local home=$1
  local path=$2
  case "$home" in
    *:* | *$'\n'*)
      echo "host-home: HOME cannot be written into passwd" >&2
      return 0
      ;;
  esac
  python3 -c '
import sys
home, path = sys.argv[1], sys.argv[2]
lines = []
for line in open(path):
    parts = line.rstrip("\n").split(":")
    if parts and parts[0] == "root" and len(parts) > 5:
        parts[5] = home
        line = ":".join(parts) + "\n"
    lines.append(line)
open(path, "w").writelines(lines)
' "$home" "$path"
}

host_home_write_linux_path() {
  local path=$1
  cat >"$path" <<'EOF'
prefix="/root/.codeg/npm-global/bin:/usr/bin"
case "$PATH" in
  "$prefix":* | "$prefix") ;;
  *) export PATH="${prefix}:${PATH}" ;;
esac
EOF
}

host_home_main() {
  host_home_rewrite_passwd "${HOME}" /etc/passwd

  # Linux gh. A Homebrew binary from the host cannot run here. The token file
  # is created on the host by docker/refresh-gh-token.sh and is never baked in.
  gh_bin=/root/.codeg/npm-global/bin/gh
  if [ ! -x "$gh_bin" ]; then
    case "$(uname -m)" in
      aarch64 | arm64) gh_arch=arm64 ;;
      x86_64 | amd64) gh_arch=amd64 ;;
      *) gh_arch="" ;;
    esac
    if [ -n "$gh_arch" ]; then
      tmp=$(mktemp -d)
      archive="gh_2.99.0_linux_${gh_arch}"
      if curl -fsSL --retry 2 -o "$tmp/gh.tgz" \
        -x "http://127.0.0.1:${CODEG_HOST_PROXY_LISTEN_PORT:-7890}" \
        "https://github.com/cli/cli/releases/download/v2.99.0/${archive}.tar.gz" \
        && tar -C /root/.codeg/npm-global/bin -xzf "$tmp/gh.tgz" --strip-components=2 \
          "${archive}/bin/gh"
      then
        :
      else
        echo "host-home: Linux gh was not installed" >&2
      fi
      rm -rf "$tmp"
    fi
  fi

  token_file="${HOME}/.config/codeg/gh-token"
  if [ -f "$token_file" ]; then
    GH_TOKEN=$(cat "$token_file")
    export GH_TOKEN
    export GITHUB_TOKEN="$GH_TOKEN"
  fi

  # Host gitconfig may call osxkeychain or a macOS gh. An empty helper resets
  # that list for this process only; the host file is left unchanged.
  export GIT_CONFIG_COUNT=4
  export GIT_CONFIG_KEY_0=credential.helper
  export GIT_CONFIG_VALUE_0=
  export GIT_CONFIG_KEY_1=credential.https://github.com.helper
  export GIT_CONFIG_VALUE_1=
  export GIT_CONFIG_KEY_2=credential.https://gist.github.com.helper
  export GIT_CONFIG_VALUE_2=
  export GIT_CONFIG_KEY_3=credential.helper
  export GIT_CONFIG_VALUE_3='!gh auth git-credential'

  if [ -d "${HOME}/.claude" ] && [ ! -e /root/.claude ]; then
    ln -sfn "${HOME}/.claude" /root/.claude
  fi

  # /mnt/host-codex is a separate mount of the host directory. Using
  # ${HOME}/.codex would point at the container volume when that volume is
  # mounted on top of the home path.
  codex_host=/mnt/host-codex
  if [ ! -d "$codex_host" ]; then
    codex_host="${HOME}/.codex"
  fi
  host_home_link_codex "$codex_host" "${CODEX_HOME:-/root/.codex}"

  # Login shells source the host profile and can put macOS binaries first.
  mkdir -p /opt/codeg
  host_home_write_linux_path /opt/codeg/linux-path.sh
  export BASH_ENV=/opt/codeg/linux-path.sh

  exec "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  host_home_main "$@"
fi
