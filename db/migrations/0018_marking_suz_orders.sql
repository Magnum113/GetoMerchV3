-- Stage 13: SUZ order lifecycle and controlled marking-code pool replenishment.
-- External writes remain disabled by runtime flags. Full codes stay encrypted
-- and are never exposed through the views or command results below.

ALTER TABLE public.merch_marking_trade_items
  ADD COLUMN pool_policy_enabled boolean DEFAULT false NOT NULL,
  ADD COLUMN pool_minimum integer DEFAULT 5 NOT NULL,
  ADD COLUMN pool_target integer DEFAULT 20 NOT NULL,
  ADD COLUMN pool_lead_time_hours integer DEFAULT 24 NOT NULL,
  ADD COLUMN pool_average_window_days integer DEFAULT 30 NOT NULL,
  ADD COLUMN suz_order_quantity_limit integer DEFAULT 1000 NOT NULL,
  ADD COLUMN pool_policy_revision bigint DEFAULT 1 NOT NULL,
  ADD COLUMN pool_policy_changed_at timestamp with time zone,
  ADD COLUMN pool_policy_changed_by text;

ALTER TABLE public.merch_marking_trade_items
  ADD CONSTRAINT merch_marking_trade_items_pool_policy_check CHECK (
    pool_minimum BETWEEN 0 AND 5000
    AND pool_target BETWEEN 1 AND 5000
    AND pool_target >= pool_minimum
    AND pool_lead_time_hours BETWEEN 1 AND 720
    AND pool_average_window_days BETWEEN 1 AND 365
    AND suz_order_quantity_limit BETWEEN 1 AND 5000
    AND pool_policy_revision >= 1
  ),
  ADD CONSTRAINT merch_marking_trade_items_pool_policy_actor_check CHECK (
    (pool_policy_changed_at IS NULL AND pool_policy_changed_by IS NULL)
    OR (
      pool_policy_changed_at IS NOT NULL
      AND pool_policy_changed_by IS NOT NULL
      AND length(pool_policy_changed_by) BETWEEN 1 AND 200
    )
  );

