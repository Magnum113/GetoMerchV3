-- Stage 9: durable, sanitized CRPT read-only checks. This migration adds no
-- CRPT write path and never stores a plaintext marking code or auth token.

CREATE TABLE public.merch_marking_crpt_queries (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    query_type text NOT NULL,
    marking_code_id uuid
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    external_document_id text,
    product_group text DEFAULT 'lp'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    normalized_status text,
    raw_status text,
    result_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    error_message text,
    owner_matches boolean,
    gtin_matches boolean,
    requested_by text NOT NULL,
    request_id uuid NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_crpt_queries_type_check
      CHECK (query_type = ANY (ARRAY['code_status'::text, 'document_status'::text])),
    CONSTRAINT merch_marking_crpt_queries_subject_check
      CHECK (
        (query_type = 'code_status' AND marking_code_id IS NOT NULL
          AND external_document_id IS NULL)
        OR
        (query_type = 'document_status' AND marking_code_id IS NULL
          AND external_document_id IS NOT NULL)
      ),
    CONSTRAINT merch_marking_crpt_queries_document_check
      CHECK (
        external_document_id IS NULL
        OR (
          length(external_document_id) BETWEEN 1 AND 200
          AND external_document_id ~ '^[A-Za-z0-9._:-]+$'
        )
      ),
    CONSTRAINT merch_marking_crpt_queries_product_group_check
      CHECK (product_group = 'lp'),
    CONSTRAINT merch_marking_crpt_queries_status_check
      CHECK (
        status = ANY (
          ARRAY['queued'::text, 'running'::text, 'succeeded'::text,
                'failed'::text, 'manual_review'::text]
        )
      ),
    CONSTRAINT merch_marking_crpt_queries_normalized_check
      CHECK (normalized_status IS NULL OR length(normalized_status) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_crpt_queries_raw_check
      CHECK (raw_status IS NULL OR length(raw_status) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_crpt_queries_result_check
      CHECK (
        jsonb_typeof(result_redacted) = 'object'
        AND octet_length(result_redacted::text) <= 16384
        AND NOT (result_redacted ?| ARRAY[
          'cis', 'ki', 'mark', 'markingCode', 'signature', 'token',
          'authorization', 'product_document'
        ])
      ),
    CONSTRAINT merch_marking_crpt_queries_error_check
      CHECK (
        (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120)
        AND (error_message IS NULL OR length(error_message) BETWEEN 1 AND 500)
      ),
    CONSTRAINT merch_marking_crpt_queries_actor_check
      CHECK (length(requested_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_crpt_queries_attempt_check CHECK (attempt_count >= 0),
    CONSTRAINT merch_marking_crpt_queries_terminal_check
      CHECK (
        (status = ANY (ARRAY['succeeded'::text, 'manual_review'::text])
          AND checked_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
        OR
        (status = 'failed' AND checked_at IS NOT NULL
          AND error_code IS NOT NULL AND error_message IS NOT NULL)
        OR
        (status = ANY (ARRAY['queued'::text, 'running'::text])
          AND checked_at IS NULL AND error_code IS NULL AND error_message IS NULL)
      )
);

CREATE INDEX merch_marking_crpt_queries_created
  ON public.merch_marking_crpt_queries (created_at DESC, id DESC);
CREATE INDEX merch_marking_crpt_queries_code_history
  ON public.merch_marking_crpt_queries (marking_code_id, created_at DESC, id DESC)
  WHERE marking_code_id IS NOT NULL;
CREATE UNIQUE INDEX merch_marking_crpt_queries_active_code
  ON public.merch_marking_crpt_queries (marking_code_id)
  WHERE query_type = 'code_status' AND status = ANY (ARRAY['queued'::text, 'running'::text]);
CREATE UNIQUE INDEX merch_marking_crpt_queries_active_document
  ON public.merch_marking_crpt_queries (external_document_id)
  WHERE query_type = 'document_status' AND status = ANY (ARRAY['queued'::text, 'running'::text]);

CREATE OR REPLACE FUNCTION getomerch_marking.create_crpt_read_query(
  p_query_type text,
  p_marking_code_id uuid,
  p_external_document_id text,
  p_actor_id text,
  p_request_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  existing_id uuid;
  created_id uuid;
BEGIN
  IF p_query_type IS NULL
     OR p_query_type <> ALL (ARRAY['code_status'::text, 'document_status'::text])
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid CRPT read query parameters' USING ERRCODE = 'MZ900';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'crpt-read:' || p_query_type || ':' || coalesce(p_marking_code_id::text, p_external_document_id),
    0
  ));

  IF p_query_type = 'code_status' THEN
    IF p_marking_code_id IS NULL OR p_external_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid CRPT code query subject' USING ERRCODE = 'MZ901';
    END IF;
    PERFORM 1 FROM public.merch_marking_codes AS code
    WHERE code.id = p_marking_code_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'marking code not found' USING ERRCODE = 'MZ902';
    END IF;
    SELECT query.id INTO existing_id
    FROM public.merch_marking_crpt_queries AS query
    WHERE query.query_type = 'code_status'
      AND query.marking_code_id = p_marking_code_id
      AND query.status = ANY (ARRAY['queued'::text, 'running'::text])
    LIMIT 1;
  ELSE
    IF p_marking_code_id IS NOT NULL
       OR p_external_document_id IS NULL
       OR length(p_external_document_id) NOT BETWEEN 1 AND 200
       OR p_external_document_id !~ '^[A-Za-z0-9._:-]+$' THEN
      RAISE EXCEPTION 'invalid CRPT document query subject' USING ERRCODE = 'MZ903';
    END IF;
    SELECT query.id INTO existing_id
    FROM public.merch_marking_crpt_queries AS query
    WHERE query.query_type = 'document_status'
      AND query.external_document_id = p_external_document_id
      AND query.status = ANY (ARRAY['queued'::text, 'running'::text])
    LIMIT 1;
  END IF;

  IF existing_id IS NOT NULL THEN
    RETURN existing_id;
  END IF;

  INSERT INTO public.merch_marking_crpt_queries (
    query_type, marking_code_id, external_document_id, requested_by, request_id
  ) VALUES (
    p_query_type, p_marking_code_id, p_external_document_id, p_actor_id, p_request_id
  ) RETURNING id INTO created_id;
  RETURN created_id;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.claim_crpt_read_query(
  p_query_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  query_id uuid,
  query_type text,
  marking_code_id uuid,
  external_document_id text,
  product_group text,
  gtin_snapshot text,
  fingerprint text,
  code_ciphertext bytea,
  code_nonce bytea,
  code_auth_tag bytea,
  encryption_key_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_query public.merch_marking_crpt_queries%ROWTYPE;
BEGIN
  IF p_query_id IS NULL OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid CRPT query claim' USING ERRCODE = 'MZ910';
  END IF;
  SELECT query.* INTO current_query
  FROM public.merch_marking_crpt_queries AS query
  WHERE query.id = p_query_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRPT query not found' USING ERRCODE = 'MZ911';
  END IF;
  IF current_query.status <> ALL (
    ARRAY['queued'::text, 'running'::text, 'failed'::text]
  ) THEN
    RAISE EXCEPTION 'CRPT query is already complete' USING ERRCODE = 'MZ912';
  END IF;

  UPDATE public.merch_marking_crpt_queries AS query
  SET status = 'running', attempt_count = query.attempt_count + 1,
      normalized_status = NULL, raw_status = NULL,
      result_redacted = '{}'::jsonb, error_code = NULL, error_message = NULL,
      owner_matches = NULL, gtin_matches = NULL, checked_at = NULL,
      updated_at = clock_timestamp()
  WHERE query.id = current_query.id;

  RETURN QUERY
  SELECT
    current_query.id,
    current_query.query_type,
    current_query.marking_code_id,
    current_query.external_document_id,
    current_query.product_group,
    code.gtin_snapshot,
    code.fingerprint,
    code.code_ciphertext,
    code.code_nonce,
    code.code_auth_tag,
    code.encryption_key_version
  FROM (SELECT 1) AS singleton
  LEFT JOIN public.merch_marking_codes AS code
    ON code.id = current_query.marking_code_id;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_crpt_read_success(
  p_query_id uuid,
  p_normalized_status text,
  p_raw_status text,
  p_result_redacted jsonb,
  p_owner_matches boolean,
  p_gtin_matches boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_query public.merch_marking_crpt_queries%ROWTYPE;
  next_status text;
BEGIN
  IF p_query_id IS NULL
     OR p_normalized_status IS NULL OR length(p_normalized_status) NOT BETWEEN 1 AND 120
     OR p_raw_status IS NULL OR length(p_raw_status) NOT BETWEEN 1 AND 300
     OR p_result_redacted IS NULL OR jsonb_typeof(p_result_redacted) <> 'object'
     OR octet_length(p_result_redacted::text) > 16384
     OR p_result_redacted ?| ARRAY[
       'cis', 'ki', 'mark', 'markingCode', 'signature', 'token',
       'authorization', 'product_document'
     ] THEN
    RAISE EXCEPTION 'invalid CRPT success result' USING ERRCODE = 'MZ920';
  END IF;
  SELECT query.* INTO current_query
  FROM public.merch_marking_crpt_queries AS query
  WHERE query.id = p_query_id
  FOR UPDATE;
  IF NOT FOUND OR current_query.status <> 'running' THEN
    RAISE EXCEPTION 'CRPT query is not running' USING ERRCODE = 'MZ921';
  END IF;

  next_status := CASE
    WHEN current_query.query_type = 'code_status'
      AND (
        p_normalized_status = 'unknown'
        OR p_owner_matches IS FALSE
        OR p_gtin_matches IS FALSE
      )
      THEN 'manual_review'
    ELSE 'succeeded'
  END;

  IF current_query.query_type = 'code_status' THEN
    IF p_normalized_status <> ALL (
      ARRAY['unknown'::text, 'emitted'::text, 'applied'::text,
            'introduced'::text, 'in_circulation'::text,
            'withdrawn'::text, 'invalid'::text]
    ) THEN
      RAISE EXCEPTION 'invalid normalized CRPT code state' USING ERRCODE = 'MZ922';
    END IF;
    UPDATE public.merch_marking_codes AS code
    SET crpt_state = CASE WHEN next_status = 'succeeded'
          THEN p_normalized_status ELSE code.crpt_state END,
        crpt_status_raw = p_raw_status,
        crpt_checked_at = clock_timestamp(),
        revision = code.revision + 1,
        updated_at = clock_timestamp()
    WHERE code.id = current_query.marking_code_id;
  END IF;

  UPDATE public.merch_marking_crpt_queries AS query
  SET status = next_status,
      normalized_status = p_normalized_status,
      raw_status = p_raw_status,
      result_redacted = p_result_redacted,
      owner_matches = p_owner_matches,
      gtin_matches = p_gtin_matches,
      error_code = NULL,
      error_message = NULL,
      checked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE query.id = current_query.id;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_crpt_read_failure(
  p_query_id uuid,
  p_error_code text,
  p_error_message text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_query_id IS NULL
     OR p_error_code IS NULL OR length(p_error_code) NOT BETWEEN 1 AND 120
     OR p_error_message IS NULL OR length(p_error_message) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid CRPT failure result' USING ERRCODE = 'MZ930';
  END IF;
  UPDATE public.merch_marking_crpt_queries AS query
  SET status = 'failed', normalized_status = NULL, raw_status = NULL,
      result_redacted = '{}'::jsonb, error_code = p_error_code,
      error_message = p_error_message, owner_matches = NULL,
      gtin_matches = NULL, checked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE query.id = p_query_id AND query.status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRPT query is not running' USING ERRCODE = 'MZ931';
  END IF;
END
$function$;

CREATE VIEW getomerch_marking.crpt_query_safe
WITH (security_barrier = true)
AS
SELECT
  query.id,
  query.query_type,
  query.marking_code_id,
  code.fingerprint,
  code.gtin_snapshot,
  query.external_document_id,
  query.product_group,
  query.status,
  query.normalized_status,
  query.raw_status,
  query.result_redacted,
  query.error_code,
  query.error_message,
  query.owner_matches,
  query.gtin_matches,
  query.requested_by,
  query.request_id,
  query.attempt_count,
  query.checked_at,
  query.created_at,
  query.updated_at
FROM public.merch_marking_crpt_queries AS query
LEFT JOIN public.merch_marking_codes AS code ON code.id = query.marking_code_id;

ALTER TABLE getomerch_jobs.jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE getomerch_jobs.jobs ADD CONSTRAINT jobs_type_check CHECK (
  type = ANY (ARRAY[
    'ozon_orders_sync'::text, 'ozon_finance_sync'::text,
    'ozon_prices_sync'::text, 'ozon_import_preview'::text,
    'ozon_import_apply'::text, 'marking_prepare_assignment'::text,
    'marking_ozon_validate'::text, 'marking_ozon_submit'::text,
    'marking_ozon_poll'::text, 'marking_crpt_auth_refresh'::text,
    'marking_crpt_code_status_sync'::text,
    'marking_crpt_application_submit'::text,
    'marking_crpt_introduction_submit'::text,
    'marking_crpt_document_poll'::text,
    'marking_withdrawal_submit'::text,
    'marking_return_to_circulation_submit'::text,
    'marking_returns_sync'::text, 'marking_reconcile'::text,
    'marking_suz_order_submit'::text, 'marking_suz_order_poll'::text
  ])
) NOT VALID;
ALTER TABLE getomerch_jobs.jobs VALIDATE CONSTRAINT jobs_type_check;

CREATE OR REPLACE VIEW getomerch_jobs.marking_jobs
WITH (security_barrier = true)
AS
SELECT
  id, type, status, dedupe_key, idempotency_key, request_hash, payload,
  result, progress, actor, request_id, attempt_count, max_attempts,
  available_at, locked_by, locked_at, heartbeat_at, started_at, finished_at,
  cancel_requested_at, error_code, error_message, created_at, updated_at
FROM getomerch_jobs.jobs
WHERE type = ANY (ARRAY[
  'marking_prepare_assignment'::text, 'marking_ozon_validate'::text,
  'marking_ozon_submit'::text, 'marking_ozon_poll'::text,
  'marking_crpt_auth_refresh'::text,
  'marking_crpt_code_status_sync'::text,
  'marking_crpt_application_submit'::text,
  'marking_crpt_introduction_submit'::text,
  'marking_crpt_document_poll'::text,
  'marking_withdrawal_submit'::text,
  'marking_return_to_circulation_submit'::text,
  'marking_returns_sync'::text, 'marking_reconcile'::text,
  'marking_suz_order_submit'::text, 'marking_suz_order_poll'::text
])
WITH LOCAL CHECK OPTION;

CREATE OR REPLACE FUNCTION getomerch_jobs.append_marking_job_event(
  p_job_id uuid,
  p_level text,
  p_event text,
  p_details jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_job_id IS NULL
     OR p_level <> ALL (ARRAY['info'::text, 'warning'::text, 'error'::text])
     OR p_event IS NULL OR length(p_event) NOT BETWEEN 1 AND 120
     OR p_details IS NULL OR jsonb_typeof(p_details) <> 'object'
     OR octet_length(p_details::text) > 8192
     OR p_details::text ~* '"(cis|ki|mark|markingcode|signature|token|authorization|product_document)"[[:space:]]*:' THEN
    RAISE EXCEPTION 'invalid marking job event' USING ERRCODE = 'MZ940';
  END IF;

  PERFORM 1
  FROM getomerch_jobs.jobs AS job
  WHERE job.id = p_job_id
    AND job.type = ANY (ARRAY[
      'marking_prepare_assignment'::text, 'marking_ozon_validate'::text,
      'marking_ozon_submit'::text, 'marking_ozon_poll'::text,
      'marking_crpt_auth_refresh'::text,
      'marking_crpt_code_status_sync'::text,
      'marking_crpt_application_submit'::text,
      'marking_crpt_introduction_submit'::text,
      'marking_crpt_document_poll'::text,
      'marking_withdrawal_submit'::text,
      'marking_return_to_circulation_submit'::text,
      'marking_returns_sync'::text, 'marking_reconcile'::text,
      'marking_suz_order_submit'::text, 'marking_suz_order_poll'::text
    ]);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking job not found' USING ERRCODE = 'MZ941';
  END IF;

  INSERT INTO getomerch_jobs.job_events (job_id, level, event, details)
  VALUES (p_job_id, p_level, p_event, p_details);
END
$function$;

REVOKE ALL ON public.merch_marking_crpt_queries FROM PUBLIC, getomerch_app;
GRANT SELECT ON public.merch_marking_crpt_queries TO getomerch_backup;
REVOKE ALL ON getomerch_marking.crpt_query_safe FROM PUBLIC;
GRANT SELECT ON getomerch_marking.crpt_query_safe TO getomerch_app, getomerch_backup;

REVOKE ALL ON FUNCTION getomerch_marking.create_crpt_read_query(
  text, uuid, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.claim_crpt_read_query(
  uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_crpt_read_success(
  uuid, text, text, jsonb, boolean, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_crpt_read_failure(
  uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_jobs.append_marking_job_event(
  uuid, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION getomerch_marking.create_crpt_read_query(
  text, uuid, text, text, uuid
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.claim_crpt_read_query(
  uuid, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_crpt_read_success(
  uuid, text, text, jsonb, boolean, boolean
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_crpt_read_failure(
  uuid, text, text
) TO getomerch_app;

COMMENT ON TABLE public.merch_marking_crpt_queries IS
  'Sanitized durable Stage 9 CRPT read-only checks; never stores plaintext CIS, signatures or tokens.';
COMMENT ON FUNCTION getomerch_marking.claim_crpt_read_query(uuid, text) IS
  'Narrow marking-worker material path. Returned ciphertext must never enter JSON, jobs or logs.';
