#!/bin/sh
set -eu

# Keep the built-in ACP adapters and CLI runtimes in the image's npm prefix.
# Docker Compose mounts that prefix as a named volume so recreation does not
# remove installed runtimes.
npm install -g \
  @agentclientprotocol/claude-agent-acp@0.94.0 \
  @agentclientprotocol/codex-acp@2.2.2 \
  @earendil-works/pi-coding-agent@1.5.0 \
  @google/gemini-cli@0.60.0 \
  pi-acp@0.0.34 \
  @deepseek-ai/dsh@0.2.1-rc.5