CREATE TABLE public.merch_marking_code_orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  contour text NOT NULL,
  production_mode text NOT NULL,
  source text NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  product_group text DEFAULT 'lp' NOT NULL,
  external_oms_id uuid,
  external_order_id uuid,
  expected_completion_time_ms integer,
  contract_version text DEFAULT 'suz-api-3.0-2026-07-24' NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text,
  signature_hash text,
  certificate_thumbprint text,
  response_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
  error_code text,
  error_message text,
  manual_review_reason text,
  approved_by text,
  approved_at timestamp with time zone,
  submit_started_at timestamp with time zone,
  submitted_at timestamp with time zone,
  last_polled_at timestamp with time zone,
  utilisation_checked_at timestamp with time zone,
  completed_at timestamp with time zone,
  revision bigint DEFAULT 1 NOT NULL,
  created_by text NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT merch_marking_code_orders_contour_check
    CHECK (contour = ANY (ARRAY['sandbox'::text, 'production'::text])),
  CONSTRAINT merch_marking_code_orders_mode_check
    CHECK (production_mode = ANY (ARRAY['own_production'::text, 'remarking'::text])),
  CONSTRAINT merch_marking_code_orders_source_check
    CHECK (source = ANY (ARRAY['forecast'::text, 'manual'::text, 'automation'::text])),
  CONSTRAINT merch_marking_code_orders_status_check CHECK (
    status = ANY (ARRAY[
      'draft'::text, 'approved'::text, 'submitting'::text,
      'submitted'::text, 'ready'::text, 'receiving'::text,
      'awaiting_utilisation'::text, 'completed'::text,
      'rejected'::text, 'manual_review'::text, 'cancelled'::text
    ])
  ),
  CONSTRAINT merch_marking_code_orders_product_group_check CHECK (product_group = 'lp'),
  CONSTRAINT merch_marking_code_orders_contract_check
    CHECK (length(contract_version) BETWEEN 1 AND 120),
  CONSTRAINT merch_marking_code_orders_idempotency_check
    CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT merch_marking_code_orders_hash_check CHECK (
    (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$')
    AND (signature_hash IS NULL OR signature_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT merch_marking_code_orders_certificate_check CHECK (
    certificate_thumbprint IS NULL
    OR certificate_thumbprint ~ '^[0-9A-F]{40,128}$'
  ),
  CONSTRAINT merch_marking_code_orders_response_check CHECK (
    jsonb_typeof(response_redacted) = 'object'
    AND octet_length(response_redacted::text) <= 32768
  ),
  CONSTRAINT merch_marking_code_orders_text_check CHECK (
    (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120)
    AND (error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000)
    AND (manual_review_reason IS NULL OR length(manual_review_reason) BETWEEN 1 AND 1000)
    AND length(created_by) BETWEEN 1 AND 200
  ),
  CONSTRAINT merch_marking_code_orders_approval_check CHECK (
    (approved_at IS NULL AND approved_by IS NULL)
    OR (
      approved_at IS NOT NULL
      AND approved_by IS NOT NULL
      AND length(approved_by) BETWEEN 1 AND 200
    )
  ),
  CONSTRAINT merch_marking_code_orders_external_check CHECK (
    external_order_id IS NULL OR external_oms_id IS NOT NULL
  ),
  CONSTRAINT merch_marking_code_orders_manual_check CHECK (
    status <> 'manual_review' OR manual_review_reason IS NOT NULL
  ),
  CONSTRAINT merch_marking_code_orders_completed_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CONSTRAINT merch_marking_code_orders_revision_check CHECK (revision >= 1)
);

CREATE UNIQUE INDEX merch_marking_code_orders_external
  ON public.merch_marking_code_orders (contour, external_order_id)
  WHERE external_order_id IS NOT NULL;
CREATE INDEX merch_marking_code_orders_status
  ON public.merch_marking_code_orders (status, updated_at, id);

CREATE TABLE public.merch_marking_code_order_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code_order_id uuid NOT NULL
    REFERENCES public.merch_marking_code_orders(id) ON DELETE RESTRICT,
  trade_item_id uuid NOT NULL
    REFERENCES public.merch_marking_trade_items(id) ON DELETE RESTRICT,
  gtin_snapshot text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  requested_quantity integer NOT NULL,
  received_quantity integer DEFAULT 0 NOT NULL,
  ingested_quantity integer DEFAULT 0 NOT NULL,
  duplicate_quantity integer DEFAULT 0 NOT NULL,
  rejected_quantity integer DEFAULT 0 NOT NULL,
  utilised_quantity integer DEFAULT 0 NOT NULL,
  available_quantity integer DEFAULT 0 NOT NULL,
  template_id integer DEFAULT 10 NOT NULL,
  cis_type text DEFAULT 'UNIT' NOT NULL,
  serial_number_type text DEFAULT 'OPERATOR' NOT NULL,
  release_method_type text DEFAULT 'PRODUCTION' NOT NULL,
  create_method_type text DEFAULT 'SELF_MADE' NOT NULL,
  remote_order_status text,
  remote_buffer_status text,
  remote_available_codes integer,
  block_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  import_batch_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  utilisation_receipt_id uuid,
  utilisation_state text,
  utilisation_code integer,
  response_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
  forecast_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
  error_code text,
  error_message text,
  revision bigint DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT merch_marking_code_order_items_gtin_check
    CHECK (getomerch_marking.is_valid_gtin14(gtin_snapshot)),
  CONSTRAINT merch_marking_code_order_items_status_check
    CHECK (status = ANY (ARRAY['open'::text, 'completed'::text,
      'rejected'::text, 'manual_review'::text, 'cancelled'::text])),
  CONSTRAINT merch_marking_code_order_items_quantity_check CHECK (
    requested_quantity BETWEEN 1 AND 5000
    AND received_quantity BETWEEN 0 AND requested_quantity
    AND ingested_quantity BETWEEN 0 AND received_quantity
    AND duplicate_quantity BETWEEN 0 AND received_quantity
    AND rejected_quantity BETWEEN 0 AND received_quantity
    AND utilised_quantity BETWEEN 0 AND received_quantity
    AND available_quantity BETWEEN 0 AND ingested_quantity
  ),
  CONSTRAINT merch_marking_code_order_items_contract_check CHECK (
    template_id = 10
    AND cis_type = 'UNIT'
    AND serial_number_type = 'OPERATOR'
    AND release_method_type = 'PRODUCTION'
    AND create_method_type = 'SELF_MADE'
  ),
  CONSTRAINT merch_marking_code_order_items_remote_count_check
    CHECK (remote_available_codes IS NULL OR remote_available_codes >= 0),
  CONSTRAINT merch_marking_code_order_items_array_check CHECK (
    cardinality(block_ids) <= 5000
    AND cardinality(import_batch_ids) <= 5000
    AND cardinality(block_ids) = cardinality(import_batch_ids)
  ),
  CONSTRAINT merch_marking_code_order_items_json_check CHECK (
    jsonb_typeof(response_redacted) = 'object'
    AND octet_length(response_redacted::text) <= 32768
    AND jsonb_typeof(forecast_snapshot) = 'object'
    AND octet_length(forecast_snapshot::text) <= 32768
  ),
  CONSTRAINT merch_marking_code_order_items_error_check CHECK (
    (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120)
    AND (error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000)
  ),
  CONSTRAINT merch_marking_code_order_items_utilisation_check CHECK (
    (utilisation_state IS NULL AND utilisation_code IS NULL
      AND utilisation_receipt_id IS NULL)
    OR (utilisation_state IS NOT NULL AND utilisation_code IS NOT NULL
      AND utilisation_receipt_id IS NOT NULL)
  ),
  CONSTRAINT merch_marking_code_order_items_revision_check CHECK (revision >= 1),
  UNIQUE (code_order_id, trade_item_id),
  UNIQUE (id, code_order_id)
);

CREATE UNIQUE INDEX merch_marking_code_order_items_open_trade_item
  ON public.merch_marking_code_order_items (trade_item_id)
  WHERE status = ANY (ARRAY['open'::text, 'manual_review'::text]);
CREATE INDEX merch_marking_code_order_items_order
  ON public.merch_marking_code_order_items (code_order_id, id);

ALTER TABLE public.merch_marking_codes
  DROP CONSTRAINT merch_marking_codes_pool_state_check,
  ADD CONSTRAINT merch_marking_codes_pool_state_check CHECK (
    pool_state = ANY (ARRAY[
      'pending_utilisation'::text, 'available'::text, 'reserved'::text,
      'bound'::text, 'invalid'::text, 'quarantined'::text,
      'retired'::text, 'replaced'::text
    ])
  ),
  ADD CONSTRAINT merch_marking_codes_order_item_fkey
    FOREIGN KEY (code_order_item_id)
    REFERENCES public.merch_marking_code_order_items(id) ON DELETE RESTRICT;

ALTER TABLE public.merch_marking_signature_requests
  DROP CONSTRAINT merch_marking_signature_requests_purpose_check,
  ADD CONSTRAINT merch_marking_signature_requests_purpose_check CHECK (
    purpose = ANY (ARRAY[
      'crpt_auth_attached_cades_bes'::text,
      'crpt_document_detached_cades_bes'::text,
      'crpt_suz_order_detached_cades_bes'::text
    ])
  );

CREATE OR REPLACE FUNCTION getomerch_marking.create_remote_signature_request(
  p_purpose text, p_payload_sha256 text, p_payload_ciphertext bytea,
  p_payload_nonce bytea, p_payload_auth_tag bytea,
  p_encryption_key_version integer, p_requested_by text,
  p_request_id uuid, p_expires_at timestamp with time zone
)
RETURNS TABLE (signature_request_id uuid, request_status text, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  existing_request public.merch_marking_signature_requests%ROWTYPE;
  created_id uuid;
BEGIN
  IF p_purpose <> ALL (ARRAY[
       'crpt_auth_attached_cades_bes'::text,
       'crpt_document_detached_cades_bes'::text,
       'crpt_suz_order_detached_cades_bes'::text
     ])
     OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR octet_length(p_payload_ciphertext) NOT BETWEEN 1 AND 262144
     OR octet_length(p_payload_nonce) <> 12
     OR octet_length(p_payload_auth_tag) <> 16
     OR p_encryption_key_version NOT BETWEEN 1 AND 1000000
     OR p_requested_by IS NULL OR length(p_requested_by) NOT BETWEEN 1 AND 200
     OR p_request_id IS NULL OR p_expires_at <= clock_timestamp()
     OR p_expires_at > clock_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid remote signature request' USING ERRCODE = 'MZ950';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'remote-signature:' || p_purpose || ':' || p_payload_sha256 || ':' || p_requested_by, 0
  ));
  UPDATE public.merch_marking_signature_requests AS request SET
    status = 'expired', lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE request.purpose = p_purpose AND request.payload_sha256 = p_payload_sha256
    AND request.requested_by = p_requested_by
    AND request.status = ANY (ARRAY['pending'::text, 'leased'::text])
    AND request.expires_at <= clock_timestamp();
  SELECT request.* INTO existing_request
  FROM public.merch_marking_signature_requests AS request
  WHERE request.purpose = p_purpose AND request.payload_sha256 = p_payload_sha256
    AND request.requested_by = p_requested_by
    AND request.status = ANY (ARRAY['pending'::text, 'leased'::text, 'signed'::text])
  ORDER BY request.created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT existing_request.id, existing_request.status, true;
    RETURN;
  END IF;
  INSERT INTO public.merch_marking_signature_requests (
    purpose, payload_sha256, payload_ciphertext, payload_nonce, payload_auth_tag,
    encryption_key_version, requested_by, request_id, expires_at
  ) VALUES (
    p_purpose, p_payload_sha256, p_payload_ciphertext, p_payload_nonce,
    p_payload_auth_tag, p_encryption_key_version, p_requested_by, p_request_id,
    p_expires_at
  ) RETURNING id INTO created_id;
  RETURN QUERY SELECT created_id, 'pending'::text, false;
