#!/usr/bin/env bash
# Run the security rule tests against a throwaway Postgres database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${RLS_DB:-rls_test}
psql -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB" -c "create database $DB"
for f in supabase/tests/supabase-stub.sql supabase/migrations/*.sql; do
  PGOPTIONS="-c client_min_messages=warning" psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f" >/dev/null
done
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/rls.test.sql 2>&1 | grep -E '^(psql:.*)?(NOTICE:  )?(ok:|FAIL|ERROR|All )' | sed -E 's/^psql:[^ ]+ NOTICE:  //'
