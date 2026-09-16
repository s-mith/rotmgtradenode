#!/usr/bin/env bash
# Run the built site with the embedded fleet for a live session.
# Env comes from data/live-site/live.env (generated, git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source data/live-site/live.env; set +a
exec node dist/server/main.js
