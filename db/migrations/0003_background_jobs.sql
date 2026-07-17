-- Durable background jobs for Ozon sync/import workers.
-- The queue is private and does not expand the 20-table business-data scope.

CREATE SCHEMA IF NOT EXISTS getomerch_jobs AUTHORIZATION getomerch_owner;

CREATE TABLE getomerch_jobs.jobs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    dedupe_key text NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    request_hash text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor text NOT NULL,
    request_id uuid NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    locked_by text,
    locked_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT jobs_type_check CHECK (
      type = ANY (ARRAY[
        'ozon_orders_sync'::text,
        'ozon_finance_sync'::text,
        'ozon_prices_sync'::text,
        'ozon_import_preview'::text,
        'ozon_import_apply'::text
      ])
    ),
    CONSTRAINT jobs_status_check CHECK (
      status = ANY (ARRAY[
        'queued'::text,
        'running'::text,
        'succeeded'::text,
        'failed'::text,
        'cancelled'::text
      ])
    ),
    CONSTRAINT jobs_dedupe_key_check CHECK (length(dedupe_key) BETWEEN 1 AND 300),
    CONSTRAINT jobs_idempotency_key_check CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    CONSTRAINT jobs_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT jobs_attempts_check CHECK (
      attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempt_count <= max_attempts
    ),
    CONSTRAINT jobs_error_code_check CHECK (
      error_code IS NULL OR error_code ~ '^[A-Za-z0-9_:-]{2,80}$'
    )
);

CREATE TABLE getomerch_jobs.job_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES getomerch_jobs.jobs(id) ON DELETE CASCADE,
    level text DEFAULT 'info'::text NOT NULL,
    event text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT job_events_level_check CHECK (
      level = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text])
    ),
    CONSTRAINT job_events_event_check CHECK (length(event) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX jobs_active_dedupe_key
  ON getomerch_jobs.jobs (type, dedupe_key)
  WHERE status = ANY (ARRAY['queued'::text, 'running'::text]);
CREATE INDEX jobs_queue_idx
  ON getomerch_jobs.jobs (available_at, created_at)
  WHERE status = 'queued';
CREATE INDEX jobs_running_heartbeat_idx
  ON getomerch_jobs.jobs (heartbeat_at)
  WHERE status = 'running';
CREATE INDEX jobs_finished_idx
  ON getomerch_jobs.jobs (finished_at DESC)
  WHERE status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text]);
CREATE INDEX job_events_job_created_idx
  ON getomerch_jobs.job_events (job_id, created_at, id);

CREATE FUNCTION getomerch_jobs.prune_finished_jobs(
  retain_for interval,
  batch_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, getomerch_jobs
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF retain_for < interval '7 days' THEN
    RAISE EXCEPTION 'job retention must be at least 7 days';
  END IF;
  IF batch_limit < 1 OR batch_limit > 5000 THEN
    RAISE EXCEPTION 'batch_limit must be between 1 and 5000';
  END IF;

  WITH doomed AS (
    SELECT id
    FROM getomerch_jobs.jobs
    WHERE status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])
      AND finished_at < clock_timestamp() - retain_for
    ORDER BY finished_at, id
    LIMIT batch_limit
  )
  DELETE FROM getomerch_jobs.jobs target
  USING doomed
  WHERE target.id = doomed.id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON SCHEMA getomerch_jobs FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA getomerch_jobs FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA getomerch_jobs FROM PUBLIC;
GRANT USAGE ON SCHEMA getomerch_jobs TO getomerch_app, getomerch_backup;
GRANT SELECT, INSERT, UPDATE ON getomerch_jobs.jobs TO getomerch_app;
GRANT SELECT, INSERT ON getomerch_jobs.job_events TO getomerch_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA getomerch_jobs TO getomerch_app;
REVOKE ALL ON FUNCTION getomerch_jobs.prune_finished_jobs(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION getomerch_jobs.prune_finished_jobs(interval, integer) TO getomerch_app;
GRANT SELECT ON ALL TABLES IN SCHEMA getomerch_jobs TO getomerch_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA getomerch_jobs TO getomerch_backup;
