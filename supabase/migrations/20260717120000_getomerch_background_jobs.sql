-- Mirror DDL while Supabase remains the production source of truth. The queue
-- is used by the target server PostgreSQL after the write-source cutover.
CREATE SCHEMA IF NOT EXISTS getomerch_jobs;

CREATE TABLE IF NOT EXISTS getomerch_jobs.jobs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    type text NOT NULL CHECK (type IN (
      'ozon_orders_sync', 'ozon_finance_sync', 'ozon_prices_sync',
      'ozon_import_preview', 'ozon_import_apply'
    )),
    status text DEFAULT 'queued' NOT NULL CHECK (status IN (
      'queued', 'running', 'succeeded', 'failed', 'cancelled'
    )),
    dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
    idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor text NOT NULL,
    request_id uuid NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    available_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    locked_by text,
    locked_at timestamptz,
    heartbeat_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    cancel_requested_at timestamptz,
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_:-]{2,80}$'),
    error_message text,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamptz DEFAULT clock_timestamp() NOT NULL,
    CHECK (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempt_count <= max_attempts)
);

CREATE TABLE IF NOT EXISTS getomerch_jobs.job_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES getomerch_jobs.jobs(id) ON DELETE CASCADE,
    level text DEFAULT 'info' NOT NULL CHECK (level IN ('info', 'warning', 'error')),
    event text NOT NULL CHECK (length(event) BETWEEN 1 AND 120),
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT clock_timestamp() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_key
  ON getomerch_jobs.jobs (type, dedupe_key)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON getomerch_jobs.jobs (available_at, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_running_heartbeat_idx ON getomerch_jobs.jobs (heartbeat_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON getomerch_jobs.jobs (finished_at DESC) WHERE status IN ('succeeded', 'failed', 'cancelled');
CREATE INDEX IF NOT EXISTS job_events_job_created_idx ON getomerch_jobs.job_events (job_id, created_at, id);

CREATE OR REPLACE FUNCTION getomerch_jobs.prune_finished_jobs(
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
    SELECT id FROM getomerch_jobs.jobs
    WHERE status IN ('succeeded', 'failed', 'cancelled')
      AND finished_at < clock_timestamp() - retain_for
    ORDER BY finished_at, id
    LIMIT batch_limit
  )
  DELETE FROM getomerch_jobs.jobs target USING doomed WHERE target.id = doomed.id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON SCHEMA getomerch_jobs FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA getomerch_jobs FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA getomerch_jobs FROM anon, authenticated;
REVOKE ALL ON FUNCTION getomerch_jobs.prune_finished_jobs(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION getomerch_jobs.prune_finished_jobs(interval, integer) TO service_role;
