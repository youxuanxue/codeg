#!/bin/bash
# Project the host account into this container, then start the server.
# The image entrypoint starts the loopback proxy first and then execs this
# script, so GitHub downloads below can use 127.0.0.1:7890.
set -euo pipefail

python3 -c '
import os
home = os.environ["HOME"]
path = "/etc/passwd"
lines = []
for line in open(path):
    parts = line.rstrip("\n").split(":")
    if parts and parts[0] == "root" and len(parts) > 5:
        parts[5] = home
        line = ":".join(parts) + "\n"
    lines.append(line)
open(path, "w").writelines(lines)
'

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
    if curl -fsSL --retry 2 -o "$tmp/gh.tgz" \
      -x "http://127.0.0.1:${CODEG_HOST_PROXY_LISTEN_PORT:-7890}" \
      "https://github.com/cli/cli/releases/download/v2.99.0/gh_2.99.0_linux_${gh_arch}.tar.gz"
    then
      tar -C /root/.codeg/npm-global/bin -xzf "$tmp/gh.tgz" --strip-components=2 \
        "gh_2.99.0_linux_${gh_arch}/bin/gh"
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

# Share Codex config and sessions. SQLite stays on the container volume:
# locks do not hold across a macOS bind mount, and sharing it corrupts
# the log database.
host="${HOME}/.codex"
local="${CODEX_HOME:-/root/.codex}"
mkdir -p "$local"
if [ -d "$host" ]; then
  shopt -s nullglob dotglob
  for path in "$host"/*; do
    name=$(basename "$path")
    case "$name" in
      . | .. | *.sqlite | *.sqlite-* | *.db | *.db-*) continue ;;
    esac
    ln -sfn "$path" "$local/$name"
  done
  shopt -u dotglob
fi

# Login shells source the host profile and can put macOS binaries first.
cat >/opt/codeg/linux-path.sh <<'EOF'
export PATH="/root/.codeg/npm-global/bin:/usr/bin:${PATH}"
EOF
export BASH_ENV=/opt/codeg/linux-path.sh

exec "$@"
