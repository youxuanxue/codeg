#!/bin/bash
# Copy the host GitHub token into a file the container can read.
# macOS keeps it in the keychain, which the container cannot open.
# Re-run this when `gh auth status` on the host changes.
set -euo pipefail
dest="${HOME}/.config/codeg/gh-token"
mkdir -p "$(dirname "$dest")"
umask 077
gh auth token >"$dest"
chmod 600 "$dest"
echo "wrote ${dest}"
