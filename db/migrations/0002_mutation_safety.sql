-- Transactional mutation support for the server PostgreSQL write path.
-- Business tables remain in public; request idempotency and audit records are
-- isolated so the 20-table source-data transfer contract does not change.

CREATE SCHEMA IF NOT EXISTS getomerch_audit AUTHORIZATION getomerch_owner;

CREATE TABLE getomerch_audit.operation_requests (
    idempotency_key text PRIMARY KEY,
    operation text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    response jsonb,
    actor text NOT NULL,
    session_id text NOT NULL,
    request_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT operation_requests_idempotency_key_check
      CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    CONSTRAINT operation_requests_operation_check
      CHECK (length(operation) BETWEEN 1 AND 120),
    CONSTRAINT operation_requests_request_hash_check
      CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT operation_requests_status_check
      CHECK (status = ANY (ARRAY['in_progress'::text, 'succeeded'::text]))
);

CREATE TABLE getomerch_audit.audit_log (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    actor text NOT NULL,
    session_id text NOT NULL,
    operation text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    request_id uuid NOT NULL,
    idempotency_key text,
    result text NOT NULL,
    before_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT audit_log_result_check
      CHECK (result = ANY (ARRAY['succeeded'::text, 'failed'::text]))
);

CREATE INDEX operation_requests_created_idx
  ON getomerch_audit.operation_requests (created_at DESC);
CREATE INDEX audit_log_created_idx
  ON getomerch_audit.audit_log (created_at DESC);
CREATE INDEX audit_log_entity_idx
  ON getomerch_audit.audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_operation_idx
  ON getomerch_audit.audit_log (operation, created_at DESC);
CREATE UNIQUE INDEX audit_log_success_idempotency_key
  ON getomerch_audit.audit_log (idempotency_key)
  WHERE result = 'succeeded' AND idempotency_key IS NOT NULL;

REVOKE ALL ON SCHEMA getomerch_audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA getomerch_audit FROM PUBLIC;
GRANT USAGE ON SCHEMA getomerch_audit TO getomerch_app, getomerch_backup;
GRANT SELECT, INSERT, UPDATE ON getomerch_audit.operation_requests TO getomerch_app;
GRANT SELECT, INSERT ON getomerch_audit.audit_log TO getomerch_app;
GRANT SELECT ON ALL TABLES IN SCHEMA getomerch_audit TO getomerch_backup;
