-- Stage 8: revisioned Ozon FBS exemplar submissions. Full marking codes remain
-- encrypted in merch_marking_codes and are exposed only through one narrow
-- worker function; batches, jobs, views and responses contain redacted data.

CREATE TABLE public.merch_marking_ozon_submission_batches (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fulfillment_order_id uuid NOT NULL
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
    posting_number text NOT NULL,
    posting_snapshot_hash text NOT NULL,
    request_revision integer NOT NULL,
    supersedes_batch_id uuid
      REFERENCES public.merch_marking_ozon_submission_batches(id) ON DELETE RESTRICT,
    operation_kind text DEFAULT 'initial_set'::text NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    external_task_id text,
    request_hash text NOT NULL,
    request_payload_envelope bytea,
    api_contract_version text DEFAULT 'ozon-exemplar-2026-07-26'::text NOT NULL,
    response_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    multi_box_quantity integer DEFAULT 0 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    submitted_at timestamp with time zone,
    checked_at timestamp with time zone,
    accepted_at timestamp with time zone,
    rejected_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_ozon_batches_order_unique
      UNIQUE (id, fulfillment_order_id),
    CONSTRAINT merch_marking_ozon_batches_revision_unique
      UNIQUE (posting_number, request_revision),
    CONSTRAINT merch_marking_ozon_batches_posting_check
      CHECK (length(posting_number) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_ozon_batches_snapshot_check
      CHECK (posting_snapshot_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_ozon_batches_request_hash_check
      CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_ozon_batches_revision_check
      CHECK (request_revision >= 1),
    CONSTRAINT merch_marking_ozon_batches_operation_check
      CHECK (operation_kind = ANY (ARRAY['initial_set'::text, 'correction'::text])),
    CONSTRAINT merch_marking_ozon_batches_status_check
      CHECK (
        status = ANY (
          ARRAY['prepared'::text, 'validating'::text,
                'validation_failed'::text, 'validated'::text,
                'submitting'::text, 'polling'::text, 'accepted'::text,
                'partially_rejected'::text, 'rejected'::text,
                'timed_out'::text, 'manual_review'::text,
                'superseded'::text]
        )
      ),
    CONSTRAINT merch_marking_ozon_batches_task_check
      CHECK (external_task_id IS NULL OR length(external_task_id) BETWEEN 1 AND 500),
    CONSTRAINT merch_marking_ozon_batches_payload_check
      CHECK (request_payload_envelope IS NULL),
    CONSTRAINT merch_marking_ozon_batches_contract_check
      CHECK (length(api_contract_version) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_ozon_batches_response_check
      CHECK (
        jsonb_typeof(response_redacted) = 'object'
        AND octet_length(response_redacted::text) <= 32768
      ),
    CONSTRAINT merch_marking_ozon_batches_multi_box_check
      CHECK (multi_box_quantity >= 0),
    CONSTRAINT merch_marking_ozon_batches_attempt_check CHECK (attempt_count >= 0),
    CONSTRAINT merch_marking_ozon_batches_actor_check
      CHECK (length(created_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_ozon_batches_terminal_check
      CHECK (
        (status = 'accepted' AND accepted_at IS NOT NULL AND rejected_at IS NULL)
        OR (
          status = ANY (ARRAY['partially_rejected'::text, 'rejected'::text])
          AND rejected_at IS NOT NULL
          AND accepted_at IS NULL
        )
        OR (status = 'superseded' AND NOT (
          accepted_at IS NOT NULL AND rejected_at IS NOT NULL
        ))
        OR (
          status <> ALL (
            ARRAY['accepted'::text, 'partially_rejected'::text,
                  'rejected'::text, 'superseded'::text]
          )
          AND accepted_at IS NULL
          AND rejected_at IS NULL
        )
      )
);

CREATE UNIQUE INDEX merch_marking_ozon_batches_live_snapshot
  ON public.merch_marking_ozon_submission_batches (
    fulfillment_order_id,
    posting_snapshot_hash
  )
  WHERE status <> 'superseded';
CREATE INDEX merch_marking_ozon_batches_status_updated
  ON public.merch_marking_ozon_submission_batches (status, updated_at DESC, id DESC);

CREATE TABLE public.merch_marking_ozon_submissions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    batch_id uuid NOT NULL
      REFERENCES public.merch_marking_ozon_submission_batches(id) ON DELETE RESTRICT,
    assignment_id uuid NOT NULL
      REFERENCES public.merch_marking_assignments(id) ON DELETE RESTRICT,
    assignment_revision bigint NOT NULL,
    ozon_product_id bigint NOT NULL,
    exemplar_id bigint,
    status text DEFAULT 'prepared'::text NOT NULL,
    error_codes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    error_message text,
    response_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_ozon_submissions_batch_assignment_unique
      UNIQUE (batch_id, assignment_id),
    CONSTRAINT merch_marking_ozon_submissions_revision_check
      CHECK (assignment_revision >= 1),
    CONSTRAINT merch_marking_ozon_submissions_product_check
      CHECK (ozon_product_id > 0),
    CONSTRAINT merch_marking_ozon_submissions_exemplar_check
      CHECK (exemplar_id IS NULL OR exemplar_id > 0),
    CONSTRAINT merch_marking_ozon_submissions_status_check
      CHECK (
        status = ANY (
          ARRAY['prepared'::text, 'validating'::text,
                'validation_rejected'::text, 'validated'::text,
                'submitting'::text, 'polling'::text, 'accepted'::text,
                'rejected'::text, 'manual_review'::text,
                'superseded'::text]
        )
      ),
    CONSTRAINT merch_marking_ozon_submissions_errors_check
      CHECK (
        cardinality(error_codes) <= 100
        AND octet_length(array_to_string(error_codes, ',')) <= 10000
      ),
    CONSTRAINT merch_marking_ozon_submissions_message_check
      CHECK (error_message IS NULL OR length(error_message) <= 1000),
    CONSTRAINT merch_marking_ozon_submissions_response_check
      CHECK (
        jsonb_typeof(response_redacted) = 'object'
        AND octet_length(response_redacted::text) <= 16384
      )
);

CREATE UNIQUE INDEX merch_marking_ozon_submissions_batch_exemplar
  ON public.merch_marking_ozon_submissions (batch_id, exemplar_id)
  WHERE exemplar_id IS NOT NULL;
CREATE INDEX merch_marking_ozon_submissions_assignment_history
  ON public.merch_marking_ozon_submissions (assignment_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION getomerch_marking.prepare_ozon_submission_batch(
  p_fulfillment_order_id uuid,
  p_actor_id text,
  p_force_correction boolean DEFAULT false
)
RETURNS TABLE (
  batch_id uuid,
  request_revision integer,
  batch_status text,
  posting_number text,
  posting_snapshot_hash text,
  reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  order_record record;
  required_quantity integer;
  assignment_count integer;
  snapshot_hash text;
  existing_record record;
  previous_record record;
  next_revision integer;
  created_batch_id uuid;
  operation text := CASE WHEN p_force_correction THEN 'correction' ELSE 'initial_set' END;
BEGIN
  IF p_fulfillment_order_id IS NULL
     OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Ozon batch parameters' USING ERRCODE = 'MZ800';
  END IF;

  SELECT fulfillment_order.* INTO order_record
  FROM public.merch_fulfillment_orders AS fulfillment_order
  WHERE fulfillment_order.id = p_fulfillment_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment order not found' USING ERRCODE = 'MZ801';
  END IF;
  IF order_record.source_channel <> 'ozon_fbs'
     OR order_record.fulfillment_scheme <> 'fbs'
     OR order_record.external_posting_number IS NULL THEN
    RAISE EXCEPTION 'order does not support Ozon exemplars' USING ERRCODE = 'MZ802';
  END IF;
  IF order_record.source_status = ANY (
    ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
          'sent_by_seller'::text, 'arbitration'::text,
          'client_arbitration'::text, 'not_accepted'::text,
          'cancelled'::text]
  ) THEN
    RAISE EXCEPTION 'Ozon posting is no longer editable' USING ERRCODE = 'MZ803';
  END IF;

  SELECT coalesce(sum(item.quantity), 0)::integer INTO required_quantity
  FROM public.merch_fulfillment_order_items AS item
  WHERE item.fulfillment_order_id = order_record.id
    AND item.source_active
    AND item.marking_requirement = 'required';
  IF required_quantity < 1 THEN
    RAISE EXCEPTION 'posting has no mandatory marking items' USING ERRCODE = 'MZ804';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.merch_fulfillment_order_items AS item
    WHERE item.fulfillment_order_id = order_record.id
      AND item.source_active
      AND item.marking_requirement = 'required'
      AND (
        item.exemplar_flow_available IS DISTINCT FROM true
        OR item.external_product_id IS NULL
        OR item.external_product_id !~ '^[1-9][0-9]{0,14}$'
      )
  ) THEN
    RAISE EXCEPTION 'posting product exemplar metadata is incomplete'
      USING ERRCODE = 'MZ805';
  END IF;

  SELECT count(*)::integer INTO assignment_count
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  WHERE item.fulfillment_order_id = order_record.id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND assignment.status = 'active'
    AND assignment.unit_ordinal <= item.quantity
    AND binding.status = 'active'
    AND binding.label_state = 'applied';
  IF assignment_count <> required_quantity THEN
    RAISE EXCEPTION 'assignment quantity does not match Ozon posting quantity'
      USING ERRCODE = 'MZ806';
  END IF;

  SELECT encode(
    sha256(convert_to(
      string_agg(
        item.external_product_id || ':' || assignment.id::text || ':'
          || assignment.revision::text || ':' || assignment.unit_ordinal::text,
        '|' ORDER BY item.external_product_id::numeric,
          assignment.unit_ordinal, assignment.id
      ),
      'UTF8'
    )),
    'hex'
  ) INTO snapshot_hash
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  WHERE item.fulfillment_order_id = order_record.id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND assignment.status = 'active';

  SELECT batch.* INTO existing_record
  FROM public.merch_marking_ozon_submission_batches AS batch
  WHERE batch.fulfillment_order_id = order_record.id
    AND batch.posting_snapshot_hash = snapshot_hash
    AND batch.status <> 'superseded'
  ORDER BY batch.request_revision DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND AND NOT p_force_correction THEN
    RETURN QUERY SELECT existing_record.id, existing_record.request_revision,
      existing_record.status, existing_record.posting_number,
      existing_record.posting_snapshot_hash, true;
    RETURN;
  END IF;

  SELECT batch.* INTO previous_record
  FROM public.merch_marking_ozon_submission_batches AS batch
  WHERE batch.fulfillment_order_id = order_record.id
    AND batch.status <> 'superseded'
  ORDER BY batch.request_revision DESC
  LIMIT 1
  FOR UPDATE;
  SELECT coalesce(max(batch.request_revision), 0) + 1 INTO next_revision
  FROM public.merch_marking_ozon_submission_batches AS batch
  WHERE batch.posting_number = order_record.external_posting_number;

  IF previous_record.id IS NOT NULL THEN
    UPDATE public.merch_marking_ozon_submission_batches
    SET status = 'superseded', updated_at = clock_timestamp()
    WHERE id = previous_record.id;
  END IF;

  INSERT INTO public.merch_marking_ozon_submission_batches (
    fulfillment_order_id, posting_number, posting_snapshot_hash,
    request_revision, supersedes_batch_id, operation_kind, status,
    request_hash, created_by
  ) VALUES (
    order_record.id, order_record.external_posting_number, snapshot_hash,
    next_revision, previous_record.id, operation, 'prepared', snapshot_hash,
    p_actor_id
  ) RETURNING id INTO created_batch_id;

  INSERT INTO public.merch_marking_ozon_submissions (
    batch_id, assignment_id, assignment_revision, ozon_product_id
  )
  SELECT created_batch_id, assignment.id, assignment.revision,
    item.external_product_id::bigint
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  WHERE item.fulfillment_order_id = order_record.id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND assignment.status = 'active'
  ORDER BY item.external_product_id::numeric, assignment.unit_ordinal, assignment.id;

  INSERT INTO public.merch_marking_events (
    marking_code_id, marking_unit_id, code_binding_id, assignment_id,
    process_id, product_profile_id, event_type, actor_type, actor_id, source,
    details_redacted, occurred_at
  )
  SELECT binding.marking_code_id, assignment.marking_unit_id,
    assignment.code_binding_id, assignment.id, process.id,
    assignment.product_profile_id, 'ozon_batch_prepared', 'admin', p_actor_id,
    'admin_marking_ozon',
    jsonb_build_object('batchId', created_batch_id, 'revision', next_revision),
    clock_timestamp()
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_ozon_submissions AS submission
    ON submission.assignment_id = assignment.id
   AND submission.batch_id = created_batch_id
  LEFT JOIN LATERAL (
    SELECT candidate.id
    FROM public.merch_marking_processes AS candidate
    WHERE candidate.assignment_id = assignment.id
    ORDER BY candidate.created_at DESC, candidate.id DESC
    LIMIT 1
  ) AS process ON true;

  RETURN QUERY SELECT created_batch_id, next_revision, 'prepared'::text,
    order_record.external_posting_number::text, snapshot_hash, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_ozon_exemplar_mapping(
  p_batch_id uuid,
  p_mapping jsonb,
  p_multi_box_quantity integer,
  p_response_redacted jsonb,
  p_actor_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_count integer;
  mapping_count integer;
BEGIN
  IF p_batch_id IS NULL OR jsonb_typeof(p_mapping) <> 'array'
     OR p_multi_box_quantity IS NULL OR p_multi_box_quantity < 0
     OR jsonb_typeof(p_response_redacted) <> 'object'
     OR octet_length(p_response_redacted::text) > 32768
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Ozon exemplar mapping' USING ERRCODE = 'MZ810';
  END IF;
  PERFORM 1 FROM public.merch_marking_ozon_submission_batches
  WHERE id = p_batch_id AND status = ANY (
    ARRAY['prepared'::text, 'validation_failed'::text, 'validating'::text]
  ) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ozon batch is not mappable' USING ERRCODE = 'MZ811';
  END IF;
  SELECT count(*)::integer INTO expected_count
  FROM public.merch_marking_ozon_submissions WHERE batch_id = p_batch_id;
  SELECT count(*)::integer INTO mapping_count
  FROM jsonb_to_recordset(p_mapping) AS value(assignment_id uuid, exemplar_id bigint)
  WHERE value.assignment_id IS NOT NULL AND value.exemplar_id > 0;
  IF mapping_count <> expected_count
     OR EXISTS (
       SELECT value.assignment_id
       FROM jsonb_to_recordset(p_mapping) AS value(assignment_id uuid, exemplar_id bigint)
       GROUP BY value.assignment_id HAVING count(*) <> 1
     )
     OR EXISTS (
       SELECT value.exemplar_id
       FROM jsonb_to_recordset(p_mapping) AS value(assignment_id uuid, exemplar_id bigint)
       GROUP BY value.exemplar_id HAVING count(*) <> 1
     ) THEN
    RAISE EXCEPTION 'Ozon exemplar count or uniqueness mismatch'
      USING ERRCODE = 'MZ812';
  END IF;
  UPDATE public.merch_marking_ozon_submissions AS submission
  SET exemplar_id = mapping.exemplar_id,
      status = 'validating', error_codes = ARRAY[]::text[],
      error_message = NULL, response_redacted = '{}'::jsonb,
      updated_at = clock_timestamp()
  FROM jsonb_to_recordset(p_mapping) AS mapping(assignment_id uuid, exemplar_id bigint)
  WHERE submission.batch_id = p_batch_id
    AND submission.assignment_id = mapping.assignment_id;
  IF NOT FOUND OR (
    SELECT count(*) FROM public.merch_marking_ozon_submissions
    WHERE batch_id = p_batch_id AND exemplar_id IS NOT NULL
  ) <> expected_count THEN
    RAISE EXCEPTION 'Ozon mapping contains unknown assignment'
      USING ERRCODE = 'MZ812';
  END IF;
  UPDATE public.merch_marking_ozon_submission_batches
  SET status = 'validating', response_redacted = p_response_redacted,
      multi_box_quantity = p_multi_box_quantity,
      attempt_count = attempt_count + 1, checked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = p_batch_id;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.get_ozon_submission_material(
  p_batch_id uuid,
  p_operation text,
  p_actor_id text
)
RETURNS TABLE (
  posting_number text,
  operation_kind text,
  assignment_id uuid,
  assignment_revision bigint,
  ozon_product_id bigint,
  exemplar_id bigint,
  unit_ordinal integer,
  encryption_key_version integer,
  code_ciphertext bytea,
  code_nonce bytea,
  code_auth_tag bytea,
  code_fingerprint text,
  gtin text,
  offer_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  batch_record record;
BEGIN
  IF p_batch_id IS NULL OR p_operation <> ALL (ARRAY['validate'::text, 'set'::text])
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Ozon material request' USING ERRCODE = 'MZ820';
  END IF;
  SELECT batch.* INTO batch_record
  FROM public.merch_marking_ozon_submission_batches AS batch
  JOIN public.merch_fulfillment_orders AS fulfillment_order
    ON fulfillment_order.id = batch.fulfillment_order_id
  WHERE batch.id = p_batch_id
    AND fulfillment_order.source_status <> ALL (
      ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
            'sent_by_seller'::text, 'arbitration'::text,
            'client_arbitration'::text, 'not_accepted'::text,
            'cancelled'::text]
    )
  FOR UPDATE OF batch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ozon batch is unavailable' USING ERRCODE = 'MZ821';
  END IF;
  IF (p_operation = 'validate' AND batch_record.status <> 'validating')
     OR (p_operation = 'set' AND batch_record.status <> 'validated') THEN
    RAISE EXCEPTION 'Ozon batch state does not allow operation'
      USING ERRCODE = 'MZ822';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.merch_marking_ozon_submissions AS submission
    JOIN public.merch_marking_assignments AS assignment
      ON assignment.id = submission.assignment_id
    JOIN public.merch_marking_code_bindings AS binding
      ON binding.id = assignment.code_binding_id
    JOIN public.merch_marking_codes AS code
      ON code.id = binding.marking_code_id
    WHERE submission.batch_id = p_batch_id
      AND (
        assignment.status <> 'active'
        OR assignment.revision <> submission.assignment_revision
        OR binding.status <> 'active'
        OR binding.label_state <> 'applied'
        OR code.pool_state <> 'bound'
        OR code.crpt_state = ANY (ARRAY['withdrawn'::text, 'invalid'::text])
        OR (
          p_operation = 'set'
          AND code.crpt_state <> ALL (
            ARRAY['introduced'::text, 'in_circulation'::text]
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'assignment changed or is not ready for Ozon'
      USING ERRCODE = 'MZ823';
  END IF;
  IF p_operation = 'set' THEN
    UPDATE public.merch_marking_ozon_submission_batches
    SET status = 'submitting', attempt_count = attempt_count + 1,
        updated_at = clock_timestamp()
    WHERE id = p_batch_id;
    UPDATE public.merch_marking_ozon_submissions
    SET status = 'submitting', updated_at = clock_timestamp()
    WHERE batch_id = p_batch_id AND status = 'validated';
  END IF;
  RETURN QUERY
  SELECT batch_record.posting_number::text, batch_record.operation_kind::text,
    assignment.id, assignment.revision, submission.ozon_product_id,
    submission.exemplar_id, assignment.unit_ordinal,
    code.encryption_key_version, code.code_ciphertext, code.code_nonce,
    code.code_auth_tag, code.fingerprint, code.gtin_snapshot, item.offer_id
  FROM public.merch_marking_ozon_submissions AS submission
  JOIN public.merch_marking_assignments AS assignment
    ON assignment.id = submission.assignment_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_codes AS code
    ON code.id = binding.marking_code_id
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  WHERE submission.batch_id = p_batch_id
  ORDER BY submission.ozon_product_id, assignment.unit_ordinal, assignment.id;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_ozon_validation(
  p_batch_id uuid,
  p_results jsonb,
  p_response_redacted jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_count integer;
  valid_count integer;
  next_status text;
BEGIN
  IF jsonb_typeof(p_results) <> 'array'
     OR jsonb_typeof(p_response_redacted) <> 'object'
     OR octet_length(p_response_redacted::text) > 32768 THEN
    RAISE EXCEPTION 'invalid Ozon validation result' USING ERRCODE = 'MZ830';
  END IF;
  PERFORM 1 FROM public.merch_marking_ozon_submission_batches
  WHERE id = p_batch_id AND status = 'validating' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ozon batch is not validating' USING ERRCODE = 'MZ831';
  END IF;
  SELECT count(*)::integer INTO expected_count
  FROM public.merch_marking_ozon_submissions WHERE batch_id = p_batch_id;
  IF (SELECT count(*) FROM jsonb_to_recordset(p_results)
      AS result(assignment_id uuid, valid boolean, error_codes text[], error_message text))
      <> expected_count THEN
    RAISE EXCEPTION 'Ozon validation result count mismatch' USING ERRCODE = 'MZ832';
  END IF;
  UPDATE public.merch_marking_ozon_submissions AS submission
  SET status = CASE WHEN result.valid THEN 'validated' ELSE 'validation_rejected' END,
      error_codes = coalesce(result.error_codes, ARRAY[]::text[]),
      error_message = left(nullif(result.error_message, ''), 1000),
      response_redacted = jsonb_build_object('valid', result.valid),
      updated_at = clock_timestamp()
  FROM jsonb_to_recordset(p_results)
    AS result(assignment_id uuid, valid boolean, error_codes text[], error_message text)
  WHERE submission.batch_id = p_batch_id
    AND submission.assignment_id = result.assignment_id;
  IF (
    SELECT count(*)
    FROM public.merch_marking_ozon_submissions
    WHERE batch_id = p_batch_id
      AND status = ANY (
        ARRAY['validated'::text, 'validation_rejected'::text]
      )
  ) <> expected_count THEN
    RAISE EXCEPTION 'Ozon validation contains unknown or duplicate assignment'
      USING ERRCODE = 'MZ832';
  END IF;
  SELECT count(*)::integer INTO valid_count
  FROM public.merch_marking_ozon_submissions
  WHERE batch_id = p_batch_id AND status = 'validated';
  next_status := CASE WHEN valid_count = expected_count THEN 'validated'
    ELSE 'validation_failed' END;
  UPDATE public.merch_marking_ozon_submission_batches
  SET status = next_status, response_redacted = p_response_redacted,
      checked_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_batch_id;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_ozon_set_queued_for_poll(
  p_batch_id uuid,
  p_request_hash text,
  p_response_redacted jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_response_redacted) <> 'object' THEN
    RAISE EXCEPTION 'invalid Ozon set result' USING ERRCODE = 'MZ840';
  END IF;
  UPDATE public.merch_marking_ozon_submission_batches
  SET status = 'polling', request_hash = p_request_hash,
      response_redacted = p_response_redacted, submitted_at = clock_timestamp(),
      checked_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_batch_id AND status = 'submitting';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ozon batch is not submitting' USING ERRCODE = 'MZ841';
  END IF;
  UPDATE public.merch_marking_ozon_submissions
  SET status = 'polling', updated_at = clock_timestamp()
  WHERE batch_id = p_batch_id AND status = 'submitting';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_ozon_poll(
  p_batch_id uuid,
  p_remote_status text,
  p_results jsonb,
  p_response_redacted jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  next_status text;
  rejected_count integer;
  total_count integer;
BEGIN
  IF p_remote_status <> ALL (
       ARRAY['validation_in_process'::text, 'ship_available'::text,
             'ship_not_available'::text, 'update_available'::text,
             'update_not_available'::text, 'timeout'::text,
             'unknown'::text]
     ) OR jsonb_typeof(p_results) <> 'array'
     OR jsonb_typeof(p_response_redacted) <> 'object' THEN
    RAISE EXCEPTION 'invalid Ozon poll result' USING ERRCODE = 'MZ850';
  END IF;
  PERFORM 1 FROM public.merch_marking_ozon_submission_batches
  WHERE id = p_batch_id
    AND status = ANY (ARRAY['polling'::text, 'timed_out'::text])
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ozon batch is not polling' USING ERRCODE = 'MZ851';
  END IF;

  IF p_remote_status = 'ship_available' THEN
    SELECT count(*)::integer INTO total_count
    FROM public.merch_marking_ozon_submissions
    WHERE batch_id = p_batch_id;
    IF (SELECT count(*) FROM jsonb_to_recordset(p_results)
        AS result(exemplar_id bigint, error_codes text[], error_message text))
        <> total_count
       OR EXISTS (
         SELECT 1
         FROM public.merch_marking_ozon_submissions AS submission
         WHERE submission.batch_id = p_batch_id
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_to_recordset(p_results)
               AS result(exemplar_id bigint, error_codes text[], error_message text)
             WHERE result.exemplar_id = submission.exemplar_id
           )
       ) THEN
      RAISE EXCEPTION 'Ozon accepted status does not identify every exemplar'
        USING ERRCODE = 'MZ852';
    END IF;
    next_status := 'accepted';
    UPDATE public.merch_marking_ozon_submissions
    SET status = 'accepted', error_codes = ARRAY[]::text[], error_message = NULL,
        updated_at = clock_timestamp()
    WHERE batch_id = p_batch_id;
  ELSIF p_remote_status = 'ship_not_available' THEN
    UPDATE public.merch_marking_ozon_submissions AS submission
    SET status = CASE WHEN cardinality(coalesce(result.error_codes, ARRAY[]::text[])) > 0
                      THEN 'rejected' ELSE 'manual_review' END,
        error_codes = coalesce(result.error_codes, ARRAY[]::text[]),
        error_message = left(nullif(result.error_message, ''), 1000),
        updated_at = clock_timestamp()
    FROM jsonb_to_recordset(p_results)
      AS result(exemplar_id bigint, error_codes text[], error_message text)
    WHERE submission.batch_id = p_batch_id
      AND submission.exemplar_id = result.exemplar_id;
    SELECT count(*)::integer,
      count(*) FILTER (WHERE status = 'rejected')::integer
    INTO total_count, rejected_count
    FROM public.merch_marking_ozon_submissions WHERE batch_id = p_batch_id;
    next_status := CASE WHEN rejected_count = total_count THEN 'rejected'
      ELSE 'partially_rejected' END;
  ELSIF p_remote_status = 'validation_in_process' THEN
    next_status := 'polling';
  ELSIF p_remote_status = 'timeout' THEN
    next_status := 'timed_out';
  ELSE
    next_status := 'manual_review';
    UPDATE public.merch_marking_ozon_submissions
    SET status = 'manual_review', updated_at = clock_timestamp()
    WHERE batch_id = p_batch_id AND status = 'polling';
  END IF;

  UPDATE public.merch_marking_ozon_submission_batches
  SET status = next_status, response_redacted = p_response_redacted,
      checked_at = clock_timestamp(),
      accepted_at = CASE WHEN next_status = 'accepted' THEN clock_timestamp() ELSE NULL END,
      rejected_at = CASE WHEN next_status = ANY (
        ARRAY['partially_rejected'::text, 'rejected'::text]
      ) THEN clock_timestamp() ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE id = p_batch_id;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_ozon_batch_failure(
  p_batch_id uuid,
  p_phase text,
  p_error_code text,
  p_error_message text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  next_status text;
BEGIN
  IF p_phase <> ALL (ARRAY['validate'::text, 'set'::text, 'poll'::text])
     OR p_error_code IS NULL OR length(p_error_code) NOT BETWEEN 2 AND 200
     OR p_error_message IS NULL OR length(p_error_message) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid Ozon batch failure' USING ERRCODE = 'MZ860';
  END IF;
  next_status := CASE WHEN p_phase = 'validate' THEN 'validation_failed'
    ELSE 'manual_review' END;
  UPDATE public.merch_marking_ozon_submission_batches
  SET status = next_status,
      response_redacted = jsonb_build_object(
        'phase', p_phase, 'errorCode', p_error_code,
        'message', left(p_error_message, 1000)
      ),
      checked_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_batch_id
    AND status <> ALL (ARRAY['accepted'::text, 'rejected'::text,
                             'partially_rejected'::text, 'superseded'::text]);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ozon batch cannot record failure' USING ERRCODE = 'MZ861';
  END IF;
  UPDATE public.merch_marking_ozon_submissions
  SET status = CASE WHEN p_phase = 'validate' THEN 'validation_rejected'
                    ELSE 'manual_review' END,
      error_codes = ARRAY[p_error_code],
      error_message = left(p_error_message, 1000),
      updated_at = clock_timestamp()
  WHERE batch_id = p_batch_id AND status <> 'accepted';
  RETURN next_status;
END
$function$;

CREATE VIEW getomerch_marking.ozon_submission_batch_safe
WITH (security_barrier = true)
AS
SELECT batch.id, batch.fulfillment_order_id, batch.posting_number,
  batch.posting_snapshot_hash, batch.request_revision,
  batch.supersedes_batch_id, batch.operation_kind, batch.status,
  batch.external_task_id, batch.request_hash, batch.api_contract_version,
  batch.response_redacted, batch.multi_box_quantity, batch.attempt_count,
  batch.submitted_at,
  batch.checked_at, batch.accepted_at, batch.rejected_at, batch.created_by,
  count(submission.id)::integer AS unit_count,
  count(*) FILTER (WHERE submission.status = 'accepted')::integer AS accepted_count,
  count(*) FILTER (WHERE submission.status IN (
    'validation_rejected', 'rejected', 'manual_review'
  ))::integer AS rejected_count,
  batch.created_at, batch.updated_at
FROM public.merch_marking_ozon_submission_batches AS batch
JOIN public.merch_marking_ozon_submissions AS submission
  ON submission.batch_id = batch.id
GROUP BY batch.id;

CREATE VIEW getomerch_marking.ozon_submission_safe
WITH (security_barrier = true)
AS
SELECT submission.id, submission.batch_id, submission.assignment_id,
  submission.assignment_revision, submission.ozon_product_id,
  submission.exemplar_id, assignment.unit_ordinal, item.fulfillment_order_id,
  item.offer_id, assignment.gtin_snapshot AS gtin,
  code.fingerprint AS code_fingerprint, submission.status,
  submission.error_codes, submission.error_message,
  submission.response_redacted, submission.created_at, submission.updated_at
FROM public.merch_marking_ozon_submissions AS submission
JOIN public.merch_marking_assignments AS assignment
  ON assignment.id = submission.assignment_id
JOIN public.merch_fulfillment_order_items AS item
  ON item.id = assignment.fulfillment_item_id
JOIN public.merch_marking_code_bindings AS binding
  ON binding.id = assignment.code_binding_id
JOIN public.merch_marking_codes AS code
  ON code.id = binding.marking_code_id;

DROP VIEW getomerch_marking.assignment_action_safe;
CREATE VIEW getomerch_marking.assignment_action_safe
WITH (security_barrier = true)
AS
SELECT
  assignment.id,
  assignment.fulfillment_item_id,
  assignment.fulfillment_order_id,
  assignment.source_channel,
  assignment.external_posting_number,
  assignment.source_status,
  assignment.offer_id,
  assignment.product_id,
  assignment.sku,
  assignment.item_quantity,
  assignment.unit_ordinal,
  assignment.product_profile_id,
  assignment.gtin_snapshot,
  assignment.assignment_status,
  assignment.assignment_revision,
  assignment.assigned_by,
  assignment.assigned_at,
  assignment.released_at,
  assignment.release_reason,
  assignment.completed_at,
  assignment.marking_unit_id,
  assignment.internal_serial,
  assignment.unit_state,
  assignment.custody_state,
  assignment.warehouse_id,
  assignment.warehouse_name,
  assignment.code_binding_id,
  assignment.binding_status,
  assignment.label_state,
  assignment.template_version,
  assignment.render_count,
  assignment.print_confirmed_count,
  assignment.marking_code_id,
  assignment.code_fingerprint,
  assignment.code_pool_state,
  assignment.crpt_state,
  assignment.process_id,
  assignment.process_status,
  assignment.current_step,
  assignment.next_action,
  process.last_error_code,
  latest_event.event_type AS last_event_type,
  latest_event.occurred_at AS last_event_at,
  coalesce(latest_ozon.submission_status, 'not_started')::text AS ozon_state,
  (
    assignment.assignment_status = 'active'
    AND assignment.binding_status = ANY (ARRAY['planned'::text, 'active'::text])
    AND assignment.label_state = ANY (
      ARRAY['not_rendered'::text, 'label_rendered'::text,
            'printed'::text, 'applied'::text]
    )
    AND assignment.code_pool_state = ANY (
      ARRAY['reserved'::text, 'bound'::text]
    )
    AND assignment.source_status <> ALL (
      ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
            'sent_by_seller'::text, 'arbitration'::text,
            'client_arbitration'::text, 'not_accepted'::text,
            'cancelled'::text]
    )
  ) AS can_render_label,
  (
    assignment.assignment_status = 'active'
    AND assignment.render_count > 0
    AND assignment.binding_status = ANY (ARRAY['planned'::text, 'active'::text])
    AND assignment.label_state = ANY (
      ARRAY['label_rendered'::text, 'printed'::text, 'applied'::text]
    )
    AND assignment.code_pool_state = ANY (
      ARRAY['reserved'::text, 'bound'::text]
    )
    AND assignment.source_status <> ALL (
      ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
            'sent_by_seller'::text, 'arbitration'::text,
            'client_arbitration'::text, 'not_accepted'::text,
            'cancelled'::text]
    )
  ) AS can_reprint_label,
  (
    assignment.assignment_status = 'active'
    AND assignment.unit_state = 'preparing'
    AND assignment.binding_status = 'planned'
    AND assignment.label_state = ANY (
      ARRAY['label_rendered'::text, 'printed'::text]
    )
    AND assignment.code_pool_state = 'reserved'
    AND assignment.source_status <> ALL (
      ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
            'sent_by_seller'::text, 'arbitration'::text,
            'client_arbitration'::text, 'not_accepted'::text,
            'cancelled'::text]
    )
  ) AS can_confirm_applied,
  (
    assignment.assignment_status = 'active'
    AND assignment.unit_state = 'preparing'
    AND assignment.binding_status = 'planned'
    AND assignment.label_state <> 'applied'
  ) AS can_cancel,
  (
    assignment.assignment_status = 'active'
    AND assignment.source_channel = 'ozon_fbs'
    AND assignment.label_state = 'applied'
    AND assignment.binding_status = 'active'
    AND assignment.code_pool_state = 'bound'
    AND assignment.source_status <> ALL (
      ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
            'sent_by_seller'::text, 'arbitration'::text,
            'client_arbitration'::text, 'not_accepted'::text,
            'cancelled'::text]
    )
    AND coalesce(latest_ozon.submission_status, 'not_started') = ANY (
      ARRAY['not_started'::text, 'validation_rejected'::text]
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.merch_fulfillment_order_items AS order_item
      WHERE order_item.fulfillment_order_id = assignment.fulfillment_order_id
        AND order_item.source_active
        AND order_item.marking_requirement = 'required'
        AND (
          order_item.exemplar_flow_available IS DISTINCT FROM true
          OR order_item.external_product_id IS NULL
          OR order_item.external_product_id !~ '^[1-9][0-9]{0,14}$'
        )
    )
    AND (
      SELECT count(*)
      FROM public.merch_marking_assignments AS order_assignment
      JOIN public.merch_fulfillment_order_items AS order_item
        ON order_item.id = order_assignment.fulfillment_item_id
      JOIN public.merch_marking_code_bindings AS order_binding
        ON order_binding.id = order_assignment.code_binding_id
      WHERE order_item.fulfillment_order_id = assignment.fulfillment_order_id
        AND order_item.source_active
        AND order_item.marking_requirement = 'required'
        AND order_assignment.status = 'active'
        AND order_assignment.unit_ordinal <= order_item.quantity
        AND order_binding.status = 'active'
        AND order_binding.label_state = 'applied'
    ) = (
      SELECT coalesce(sum(order_item.quantity), 0)
      FROM public.merch_fulfillment_order_items AS order_item
      WHERE order_item.fulfillment_order_id = assignment.fulfillment_order_id
        AND order_item.source_active
        AND order_item.marking_requirement = 'required'
    )
  ) AS can_validate_ozon,
  (
    assignment.assignment_status = 'active'
    AND assignment.crpt_state = ANY (
      ARRAY['introduced'::text, 'in_circulation'::text]
    )
    AND latest_ozon.batch_status = 'validated'
    AND latest_ozon.submission_status = 'validated'
  ) AS can_submit_ozon,
  CASE
    WHEN assignment.assignment_status <> 'active'
      THEN 'Подготовка единицы не активна'
    WHEN assignment.label_state <> 'applied'
      THEN 'КМ не нанесён'
    WHEN assignment.crpt_state <> ALL (
      ARRAY['introduced'::text, 'in_circulation'::text]
    )
      THEN 'Ожидается ввод в оборот'
    WHEN latest_ozon.submission_status = 'accepted'
      THEN ''
    WHEN latest_ozon.submission_status = 'validated'
      THEN 'КМ проверен, но ещё не передан в Ozon'
    WHEN latest_ozon.submission_status = ANY (
      ARRAY['validation_rejected'::text, 'rejected'::text,
            'manual_review'::text]
    )
      THEN 'Ozon отклонил КМ или требуется ручная проверка'
    WHEN latest_ozon.submission_status = ANY (
      ARRAY['validating'::text, 'submitting'::text, 'polling'::text]
    )
      THEN 'Ozon обрабатывает КМ'
    ELSE 'КМ ещё не передан в Ozon'
  END AS shipping_blocker,
  assignment.created_at,
  assignment.updated_at
FROM getomerch_marking.assignment_safe AS assignment
LEFT JOIN public.merch_marking_processes AS process
  ON process.id = assignment.process_id
LEFT JOIN LATERAL (
  SELECT event.event_type, event.occurred_at
  FROM public.merch_marking_events AS event
  WHERE event.assignment_id = assignment.id
  ORDER BY event.occurred_at DESC, event.id DESC
  LIMIT 1
) AS latest_event ON true
LEFT JOIN LATERAL (
  SELECT submission.status AS submission_status, batch.status AS batch_status
  FROM public.merch_marking_ozon_submissions AS submission
  JOIN public.merch_marking_ozon_submission_batches AS batch
    ON batch.id = submission.batch_id
  WHERE submission.assignment_id = assignment.id
    AND batch.status <> 'superseded'
  ORDER BY batch.request_revision DESC, submission.created_at DESC
  LIMIT 1
) AS latest_ozon ON true;

REVOKE ALL ON public.merch_marking_ozon_submission_batches,
  public.merch_marking_ozon_submissions FROM PUBLIC, getomerch_app;
GRANT SELECT ON public.merch_marking_ozon_submission_batches,
  public.merch_marking_ozon_submissions TO getomerch_backup;

REVOKE ALL ON FUNCTION getomerch_marking.prepare_ozon_submission_batch(
  uuid, text, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_ozon_exemplar_mapping(
  uuid, jsonb, integer, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_ozon_submission_material(
  uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_ozon_validation(
  uuid, jsonb, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_ozon_set_queued_for_poll(
  uuid, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_ozon_poll(
  uuid, text, jsonb, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_ozon_batch_failure(
  uuid, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.prepare_ozon_submission_batch(
  uuid, text, boolean
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_ozon_exemplar_mapping(
  uuid, jsonb, integer, jsonb, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.get_ozon_submission_material(
  uuid, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_ozon_validation(
  uuid, jsonb, jsonb
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_ozon_set_queued_for_poll(
  uuid, text, jsonb
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_ozon_poll(
  uuid, text, jsonb, jsonb
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_ozon_batch_failure(
  uuid, text, text, text
) TO getomerch_app;
GRANT SELECT ON getomerch_marking.ozon_submission_batch_safe,
  getomerch_marking.ozon_submission_safe,
  getomerch_marking.assignment_action_safe TO getomerch_app, getomerch_backup;

COMMENT ON TABLE public.merch_marking_ozon_submission_batches IS
  'Revisioned full-posting Ozon exemplar submissions; request bodies are reconstructed and never persisted in plaintext.';
COMMENT ON FUNCTION getomerch_marking.get_ozon_submission_material(
  uuid, text, text
) IS
  'Narrow marking-worker path for encrypted Ozon exemplar material; never expose through JSON or logs.';
