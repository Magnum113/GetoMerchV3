#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
MIGRATION_RUNNER="$SCRIPT_DIR/migrate.mjs"
DB_NAME="${GETOMERCH_REHEARSAL_DATABASE:-getomerch_rehearsal}"
DB_CREATED=false

cd "$REPOSITORY_ROOT"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

cleanup() {
  if [[ "$DB_CREATED" == true && "${GETOMERCH_KEEP_REHEARSAL_DATABASE:-false}" != true ]]; then
    dropdb --if-exists "$DB_NAME" >/dev/null
  fi
}
trap cleanup EXIT

[[ "$DB_NAME" =~ ^getomerch_(rehearsal|stage2_[a-z0-9_]+|stage4_[a-z0-9_]+|stage5_[a-z0-9_]+|stage6_[a-z0-9_]+|stage9_[a-z0-9_]+|stage10_[a-z0-9_]+|stage11_[a-z0-9_]+|stage12_[a-z0-9_]+|stage13_[a-z0-9_]+)$ ]] || \
  fail "rehearsal database name is not allowed: $DB_NAME"

for command in createdb dropdb node psql; do
  command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done

if psql --dbname postgres -X -Atc \
  "select 1 from pg_database where datname = '$DB_NAME'" | grep -qx 1; then
  fail "database already exists; refusing to drop or overwrite it: $DB_NAME"
fi

createdb --template=template0 "$DB_NAME"
DB_CREATED=true

run_migration_command() {
  PGDATABASE="$DB_NAME" node "$MIGRATION_RUNNER" "$1"
}

echo "Checking a clean database"
run_migration_command status

echo "Applying migrations"
run_migration_command up
run_migration_command status
run_migration_command verify

echo "Checking idempotent re-run"
run_migration_command up
run_migration_command verify

LEDGER_ROWS="$(
  psql --dbname "$DB_NAME" -X -Atc \
    'select count(*) from getomerch_meta.schema_migrations'
)"
EXPECTED_LEDGER_ROWS="$(
  find "$SCRIPT_DIR/../migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' '
)"
[[ "$LEDGER_ROWS" == "$EXPECTED_LEDGER_ROWS" ]] || \
  fail "expected $EXPECTED_LEDGER_ROWS ledger rows, got $LEDGER_ROWS"

echo "Rehearsal completed successfully for $DB_NAME"
if [[ "${GETOMERCH_KEEP_REHEARSAL_DATABASE:-false}" == true ]]; then
  echo "Database retained because GETOMERCH_KEEP_REHEARSAL_DATABASE=true"
fi
