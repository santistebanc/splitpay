#!/usr/bin/env bash
# Deploys SplitPay's Supabase Edge Functions and reminds you of the manual
# steps the CLI can't do for you (applying schema.sql, reloading PowerSync).
#
# Usage:
#   supabase login                      # once
#   supabase link --project-ref <ref>   # once, from repo root
#   ./supabase/deploy.sh                # deploy all functions
#   ./supabase/deploy.sh sync-upload    # deploy a single function
#
# Edge Functions automatically receive SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY, so no extra secrets are required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTIONS_DIR="$SCRIPT_DIR/functions"

if ! command -v supabase >/dev/null 2>&1; then
  echo "error: the Supabase CLI is not installed (https://supabase.com/docs/guides/cli)." >&2
  exit 1
fi

# Functions to deploy. `_shared` is a shared module bundled into each function,
# not a function itself, so it is never deployed directly.
if [[ $# -gt 0 ]]; then
  FUNCTIONS=("$@")
else
  FUNCTIONS=(create-group join-group leave-group set-password sync-upload)
fi

for fn in "${FUNCTIONS[@]}"; do
  if [[ ! -d "$FUNCTIONS_DIR/$fn" ]]; then
    echo "error: no such function: $fn" >&2
    exit 1
  fi
  echo "==> deploying $fn"
  supabase functions deploy "$fn"
done

cat <<'NOTE'

Functions deployed.

Manual steps (CLI cannot do these):
  1. Apply supabase/schema.sql in the Supabase SQL editor (idempotent; safe to
     re-run except the one-time create role / create policy lines).
  2. Confirm group_secrets and join_attempts are NOT in the `powersync`
     publication (they must never replicate to clients).
  3. Reload / redeploy your PowerSync instance so it picks up the new
     groups.has_password column.
NOTE