END
$function$;

CREATE INDEX merch_marking_codes_order_item
  ON public.merch_marking_codes (code_order_item_id, pool_state, id)
  WHERE code_order_item_id IS NOT NULL;

CREATE OR REPLACE VIEW getomerch_marking.suz_pool_forecast_safe
WITH (security_barrier = true)
AS
WITH pool AS (
  SELECT code.trade_item_id,
    count(*) FILTER (WHERE code.pool_state = 'available')::integer AS available,
    count(*) FILTER (WHERE code.pool_state = 'pending_utilisation')::integer AS pending_utilisation,
    count(*) FILTER (WHERE code.pool_state = 'quarantined')::integer AS quarantined,
    count(*) FILTER (WHERE code.pool_state = 'invalid')::integer AS rejected
  FROM public.merch_marking_codes AS code
  GROUP BY code.trade_item_id
), assigned AS (
  SELECT assignment.fulfillment_item_id,
    count(*) FILTER (WHERE assignment.status = ANY (ARRAY['active'::text, 'completed'::text]))::integer AS assigned
  FROM public.merch_marking_assignments AS assignment
  GROUP BY assignment.fulfillment_item_id
), demand AS (
  SELECT profile.trade_item_id,
    sum(greatest(item.quantity - coalesce(assigned.assigned, 0), 0))::integer AS active_demand
  FROM public.merch_fulfillment_order_items AS item
  JOIN public.merch_marking_product_profiles AS profile
    ON profile.product_id = item.product_id
   AND profile.archived_at IS NULL
   AND profile.requires_marking
   AND profile.operational_status = 'enabled'
  LEFT JOIN assigned ON assigned.fulfillment_item_id = item.id
  WHERE item.source_active AND item.marking_requirement = 'required'
  GROUP BY profile.trade_item_id
), consumption AS (
  SELECT assignment.gtin_snapshot,
    count(*) FILTER (WHERE assignment.status = ANY (ARRAY['active'::text, 'completed'::text]))::integer AS consumed
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_trade_items AS trade_item
    ON trade_item.gtin = assignment.gtin_snapshot
  WHERE assignment.assigned_at >= clock_timestamp()
    - make_interval(days => trade_item.pool_average_window_days)
  GROUP BY assignment.gtin_snapshot
), inbound AS (
  SELECT item.trade_item_id,
    sum(greatest(item.requested_quantity - item.available_quantity, 0))::integer AS inbound
  FROM public.merch_marking_code_order_items AS item
  WHERE item.status = ANY (ARRAY['open'::text, 'manual_review'::text])
  GROUP BY item.trade_item_id
)
SELECT trade_item.id AS trade_item_id, trade_item.gtin,
  trade_item.pool_policy_enabled, trade_item.pool_minimum,
  trade_item.pool_target, trade_item.pool_lead_time_hours,
  trade_item.pool_average_window_days, trade_item.suz_order_quantity_limit,
  trade_item.pool_policy_revision,
  coalesce(pool.available, 0) AS available,
  coalesce(pool.pending_utilisation, 0) AS pending_utilisation,
  coalesce(pool.quarantined, 0) AS quarantined,
  coalesce(pool.rejected, 0) AS rejected,
  coalesce(demand.active_demand, 0) AS active_demand,
  coalesce(consumption.consumed, 0) AS consumed_in_window,
  round(coalesce(consumption.consumed, 0)::numeric
    / trade_item.pool_average_window_days, 3) AS average_daily_use,
  ceil((coalesce(consumption.consumed, 0)::numeric
    / trade_item.pool_average_window_days)
    * trade_item.pool_lead_time_hours / 24)::integer AS lead_time_demand,
  coalesce(inbound.inbound, 0) AS inbound,
  greatest(
    trade_item.pool_target,
    coalesce(demand.active_demand, 0)
      + ceil((coalesce(consumption.consumed, 0)::numeric
        / trade_item.pool_average_window_days)
        * trade_item.pool_lead_time_hours / 24)::integer
  ) AS calculated_target,
  least(
    trade_item.suz_order_quantity_limit,
    greatest(0,
      greatest(
        trade_item.pool_target,
        coalesce(demand.active_demand, 0)
          + ceil((coalesce(consumption.consumed, 0)::numeric
            / trade_item.pool_average_window_days)
            * trade_item.pool_lead_time_hours / 24)::integer
      ) - coalesce(pool.available, 0) - coalesce(inbound.inbound, 0)
    )
  )::integer AS recommended_quantity,
  (coalesce(pool.available, 0) < trade_item.pool_minimum
    OR coalesce(pool.available, 0) < coalesce(demand.active_demand, 0)) AS pool_low,
  trade_item.updated_at
