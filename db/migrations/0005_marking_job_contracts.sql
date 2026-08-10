-- Register future marking jobs without activating any handler or external write.
--
-- The general worker explicitly claims only CORE_JOB_TYPES. The separate
-- marking worker remains idle while GETOMERCH_MARKING_ENABLED=false.

ALTER TABLE getomerch_jobs.jobs
    DROP CONSTRAINT IF EXISTS jobs_type_check;

ALTER TABLE getomerch_jobs.jobs
    ADD CONSTRAINT jobs_type_check CHECK (
      type = ANY (ARRAY[
        'ozon_orders_sync'::text,
        'ozon_finance_sync'::text,
        'ozon_prices_sync'::text,
        'ozon_import_preview'::text,
        'ozon_import_apply'::text,
        'marking_prepare_assignment'::text,
        'marking_ozon_validate'::text,
        'marking_ozon_submit'::text,
        'marking_ozon_poll'::text,
        'marking_crpt_auth_refresh'::text,
        'marking_crpt_application_submit'::text,
        'marking_crpt_introduction_submit'::text,
        'marking_crpt_document_poll'::text,
        'marking_withdrawal_submit'::text,
        'marking_return_to_circulation_submit'::text,
        'marking_returns_sync'::text,
        'marking_reconcile'::text,
        'marking_suz_order_submit'::text,
        'marking_suz_order_poll'::text
      ])
    ) NOT VALID;

ALTER TABLE getomerch_jobs.jobs
    VALIDATE CONSTRAINT jobs_type_check;

-- The future marking worker must not receive UPDATE on the unfiltered jobs
-- table. This view is deliberately updateable, restricted to marking jobs, and
-- exposes explicit columns so later migrations can extend the table safely.
CREATE OR REPLACE VIEW getomerch_jobs.marking_jobs
WITH (security_barrier = true)
AS
SELECT
  id,
  type,
  status,
  dedupe_key,
  idempotency_key,
  request_hash,
  payload,
  result,
  progress,
  actor,
  request_id,
  attempt_count,
  max_attempts,
  available_at,
  locked_by,
  locked_at,
  heartbeat_at,
  started_at,
  finished_at,
  cancel_requested_at,
  error_code,
  error_message,
  created_at,
  updated_at
FROM getomerch_jobs.jobs
WHERE type = ANY (ARRAY[
  'marking_prepare_assignment'::text,
  'marking_ozon_validate'::text,
  'marking_ozon_submit'::text,
  'marking_ozon_poll'::text,
  'marking_crpt_auth_refresh'::text,
  'marking_crpt_application_submit'::text,
  'marking_crpt_introduction_submit'::text,
  'marking_crpt_document_poll'::text,
  'marking_withdrawal_submit'::text,
  'marking_return_to_circulation_submit'::text,
  'marking_returns_sync'::text,
  'marking_reconcile'::text,
  'marking_suz_order_submit'::text,
  'marking_suz_order_poll'::text
])
WITH LOCAL CHECK OPTION;
