#!/usr/bin/env bash
# Run wrangler for THIS project, against THIS project's Cloudflare account.
#
# Why this exists: `wrangler login` stores ONE machine-wide credential and
# picks whichever Cloudflare account the browser was last signed into. With
# several projects on one machine that silently deploys to the wrong account.
#
# Two safeguards, both optional-but-on-by-default:
#   1. If .env exists it supplies a project-local API token, so this project
#      ignores the machine-wide login entirely.
#   2. Whatever the credential, the account is checked against the account_id
#      pinned in wrangler.toml and the command is refused on a mismatch.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

pinned="$(sed -n 's/^account_id *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"

if [ -n "$pinned" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ "$pinned" != "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo "REFUSING TO RUN — account mismatch." >&2
  echo "  wrangler.toml pins   $pinned" >&2
  echo "  environment supplies $CLOUDFLARE_ACCOUNT_ID" >&2
  exit 1
fi

if [ -z "$pinned" ]; then
  echo "note: wrangler.toml has no account_id pinned yet — this project can still drift." >&2
fi

exec npx wrangler "$@"