FROM public.merch_marking_trade_items AS trade_item
LEFT JOIN pool ON pool.trade_item_id = trade_item.id
LEFT JOIN demand ON demand.trade_item_id = trade_item.id
LEFT JOIN consumption ON consumption.gtin_snapshot = trade_item.gtin
LEFT JOIN inbound ON inbound.trade_item_id = trade_item.id
WHERE trade_item.archived_at IS NULL
  AND trade_item.verification_status = 'verified'
  AND trade_item.product_group = 'clothes'
  AND EXISTS (
    SELECT 1 FROM public.merch_marking_product_profiles AS profile
    WHERE profile.trade_item_id = trade_item.id
      AND profile.archived_at IS NULL
      AND profile.requires_marking
      AND profile.operational_status = 'enabled'
  );

CREATE VIEW getomerch_marking.suz_code_order_safe
WITH (security_barrier = true)
AS
SELECT order_data.id AS order_id, item.id AS order_item_id,
  item.trade_item_id, item.gtin_snapshot AS gtin,
  order_data.contour, order_data.production_mode, order_data.source,
  order_data.status, item.status AS item_status,
  item.requested_quantity, item.received_quantity, item.ingested_quantity,
  item.duplicate_quantity, item.rejected_quantity, item.utilised_quantity,
  item.available_quantity, item.remote_order_status,
  item.remote_buffer_status, item.remote_available_codes,
  cardinality(item.block_ids) AS block_count,
  order_data.external_order_id, order_data.expected_completion_time_ms,
  item.utilisation_receipt_id, item.utilisation_state, item.utilisation_code,
  order_data.error_code, order_data.error_message,
  order_data.manual_review_reason, order_data.approved_by,
  order_data.approved_at, order_data.submit_started_at,
  order_data.submitted_at, order_data.last_polled_at,
  order_data.utilisation_checked_at, order_data.completed_at,
  order_data.contract_version, order_data.revision,
  order_data.created_by, order_data.created_at, order_data.updated_at,
  array_remove(ARRAY[
    CASE WHEN item.received_quantity <> item.requested_quantity
      AND order_data.status = ANY (ARRAY['awaiting_utilisation'::text,
        'completed'::text, 'manual_review'::text])
      THEN 'quantity_mismatch' END,
    CASE WHEN order_data.status = 'submitted'
      AND order_data.updated_at < clock_timestamp() - interval '30 minutes'
      THEN 'order_stuck' END,
    CASE WHEN order_data.status = 'awaiting_utilisation'
      AND order_data.updated_at < clock_timestamp() - interval '30 minutes'
      THEN 'utilisation_stuck' END
  ], NULL) AS alert_codes
FROM public.merch_marking_code_orders AS order_data
JOIN public.merch_marking_code_order_items AS item
  ON item.code_order_id = order_data.id;

