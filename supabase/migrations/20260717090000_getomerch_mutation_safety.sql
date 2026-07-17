-- Mirror DDL while Supabase remains the source of truth. The server write path
-- uses the corresponding db/migrations/0002_mutation_safety.sql migration.
CREATE SCHEMA IF NOT EXISTS getomerch_audit;

CREATE TABLE IF NOT EXISTS getomerch_audit.operation_requests (
    idempotency_key text PRIMARY KEY,
    operation text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    response jsonb,
    actor text NOT NULL,
    session_id text NOT NULL,
    request_id uuid NOT NULL,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT operation_requests_idempotency_key_check CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    CONSTRAINT operation_requests_operation_check CHECK (length(operation) BETWEEN 1 AND 120),
    CONSTRAINT operation_requests_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT operation_requests_status_check CHECK (status IN ('in_progress', 'succeeded'))
);

CREATE TABLE IF NOT EXISTS getomerch_audit.audit_log (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    actor text NOT NULL,
    session_id text NOT NULL,
    operation text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    request_id uuid NOT NULL,
    idempotency_key text,
    result text NOT NULL CHECK (result IN ('succeeded', 'failed')),
    before_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL
);

CREATE INDEX IF NOT EXISTS operation_requests_created_idx ON getomerch_audit.operation_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON getomerch_audit.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON getomerch_audit.audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_operation_idx ON getomerch_audit.audit_log (operation, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_success_idempotency_key
  ON getomerch_audit.audit_log (idempotency_key)
  WHERE result = 'succeeded' AND idempotency_key IS NOT NULL;

REVOKE ALL ON SCHEMA getomerch_audit FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA getomerch_audit FROM anon, authenticated;