CREATE OR REPLACE FUNCTION getomerch_marking.update_suz_pool_policy(
  p_trade_item_id uuid, p_expected_revision bigint, p_enabled boolean,
  p_minimum integer, p_target integer, p_lead_time_hours integer,
  p_average_window_days integer, p_order_limit integer, p_actor_id text
)
RETURNS TABLE (trade_item_id uuid, policy_revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200
    OR p_minimum NOT BETWEEN 0 AND 5000 OR p_target NOT BETWEEN 1 AND 5000
    OR p_target < p_minimum OR p_lead_time_hours NOT BETWEEN 1 AND 720
    OR p_average_window_days NOT BETWEEN 1 AND 365
    OR p_order_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'invalid SUZ pool policy' USING ERRCODE = 'MZD00';
  END IF;
  RETURN QUERY
  UPDATE public.merch_marking_trade_items AS trade_item SET
    pool_policy_enabled = p_enabled, pool_minimum = p_minimum,
    pool_target = p_target, pool_lead_time_hours = p_lead_time_hours,
    pool_average_window_days = p_average_window_days,
    suz_order_quantity_limit = p_order_limit,
    pool_policy_revision = trade_item.pool_policy_revision + 1,
    pool_policy_changed_at = clock_timestamp(),
    pool_policy_changed_by = p_actor_id, updated_at = clock_timestamp()
  WHERE trade_item.id = p_trade_item_id
    AND trade_item.pool_policy_revision = p_expected_revision
    AND trade_item.archived_at IS NULL
    AND trade_item.verification_status = 'verified'
  RETURNING trade_item.id, trade_item.pool_policy_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUZ pool policy revision conflict' USING ERRCODE = 'MZD01';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.create_suz_order_draft(
  p_trade_item_id uuid, p_quantity integer, p_contour text, p_source text,
  p_idempotency_key text, p_forecast_snapshot jsonb, p_actor_id text
)
RETURNS TABLE (order_id uuid, order_item_id uuid, order_revision bigint, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  trade_record public.merch_marking_trade_items%ROWTYPE;
  existing_record record;
  created_order_id uuid;
  created_item_id uuid;
BEGIN
  IF p_quantity NOT BETWEEN 1 AND 5000
    OR p_contour <> ALL (ARRAY['sandbox'::text, 'production'::text])
    OR p_source <> ALL (ARRAY['forecast'::text, 'manual'::text, 'automation'::text])
    OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200
    OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200
    OR jsonb_typeof(p_forecast_snapshot) <> 'object'
    OR octet_length(p_forecast_snapshot::text) > 32768 THEN
    RAISE EXCEPTION 'invalid SUZ draft request' USING ERRCODE = 'MZD02';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('suz-order:' || p_trade_item_id::text, 0));
  SELECT trade_item.* INTO trade_record
  FROM public.merch_marking_trade_items AS trade_item
  WHERE trade_item.id = p_trade_item_id FOR UPDATE;
  IF NOT FOUND OR trade_record.archived_at IS NOT NULL
    OR trade_record.verification_status <> 'verified'
    OR trade_record.product_group <> 'clothes' THEN
    RAISE EXCEPTION 'SUZ trade item is not ready' USING ERRCODE = 'MZD03';
  END IF;
  IF p_quantity > trade_record.suz_order_quantity_limit THEN
    RAISE EXCEPTION 'SUZ quantity exceeds local policy' USING ERRCODE = 'MZD04';
  END IF;
  SELECT order_data.id AS order_id, item.id AS order_item_id,
    order_data.revision AS order_revision INTO existing_record
  FROM public.merch_marking_code_order_items AS item
  JOIN public.merch_marking_code_orders AS order_data ON order_data.id = item.code_order_id
  WHERE item.trade_item_id = p_trade_item_id
    AND item.status = ANY (ARRAY['open'::text, 'manual_review'::text])
  ORDER BY order_data.created_at LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT existing_record.order_id, existing_record.order_item_id,
      existing_record.order_revision, true;
    RETURN;
  END IF;
  INSERT INTO public.merch_marking_code_orders (
    contour, production_mode, source, idempotency_key, created_by
  ) VALUES (p_contour, 'own_production', p_source, p_idempotency_key, p_actor_id)
  RETURNING id INTO created_order_id;
  INSERT INTO public.merch_marking_code_order_items (
    code_order_id, trade_item_id, gtin_snapshot, requested_quantity,
    forecast_snapshot
  ) VALUES (
    created_order_id, trade_record.id, trade_record.gtin, p_quantity,
    p_forecast_snapshot
  ) RETURNING id INTO created_item_id;
  RETURN QUERY SELECT created_order_id, created_item_id, 1::bigint, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.approve_suz_order(
  p_order_id uuid, p_expected_revision bigint, p_actor_id text
)
RETURNS TABLE (order_id uuid, order_revision bigint, order_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid SUZ approver' USING ERRCODE = 'MZD05';
  END IF;
  RETURN QUERY UPDATE public.merch_marking_code_orders AS order_data SET
    status = 'approved', approved_by = p_actor_id,
    approved_at = clock_timestamp(), revision = order_data.revision + 1,
    updated_at = clock_timestamp()
  WHERE order_data.id = p_order_id AND order_data.revision = p_expected_revision
    AND order_data.status = 'draft'
  RETURNING order_data.id, order_data.revision, order_data.status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUZ order cannot be approved' USING ERRCODE = 'MZD06';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.cancel_suz_order(
  p_order_id uuid, p_expected_revision bigint, p_reason text, p_actor_id text
)
RETURNS TABLE (order_id uuid, order_revision bigint, order_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 1000
    OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid SUZ cancellation' USING ERRCODE = 'MZD07';
  END IF;
  UPDATE public.merch_marking_code_order_items AS item SET
    status = 'cancelled', error_message = p_reason,
    revision = item.revision + 1, updated_at = clock_timestamp()
  WHERE item.code_order_id = p_order_id AND item.status = 'open'
    AND EXISTS (SELECT 1 FROM public.merch_marking_code_orders AS order_data
      WHERE order_data.id = p_order_id AND order_data.revision = p_expected_revision
        AND order_data.status = ANY (ARRAY['draft'::text, 'approved'::text]));
  RETURN QUERY UPDATE public.merch_marking_code_orders AS order_data SET
    status = 'cancelled', error_message = p_reason,
    revision = order_data.revision + 1, updated_at = clock_timestamp()
  WHERE order_data.id = p_order_id AND order_data.revision = p_expected_revision
    AND order_data.status = ANY (ARRAY['draft'::text, 'approved'::text])
  RETURNING order_data.id, order_data.revision, order_data.status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUZ order cannot be cancelled' USING ERRCODE = 'MZD08';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.get_suz_order_material(p_order_id uuid)
RETURNS TABLE (
  order_id uuid, order_item_id uuid, contour text, order_status text,
  gtin text, requested_quantity integer, external_order_id uuid,
  received_quantity integer, ingested_quantity integer,
  utilised_quantity integer, block_count integer, block_ids uuid[]
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT order_data.id, item.id, order_data.contour, order_data.status,
    item.gtin_snapshot, item.requested_quantity, order_data.external_order_id,
    item.received_quantity, item.ingested_quantity, item.utilised_quantity,
    cardinality(item.block_ids), item.block_ids
  FROM public.merch_marking_code_orders AS order_data
  JOIN public.merch_marking_code_order_items AS item ON item.code_order_id = order_data.id
  WHERE order_data.id = p_order_id
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_suz_submit_started(
  p_order_id uuid, p_request_hash text, p_signature_hash text,
  p_certificate_thumbprint text, p_actor_id text
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE next_revision bigint;
BEGIN
  UPDATE public.merch_marking_code_orders AS order_data SET
    status = 'submitting', request_hash = p_request_hash,
    signature_hash = p_signature_hash,
    certificate_thumbprint = p_certificate_thumbprint,
    submit_started_at = clock_timestamp(),
    revision = order_data.revision + 1, updated_at = clock_timestamp()
  WHERE order_data.id = p_order_id AND order_data.status = 'approved'
    AND p_request_hash ~ '^[0-9a-f]{64}$'
    AND p_signature_hash ~ '^[0-9a-f]{64}$'
    AND p_certificate_thumbprint ~ '^[0-9A-F]{40,128}$'
    AND p_actor_id IS NOT NULL AND length(p_actor_id) BETWEEN 1 AND 200
  RETURNING order_data.revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'SUZ order cannot start submission' USING ERRCODE = 'MZD09';
  END IF;
  RETURN next_revision;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_suz_submitted(
  p_order_id uuid, p_oms_id uuid, p_external_order_id uuid,
  p_expected_completion_time_ms integer, p_response_redacted jsonb
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE next_status text;
BEGIN
  UPDATE public.merch_marking_code_orders AS order_data SET
    status = 'submitted', external_oms_id = p_oms_id,
    external_order_id = p_external_order_id,
    expected_completion_time_ms = p_expected_completion_time_ms,
    response_redacted = p_response_redacted, submitted_at = clock_timestamp(),
    error_code = NULL, error_message = NULL,
    revision = order_data.revision + 1, updated_at = clock_timestamp()
  WHERE order_data.id = p_order_id AND order_data.status = 'submitting'
    AND p_expected_completion_time_ms BETWEEN 0 AND 3600000
    AND jsonb_typeof(p_response_redacted) = 'object'
  RETURNING order_data.status INTO next_status;
  IF next_status IS NULL THEN
    RAISE EXCEPTION 'SUZ submission state conflict' USING ERRCODE = 'MZD10';
  END IF;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_suz_order_status(
  p_order_id uuid, p_remote_order_status text, p_remote_buffer_status text,
  p_remote_available_codes integer, p_response_redacted jsonb
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE next_status text;
BEGIN
  IF p_remote_order_status IS NULL OR length(p_remote_order_status) NOT BETWEEN 1 AND 120
    OR p_remote_buffer_status IS NULL OR length(p_remote_buffer_status) NOT BETWEEN 1 AND 120
    OR p_remote_available_codes < 0 OR jsonb_typeof(p_response_redacted) <> 'object' THEN
    RAISE EXCEPTION 'invalid SUZ order status' USING ERRCODE = 'MZD11';
  END IF;
  next_status := CASE
    WHEN upper(p_remote_order_status) = ANY (ARRAY['REJECTED'::text, 'CANCELLED'::text, 'CLOSED'::text])
      THEN 'rejected'
    WHEN upper(p_remote_order_status) = 'READY'
      AND upper(p_remote_buffer_status) = 'ACTIVE' THEN 'ready'
    ELSE 'submitted'
  END;
  UPDATE public.merch_marking_code_order_items AS item SET
    remote_order_status = p_remote_order_status,
    remote_buffer_status = p_remote_buffer_status,
    remote_available_codes = p_remote_available_codes,
    response_redacted = p_response_redacted,
    status = CASE WHEN next_status = 'rejected' THEN 'rejected' ELSE item.status END,
    revision = item.revision + 1, updated_at = clock_timestamp()
  WHERE item.code_order_id = p_order_id AND item.status = 'open';
  UPDATE public.merch_marking_code_orders AS order_data SET
    status = next_status, last_polled_at = clock_timestamp(),
    response_redacted = p_response_redacted,
    revision = order_data.revision + 1, updated_at = clock_timestamp()
  WHERE order_data.id = p_order_id
    AND order_data.status = ANY (ARRAY['submitted'::text, 'ready'::text])
    AND order_data.external_order_id IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUZ poll state conflict' USING ERRCODE = 'MZD12';
  END IF;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.attach_suz_code_block(
  p_order_item_id uuid, p_import_batch_id uuid, p_block_id uuid,
  p_received integer, p_applied integer, p_duplicate integer,
  p_rejected integer, p_actor_id text
)
RETURNS TABLE (order_status text, received_quantity integer,
  ingested_quantity integer, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_item public.merch_marking_code_order_items%ROWTYPE;
DECLARE next_order_status text;
BEGIN
  IF p_received < 1 OR p_applied < 0 OR p_duplicate < 0 OR p_rejected < 0
    OR p_applied + p_duplicate + p_rejected <> p_received
    OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid SUZ code block' USING ERRCODE = 'MZD13';
  END IF;
  SELECT item.* INTO current_item FROM public.merch_marking_code_order_items AS item
  WHERE item.id = p_order_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUZ order item not found' USING ERRCODE = 'MZD14'; END IF;
  IF p_block_id = ANY (current_item.block_ids) THEN
    SELECT order_data.status INTO next_order_status
    FROM public.merch_marking_code_orders AS order_data
    WHERE order_data.id = current_item.code_order_id;
    RETURN QUERY SELECT next_order_status, current_item.received_quantity,
      current_item.ingested_quantity, true;
    RETURN;
  END IF;
  IF current_item.status <> 'open'
    OR current_item.received_quantity + p_received > current_item.requested_quantity THEN
    RAISE EXCEPTION 'SUZ block quantity conflict' USING ERRCODE = 'MZD15';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.merch_marking_import_batches AS batch
    WHERE batch.id = p_import_batch_id AND batch.status = 'applied'
      AND batch.trade_item_id = current_item.trade_item_id
      AND batch.expected_gtin = current_item.gtin_snapshot
      AND batch.source = 'suz_api') THEN
    RAISE EXCEPTION 'SUZ secure import not found' USING ERRCODE = 'MZD16';
  END IF;
  UPDATE public.merch_marking_codes AS code SET
    code_order_item_id = current_item.id, pool_state = 'pending_utilisation',
    blocked_reason = NULL, revision = code.revision + 1,
    updated_at = clock_timestamp()
  WHERE code.import_batch_id = p_import_batch_id
    AND code.code_order_item_id IS NULL AND code.pool_state = 'available';
  IF (SELECT count(*) FROM public.merch_marking_codes AS code
      WHERE code.import_batch_id = p_import_batch_id
        AND code.code_order_item_id = current_item.id
        AND code.pool_state = 'pending_utilisation') <> p_applied THEN
    RAISE EXCEPTION 'SUZ imported code count mismatch' USING ERRCODE = 'MZD17';
  END IF;
  UPDATE public.merch_marking_code_order_items AS item SET
    received_quantity = item.received_quantity + p_received,
    ingested_quantity = item.ingested_quantity + p_applied,
    duplicate_quantity = item.duplicate_quantity + p_duplicate,
    rejected_quantity = item.rejected_quantity + p_rejected,
    block_ids = array_append(item.block_ids, p_block_id),
    import_batch_ids = array_append(item.import_batch_ids, p_import_batch_id),
    revision = item.revision + 1, updated_at = clock_timestamp()
  WHERE item.id = current_item.id
  RETURNING item.received_quantity, item.ingested_quantity
  INTO current_item.received_quantity, current_item.ingested_quantity;
  next_order_status := CASE WHEN current_item.received_quantity = current_item.requested_quantity
    THEN 'awaiting_utilisation' ELSE 'receiving' END;
  UPDATE public.merch_marking_code_orders AS order_data SET
    status = next_order_status, revision = order_data.revision + 1,
    updated_at = clock_timestamp()
  WHERE order_data.id = current_item.code_order_id
    AND order_data.status = ANY (ARRAY['ready'::text, 'receiving'::text]);
  RETURN QUERY SELECT next_order_status, current_item.received_quantity,
    current_item.ingested_quantity, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.confirm_suz_utilisation(
  p_order_id uuid, p_receipt_id uuid, p_state text, p_code integer,
  p_processed integer, p_total integer, p_response_redacted jsonb
)
RETURNS TABLE (order_status text, released_quantity integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE target_item public.merch_marking_code_order_items%ROWTYPE;
DECLARE release_count integer := 0;
DECLARE next_status text;
BEGIN
  SELECT item.* INTO target_item FROM public.merch_marking_code_order_items AS item
  WHERE item.code_order_id = p_order_id FOR UPDATE;
  IF NOT FOUND OR p_state IS NULL OR length(p_state) NOT BETWEEN 1 AND 120
    OR p_processed < 0 OR p_total < 0 OR jsonb_typeof(p_response_redacted) <> 'object' THEN
    RAISE EXCEPTION 'invalid SUZ utilisation receipt' USING ERRCODE = 'MZD18';
  END IF;
  IF target_item.utilisation_receipt_id = p_receipt_id
    AND target_item.status = 'completed' THEN
    RETURN QUERY SELECT 'completed'::text, target_item.available_quantity;
    RETURN;
  END IF;
  IF target_item.status <> 'open' THEN
    RAISE EXCEPTION 'SUZ utilisation state conflict' USING ERRCODE = 'MZD19';
  END IF;
  IF upper(p_state) = 'SUCCESS' AND p_code = 0
    AND p_processed = target_item.requested_quantity
    AND p_total = target_item.requested_quantity
    AND target_item.received_quantity = target_item.requested_quantity
    AND target_item.ingested_quantity = target_item.requested_quantity
    AND target_item.duplicate_quantity = 0 AND target_item.rejected_quantity = 0 THEN
    UPDATE public.merch_marking_codes AS code SET
      pool_state = 'available', revision = code.revision + 1,
      updated_at = clock_timestamp()
    WHERE code.code_order_item_id = target_item.id
      AND code.pool_state = 'pending_utilisation';
    GET DIAGNOSTICS release_count = ROW_COUNT;
    IF release_count <> target_item.requested_quantity THEN
      RAISE EXCEPTION 'SUZ secure pool quantity mismatch' USING ERRCODE = 'MZD20';
    END IF;
    next_status := 'completed';
  ELSE
    next_status := 'manual_review';
  END IF;
  UPDATE public.merch_marking_code_order_items AS item SET
    status = next_status, utilised_quantity = p_processed,
    available_quantity = release_count,
    utilisation_receipt_id = p_receipt_id,
    utilisation_state = p_state, utilisation_code = p_code,
    response_redacted = p_response_redacted,
    error_code = CASE WHEN next_status = 'manual_review' THEN 'quantity_mismatch' END,
    error_message = CASE WHEN next_status = 'manual_review'
      THEN 'SUZ receipt quantity does not match the secure pool' END,
    revision = item.revision + 1, updated_at = clock_timestamp()
  WHERE item.id = target_item.id;
  UPDATE public.merch_marking_code_orders AS order_data SET
    status = next_status, utilisation_checked_at = clock_timestamp(),
    completed_at = CASE WHEN next_status = 'completed' THEN clock_timestamp() END,
    manual_review_reason = CASE WHEN next_status = 'manual_review'
      THEN 'SUZ REPORT_UTILIZE quantity mismatch' END,
    response_redacted = p_response_redacted,
    revision = order_data.revision + 1, updated_at = clock_timestamp()
  WHERE order_data.id = p_order_id
    AND order_data.status = 'awaiting_utilisation';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUZ order is not awaiting utilisation' USING ERRCODE = 'MZD21';
  END IF;
  RETURN QUERY SELECT next_status, release_count;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_suz_order_manual_review(
  p_order_id uuid, p_error_code text, p_error_message text, p_reason text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_error_code IS NULL OR length(p_error_code) NOT BETWEEN 1 AND 120
    OR p_error_message IS NULL OR length(p_error_message) NOT BETWEEN 1 AND 1000
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid SUZ manual review' USING ERRCODE = 'MZD22';
  END IF;
  UPDATE public.merch_marking_code_order_items AS item SET
    status = 'manual_review', error_code = p_error_code,
    error_message = p_error_message, revision = item.revision + 1,
    updated_at = clock_timestamp()
  WHERE item.code_order_id = p_order_id AND item.status = 'open';
  UPDATE public.merch_marking_code_orders AS order_data SET
    status = 'manual_review', error_code = p_error_code,
    error_message = p_error_message, manual_review_reason = p_reason,
    revision = order_data.revision + 1, updated_at = clock_timestamp()
  WHERE order_data.id = p_order_id
    AND order_data.status <> ALL (ARRAY['completed'::text, 'cancelled'::text]);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUZ order cannot enter manual review' USING ERRCODE = 'MZD23';
  END IF;
  RETURN 'manual_review';
END
$function$;

REVOKE ALL ON public.merch_marking_code_orders,
  public.merch_marking_code_order_items FROM PUBLIC, getomerch_app;
GRANT SELECT ON public.merch_marking_code_orders,
  public.merch_marking_code_order_items TO getomerch_backup;
REVOKE ALL ON getomerch_marking.suz_pool_forecast_safe,
  getomerch_marking.suz_code_order_safe FROM PUBLIC;
GRANT SELECT ON getomerch_marking.suz_pool_forecast_safe,
  getomerch_marking.suz_code_order_safe TO getomerch_app, getomerch_backup;

REVOKE ALL ON FUNCTION getomerch_marking.update_suz_pool_policy(
  uuid,bigint,boolean,integer,integer,integer,integer,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.create_suz_order_draft(
  uuid,integer,text,text,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.approve_suz_order(uuid,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.cancel_suz_order(uuid,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_suz_order_material(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_suz_submit_started(
  uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_suz_submitted(
  uuid,uuid,uuid,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_suz_order_status(
  uuid,text,text,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.attach_suz_code_block(
  uuid,uuid,uuid,integer,integer,integer,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.confirm_suz_utilisation(
  uuid,uuid,text,integer,integer,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_suz_order_manual_review(
  uuid,text,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.update_suz_pool_policy(
  uuid,bigint,boolean,integer,integer,integer,integer,integer,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.create_suz_order_draft(
  uuid,integer,text,text,text,jsonb,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.approve_suz_order(uuid,bigint,text)
  TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.cancel_suz_order(uuid,bigint,text,text)
  TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.get_suz_order_material(uuid)
  TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_suz_submit_started(
  uuid,text,text,text,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_suz_submitted(
  uuid,uuid,uuid,integer,jsonb) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_suz_order_status(
  uuid,text,text,integer,jsonb) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.attach_suz_code_block(
  uuid,uuid,uuid,integer,integer,integer,integer,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.confirm_suz_utilisation(
  uuid,uuid,text,integer,integer,integer,jsonb) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_suz_order_manual_review(
  uuid,text,text,text) TO getomerch_app;

COMMENT ON VIEW getomerch_marking.suz_pool_forecast_safe IS
  'Stage 13 per-GTIN forecast without marking-code material.';
COMMENT ON VIEW getomerch_marking.suz_code_order_safe IS
  'Stage 13 SUZ order lifecycle without tokens, signatures, or full codes.';
