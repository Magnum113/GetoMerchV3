-- Stage 11: server-side shipping gate, explicit physical FBS handover and
-- revisioned LK_RECEIPT/DISTANCE withdrawal documents.

CREATE TABLE public.merch_marking_shipping_gate_evaluations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fulfillment_order_id uuid NOT NULL
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
    mode text NOT NULL,
    allowed boolean NOT NULL,
    blockers text[] DEFAULT ARRAY[]::text[] NOT NULL,
    evidence_version text NOT NULL,
    snapshot_hash text NOT NULL,
    snapshot_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    evaluated_by text NOT NULL,
    request_id uuid NOT NULL,
    evaluated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_shipping_gate_mode_check
      CHECK (mode = ANY (ARRAY['observe'::text, 'enforce'::text])),
    CONSTRAINT merch_marking_shipping_gate_allowed_check
      CHECK (allowed = (cardinality(blockers) = 0)),
    CONSTRAINT merch_marking_shipping_gate_blockers_check
      CHECK (cardinality(blockers) <= 30
        AND octet_length(array_to_string(blockers, ',')) <= 6000),
    CONSTRAINT merch_marking_shipping_gate_version_check
      CHECK (length(evidence_version) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_shipping_gate_hash_check
      CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_shipping_gate_snapshot_check
      CHECK (jsonb_typeof(snapshot_redacted) = 'object'
        AND octet_length(snapshot_redacted::text) <= 32768),
    CONSTRAINT merch_marking_shipping_gate_actor_check
      CHECK (length(evaluated_by) BETWEEN 1 AND 200)
);

CREATE INDEX merch_marking_shipping_gate_order_time
  ON public.merch_marking_shipping_gate_evaluations (
    fulfillment_order_id, evaluated_at DESC, id DESC
  );
CREATE INDEX merch_marking_shipping_gate_blocked
  ON public.merch_marking_shipping_gate_evaluations (evaluated_at DESC, id DESC)
  WHERE NOT allowed;

CREATE TABLE public.merch_marking_handovers (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fulfillment_order_id uuid NOT NULL UNIQUE
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
    gate_evaluation_id uuid NOT NULL UNIQUE
      REFERENCES public.merch_marking_shipping_gate_evaluations(id) ON DELETE RESTRICT,
    posting_number text NOT NULL,
    handover_source text NOT NULL,
    source_reference text NOT NULL,
    evidence_version text NOT NULL,
    snapshot_hash text NOT NULL,
    snapshot_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    withdrawal_deadline_at timestamp with time zone NOT NULL,
    deadline_calendar_version text NOT NULL,
    recorded_by text NOT NULL,
    request_id uuid NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_handovers_posting_check
      CHECK (length(posting_number) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_handovers_source_check
      CHECK (handover_source = 'operator_confirmed'),
    CONSTRAINT merch_marking_handovers_reference_check
      CHECK (length(source_reference) BETWEEN 1 AND 500),
    CONSTRAINT merch_marking_handovers_version_check
      CHECK (length(evidence_version) BETWEEN 1 AND 120
        AND length(deadline_calendar_version) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_handovers_hash_check
      CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_handovers_snapshot_check
      CHECK (jsonb_typeof(snapshot_redacted) = 'object'
        AND octet_length(snapshot_redacted::text) <= 32768),
    CONSTRAINT merch_marking_handovers_time_check
      CHECK (withdrawal_deadline_at > occurred_at),
    CONSTRAINT merch_marking_handovers_actor_check
      CHECK (length(recorded_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_handovers_idempotency_check
      CHECK (length(idempotency_key) BETWEEN 16 AND 300)
);

CREATE TABLE public.merch_marking_handover_units (
    handover_id uuid NOT NULL
      REFERENCES public.merch_marking_handovers(id) ON DELETE RESTRICT,
    assignment_id uuid NOT NULL UNIQUE
      REFERENCES public.merch_marking_assignments(id) ON DELETE RESTRICT,
    marking_unit_id uuid NOT NULL UNIQUE
      REFERENCES public.merch_marking_units(id) ON DELETE RESTRICT,
    marking_code_id uuid NOT NULL UNIQUE
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    product_cost_minor bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (handover_id, assignment_id),
    CONSTRAINT merch_marking_handover_units_cost_check
      CHECK (product_cost_minor BETWEEN 1 AND 99999999999999999)
);

CREATE INDEX merch_marking_handovers_deadline
  ON public.merch_marking_handovers (withdrawal_deadline_at, occurred_at)
  WHERE withdrawal_deadline_at IS NOT NULL;

ALTER TABLE public.merch_marking_documents
  DROP CONSTRAINT merch_marking_documents_type_check,
  DROP CONSTRAINT merch_marking_documents_mode_check,
  ADD COLUMN fulfillment_order_id uuid
    REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
  ADD COLUMN handover_id uuid
    REFERENCES public.merch_marking_handovers(id) ON DELETE RESTRICT,
  ADD COLUMN process_id uuid
    REFERENCES public.merch_marking_processes(id) ON DELETE RESTRICT,
  ADD CONSTRAINT merch_marking_documents_type_check CHECK (
    document_type = ANY (
      ARRAY['introduction'::text, 'withdrawal_remote_sale'::text]
    )
  ),
  ADD CONSTRAINT merch_marking_documents_mode_check CHECK (
    operation_mode = ANY (
      ARRAY['own_production'::text, 'distance_sale'::text]
    )
  ),
  ADD CONSTRAINT merch_marking_documents_type_mode_check CHECK (
    (document_type = 'introduction' AND operation_mode = 'own_production'
      AND fulfillment_order_id IS NULL AND handover_id IS NULL)
    OR
    (document_type = 'withdrawal_remote_sale' AND operation_mode = 'distance_sale'
      AND fulfillment_order_id IS NOT NULL AND handover_id IS NOT NULL
      AND process_id IS NOT NULL)
  );

CREATE INDEX merch_marking_documents_handover
  ON public.merch_marking_documents (handover_id, revision DESC)
  WHERE handover_id IS NOT NULL;

ALTER TABLE public.merch_marking_document_codes
  ADD COLUMN operation_kind text DEFAULT 'introduction'::text NOT NULL,
  ADD CONSTRAINT merch_marking_document_codes_operation_check
    CHECK (operation_kind = ANY (
      ARRAY['introduction'::text, 'withdrawal'::text]
    ));

DROP INDEX merch_marking_document_codes_active_assignment;
DROP INDEX merch_marking_document_codes_active_code;
CREATE UNIQUE INDEX merch_marking_document_codes_active_assignment_operation
  ON public.merch_marking_document_codes (assignment_id, operation_kind)
  WHERE link_state = 'active';
CREATE UNIQUE INDEX merch_marking_document_codes_active_code_operation
  ON public.merch_marking_document_codes (marking_code_id, operation_kind)
  WHERE link_state = 'active';

CREATE TABLE public.merch_marking_withdrawal_confirmations (
    document_id uuid PRIMARY KEY
      REFERENCES public.merch_marking_documents(id) ON DELETE RESTRICT,
    withdrawal_state text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    error_message text,
    checked_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_withdrawal_confirmation_state_check
      CHECK (withdrawal_state = ANY (ARRAY[
        'pending'::text, 'confirmed'::text, 'requires_manual_review'::text
      ])),
    CONSTRAINT merch_marking_withdrawal_confirmation_error_check CHECK (
      (withdrawal_state = 'requires_manual_review'
        AND error_code IS NOT NULL AND error_message IS NOT NULL)
      OR
      (withdrawal_state <> 'requires_manual_review'
        AND error_code IS NULL AND error_message IS NULL)
    ),
    CONSTRAINT merch_marking_withdrawal_confirmation_time_check CHECK (
      (withdrawal_state = 'confirmed' AND confirmed_at IS NOT NULL)
      OR (withdrawal_state <> 'confirmed' AND confirmed_at IS NULL)
    )
);

CREATE OR REPLACE FUNCTION getomerch_marking.add_conservative_workdays(
  p_started_at timestamp with time zone,
  p_days integer
)
RETURNS timestamp with time zone
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE result_at timestamp with time zone := p_started_at;
DECLARE remaining integer := p_days;
BEGIN
  IF p_started_at IS NULL OR p_days NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'invalid workday deadline input' USING ERRCODE = 'MZB00';
  END IF;
  WHILE remaining > 0 LOOP
    result_at := result_at + interval '1 day';
    IF extract(isodow FROM result_at) BETWEEN 1 AND 5 THEN
      remaining := remaining - 1;
    END IF;
  END LOOP;
  RETURN result_at;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.evaluate_shipping_gate(
  p_fulfillment_order_id uuid,
  p_mode text,
  p_actor_id text,
  p_request_id uuid
)
RETURNS TABLE (
  evaluation_id uuid,
  allowed boolean,
  mode text,
  blockers text[],
  evidence_version text,
  evaluated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE order_record record;
DECLARE required_quantity integer := 0;
DECLARE assignment_count integer := 0;
DECLARE invalid_assignment_count integer := 0;
DECLARE ozon_missing_count integer := 0;
DECLARE location_count integer := 0;
DECLARE price_missing_count integer := 0;
DECLARE critical_process_count integer := 0;
DECLARE blocker_list text[] := ARRAY[]::text[];
DECLARE snapshot jsonb;
DECLARE snapshot_digest text;
DECLARE created_id uuid;
DECLARE checked_at timestamp with time zone := clock_timestamp();
BEGIN
  IF p_fulfillment_order_id IS NULL OR p_request_id IS NULL
     OR p_mode <> ALL (ARRAY['observe'::text, 'enforce'::text])
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid shipping gate request' USING ERRCODE = 'MZB01';
  END IF;

  SELECT fulfillment_order.id, fulfillment_order.source_channel,
    fulfillment_order.fulfillment_scheme, fulfillment_order.source_status,
    fulfillment_order.external_posting_number
  INTO order_record
  FROM public.merch_fulfillment_orders AS fulfillment_order
  WHERE fulfillment_order.id = p_fulfillment_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment order not found' USING ERRCODE = 'MZB02';
  END IF;

  IF order_record.source_channel <> 'ozon_fbs'
     OR order_record.fulfillment_scheme <> 'fbs'
     OR order_record.external_posting_number IS NULL THEN
    blocker_list := array_append(blocker_list, 'unsupported_fulfillment');
  END IF;
  IF order_record.source_status IS NULL
     OR order_record.source_status <> ALL (ARRAY[
       'awaiting_packaging'::text, 'awaiting_deliver'::text
     ]) THEN
    blocker_list := array_append(blocker_list, 'posting_not_shippable');
  END IF;

  SELECT coalesce(sum(item.quantity), 0)::integer
  INTO required_quantity
  FROM public.merch_fulfillment_order_items AS item
  WHERE item.fulfillment_order_id = p_fulfillment_order_id
    AND item.source_active
    AND item.marking_requirement = 'required';

  SELECT count(*)::integer,
    count(*) FILTER (WHERE
      assignment.status <> 'active'
      OR unit.unit_state <> 'reserved'
      OR binding.status <> 'active'
      OR binding.label_state <> 'applied'
      OR code.pool_state <> 'bound'
      OR code.crpt_state <> 'in_circulation'
    )::integer
  INTO assignment_count, invalid_assignment_count
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_marking_units AS unit ON unit.id = assignment.marking_unit_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_codes AS code ON code.id = binding.marking_code_id
  WHERE item.fulfillment_order_id = p_fulfillment_order_id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND assignment.unit_ordinal <= item.quantity
    AND assignment.status = 'active';

  IF assignment_count <> required_quantity THEN
    blocker_list := array_append(blocker_list, 'assignment_quantity_mismatch');
  END IF;
  IF invalid_assignment_count > 0 THEN
    blocker_list := array_append(blocker_list, 'marking_unit_not_ready');
  END IF;

  SELECT count(*)::integer INTO ozon_missing_count
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  WHERE item.fulfillment_order_id = p_fulfillment_order_id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND assignment.status = 'active'
    AND assignment.unit_ordinal <= item.quantity
    AND NOT EXISTS (
      SELECT 1
      FROM public.merch_marking_ozon_submissions AS submission
      JOIN public.merch_marking_ozon_submission_batches AS batch
        ON batch.id = submission.batch_id
      WHERE submission.assignment_id = assignment.id
        AND submission.status = 'accepted'
        AND batch.status = 'accepted'
    );
  IF ozon_missing_count > 0 THEN
    blocker_list := array_append(blocker_list, 'ozon_exemplar_not_accepted');
  END IF;

  SELECT count(DISTINCT location.id)::integer INTO location_count
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_marking_units AS unit ON unit.id = assignment.marking_unit_id
  JOIN public.merch_marking_locations AS location
    ON location.warehouse_id = unit.warehouse_id
   AND location.status = 'verified'
   AND location.kpp ~ '^[0-9]{9}$'
   AND length(location.fias_id) BETWEEN 1 AND 120
  WHERE item.fulfillment_order_id = p_fulfillment_order_id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND assignment.status = 'active'
    AND assignment.unit_ordinal <= item.quantity;
  IF required_quantity > 0 AND location_count <> 1 THEN
    blocker_list := array_append(blocker_list, 'withdrawal_location_not_ready');
  END IF;

  SELECT count(*)::integer INTO price_missing_count
  FROM public.merch_fulfillment_order_items AS item
  LEFT JOIN public.merch_ozon_order_items AS ozon_item
    ON ozon_item.fulfillment_item_id = item.id
   AND ozon_item.source_active
  WHERE item.fulfillment_order_id = p_fulfillment_order_id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND (ozon_item.id IS NULL OR ozon_item.price IS NULL OR ozon_item.price <= 0);
  IF price_missing_count > 0 THEN
    blocker_list := array_append(blocker_list, 'product_cost_missing');
  END IF;

  SELECT count(*)::integer INTO critical_process_count
  FROM public.merch_marking_processes AS process
  WHERE process.fulfillment_order_id = p_fulfillment_order_id
    AND process.status = ANY (ARRAY['manual_review'::text, 'failed'::text]);
  IF critical_process_count > 0 THEN
    blocker_list := array_append(blocker_list, 'critical_discrepancy');
  END IF;

  SELECT coalesce(array_agg(DISTINCT value ORDER BY value), ARRAY[]::text[])
  INTO blocker_list FROM unnest(blocker_list) AS value;
  snapshot := jsonb_build_object(
    'postingNumber', order_record.external_posting_number,
    'sourceStatus', order_record.source_status,
    'requiredQuantity', required_quantity,
    'assignmentCount', assignment_count,
    'invalidAssignmentCount', invalid_assignment_count,
    'ozonMissingCount', ozon_missing_count,
    'locationCount', location_count,
    'priceMissingCount', price_missing_count,
    'criticalProcessCount', critical_process_count,
    'blockers', to_jsonb(blocker_list)
  );
  snapshot_digest := encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex');
  INSERT INTO public.merch_marking_shipping_gate_evaluations (
    fulfillment_order_id, mode, allowed, blockers, evidence_version,
    snapshot_hash, snapshot_redacted, evaluated_by, request_id, evaluated_at
  ) VALUES (
    p_fulfillment_order_id, p_mode, cardinality(blocker_list) = 0,
    blocker_list, 'shipping-gate-v1', snapshot_digest, snapshot,
    p_actor_id, p_request_id, checked_at
  ) RETURNING id INTO created_id;

  RETURN QUERY SELECT created_id, cardinality(blocker_list) = 0,
    p_mode, blocker_list, 'shipping-gate-v1'::text, checked_at;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.prepare_withdrawal_document(
  p_handover_id uuid,
  p_actor_id text,
  p_request_id uuid,
  p_force_correction boolean DEFAULT false
)
RETURNS TABLE (
  document_id uuid,
  document_status text,
  document_revision integer,
  reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE handover_record record;
DECLARE selected_location public.merch_marking_locations%ROWTYPE;
DECLARE existing_record record;
DECLARE next_revision integer := 1;
DECLARE created_id uuid;
DECLARE expected_unit_count integer := 0;
DECLARE handover_unit_count integer := 0;
DECLARE invalid_material_count integer := 0;
DECLARE ozon_missing_count integer := 0;
DECLARE eligible_location_count integer := 0;
BEGIN
  IF p_handover_id IS NULL OR p_request_id IS NULL OR p_force_correction IS NULL
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid withdrawal document request' USING ERRCODE = 'MZB10';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'marking-withdrawal:' || p_handover_id::text, 0));

  SELECT handover.id, handover.fulfillment_order_id, handover.posting_number,
    handover.occurred_at, handover.withdrawal_deadline_at,
    process.id AS process_id
  INTO handover_record
  FROM public.merch_marking_handovers AS handover
  JOIN public.merch_marking_processes AS process
    ON process.process_type = 'fbs_remote_withdrawal'
   AND process.source = 'shipping_handover'
   AND process.source_key = handover.id::text
  WHERE handover.id = p_handover_id
  FOR UPDATE OF handover, process;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal handover is not document-ready' USING ERRCODE = 'MZB11';
  END IF;

  SELECT coalesce(sum(item.quantity), 0)::integer
  INTO expected_unit_count
  FROM public.merch_fulfillment_order_items AS item
  WHERE item.fulfillment_order_id = handover_record.fulfillment_order_id
    AND item.source_active
    AND item.marking_requirement = 'required';
  SELECT count(*)::integer,
    count(*) FILTER (WHERE
      handover_unit.product_cost_minor IS NULL
      OR handover_unit.product_cost_minor <= 0
      OR code.crpt_state <> 'in_circulation'
    )::integer
  INTO handover_unit_count, invalid_material_count
  FROM public.merch_marking_handover_units AS handover_unit
  JOIN public.merch_marking_codes AS code
    ON code.id = handover_unit.marking_code_id
  WHERE handover_unit.handover_id = p_handover_id;
  SELECT count(*)::integer INTO ozon_missing_count
  FROM public.merch_marking_handover_units AS handover_unit
  WHERE handover_unit.handover_id = p_handover_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.merch_marking_ozon_submissions AS submission
      JOIN public.merch_marking_ozon_submission_batches AS batch
        ON batch.id = submission.batch_id
      WHERE submission.assignment_id = handover_unit.assignment_id
        AND submission.status = 'accepted'
        AND batch.status = 'accepted'
    );
  IF expected_unit_count < 1 OR handover_unit_count <> expected_unit_count
     OR invalid_material_count > 0 OR ozon_missing_count > 0 THEN
    RAISE EXCEPTION 'withdrawal handover material is incomplete'
      USING ERRCODE = 'MZB16';
  END IF;

  SELECT count(*)::integer INTO eligible_location_count
  FROM (
    SELECT location.id
    FROM public.merch_marking_handover_units AS handover_unit
    JOIN public.merch_marking_units AS unit ON unit.id = handover_unit.marking_unit_id
    JOIN public.merch_marking_locations AS location
      ON location.warehouse_id = unit.warehouse_id
    WHERE handover_unit.handover_id = p_handover_id
      AND location.status = 'verified'
      AND location.kpp ~ '^[0-9]{9}$'
      AND length(location.fias_id) BETWEEN 1 AND 120
    GROUP BY location.id
    HAVING count(*) = handover_unit_count
  ) AS eligible_location;
  IF eligible_location_count <> 1 THEN
    RAISE EXCEPTION 'exactly one complete withdrawal location is required'
      USING ERRCODE = 'MZB12';
  END IF;
  SELECT location.* INTO selected_location
  FROM public.merch_marking_handover_units AS handover_unit
  JOIN public.merch_marking_units AS unit ON unit.id = handover_unit.marking_unit_id
  JOIN public.merch_marking_locations AS location
    ON location.warehouse_id = unit.warehouse_id
  WHERE handover_unit.handover_id = p_handover_id
    AND location.status = 'verified'
    AND location.kpp ~ '^[0-9]{9}$'
    AND length(location.fias_id) BETWEEN 1 AND 120
  GROUP BY location.id
  HAVING count(*) = handover_unit_count
  ORDER BY location.id
  LIMIT 1;

  SELECT document.id, document.status, document.revision, document.error_code
  INTO existing_record
  FROM public.merch_marking_documents AS document
  WHERE document.handover_id = p_handover_id
    AND document.document_type = 'withdrawal_remote_sale'
    AND document.status <> 'superseded'
  FOR UPDATE;
  IF FOUND AND NOT p_force_correction THEN
    RETURN QUERY SELECT existing_record.id, existing_record.status,
      existing_record.revision, true;
    RETURN;
  END IF;
  IF FOUND THEN
    IF existing_record.status <> ALL (
      ARRAY['rejected'::text, 'requires_manual_review'::text]) THEN
      RAISE EXCEPTION 'only failed withdrawal can be superseded' USING ERRCODE = 'MZB13';
    END IF;
    IF existing_record.error_code = 'crpt_submit_outcome_unknown' THEN
      RAISE EXCEPTION 'ambiguous withdrawal must be reconciled before correction'
        USING ERRCODE = 'MZB14';
    END IF;
    next_revision := existing_record.revision + 1;
    UPDATE public.merch_marking_document_codes AS document_code
    SET link_state = 'superseded', updated_at = clock_timestamp()
    WHERE document_code.document_id = existing_record.id;
    UPDATE public.merch_marking_documents
    SET status = 'superseded', updated_at = clock_timestamp()
    WHERE id = existing_record.id;
  END IF;

  INSERT INTO public.merch_marking_documents (
    document_type, operation_mode, location_id, location_snapshot,
    fulfillment_order_id, handover_id, process_id, revision,
    supersedes_document_id, idempotency_key, api_contract_version,
    created_by, request_id
  ) VALUES (
    'withdrawal_remote_sale', 'distance_sale', selected_location.id,
    jsonb_build_object(
      'name', selected_location.name,
      'warehouseId', selected_location.warehouse_id,
      'kpp', selected_location.kpp,
      'fiasId', selected_location.fias_id,
      'crptLocationId', selected_location.crpt_location_id,
      'address', selected_location.address_snapshot,
      'verifiedAt', selected_location.verified_at
    ),
    handover_record.fulfillment_order_id, p_handover_id,
    handover_record.process_id, next_revision,
    CASE WHEN existing_record.id IS NULL THEN NULL ELSE existing_record.id END,
    'lp-distance:' || p_handover_id::text || ':r' || next_revision::text,
    'true-api-lk-receipt-v649.0-2026-04-15', p_actor_id, p_request_id
  ) RETURNING id INTO created_id;

  INSERT INTO public.merch_marking_document_codes (
    document_id, marking_code_id, marking_unit_id, assignment_id,
    gtin_snapshot, code_fingerprint, operation_kind
  )
  SELECT created_id, handover_unit.marking_code_id,
    handover_unit.marking_unit_id, handover_unit.assignment_id,
    assignment.gtin_snapshot, code.fingerprint, 'withdrawal'
  FROM public.merch_marking_handover_units AS handover_unit
  JOIN public.merch_marking_assignments AS assignment
    ON assignment.id = handover_unit.assignment_id
  JOIN public.merch_marking_codes AS code
    ON code.id = handover_unit.marking_code_id
  WHERE handover_unit.handover_id = p_handover_id
  ORDER BY assignment.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal document has no serialized units' USING ERRCODE = 'MZB15';
  END IF;
  INSERT INTO public.merch_marking_withdrawal_confirmations (document_id)
  VALUES (created_id);

  INSERT INTO public.merch_marking_events (
    marking_code_id, marking_unit_id, code_binding_id, assignment_id,
    process_id, document_id, event_type, actor_type, actor_id, source,
    details_redacted, occurred_at
  )
  SELECT handover_unit.marking_code_id, handover_unit.marking_unit_id,
    assignment.code_binding_id, handover_unit.assignment_id,
    handover_record.process_id, created_id,
    'crpt_withdrawal_draft_created', 'worker', p_actor_id,
    'marking_crpt_withdrawal',
    jsonb_build_object('revision', next_revision,
      'documentType', 'LK_RECEIPT', 'action', 'DISTANCE'),
    clock_timestamp()
  FROM public.merch_marking_handover_units AS handover_unit
  JOIN public.merch_marking_assignments AS assignment
    ON assignment.id = handover_unit.assignment_id
  WHERE handover_unit.handover_id = p_handover_id;

  RETURN QUERY SELECT created_id, 'draft'::text, next_revision, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_shipping_handover(
  p_fulfillment_order_id uuid,
  p_gate_evaluation_id uuid,
  p_actor_id text,
  p_request_id uuid,
  p_idempotency_key text
)
RETURNS TABLE (
  handover_id uuid,
  document_id uuid,
  document_status text,
  gate_allowed boolean,
  blockers text[],
  reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE gate_record record;
DECLARE order_record record;
DECLARE existing_record record;
DECLARE created_handover_id uuid;
DECLARE created_process_id uuid;
DECLARE prepared record;
DECLARE happened_at timestamp with time zone := clock_timestamp();
DECLARE snapshot jsonb;
DECLARE snapshot_digest text;
BEGIN
  IF p_fulfillment_order_id IS NULL OR p_gate_evaluation_id IS NULL
     OR p_request_id IS NULL OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 16 AND 300 THEN
    RAISE EXCEPTION 'invalid physical handover request' USING ERRCODE = 'MZB20';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'marking-handover:' || p_fulfillment_order_id::text, 0));

  SELECT handover.id, handover.gate_evaluation_id
  INTO existing_record
  FROM public.merch_marking_handovers AS handover
  WHERE handover.fulfillment_order_id = p_fulfillment_order_id
  FOR UPDATE;
  IF FOUND THEN
    SELECT document.id, document.status INTO prepared
    FROM public.merch_marking_documents AS document
    WHERE document.handover_id = existing_record.id
      AND document.document_type = 'withdrawal_remote_sale'
      AND document.status <> 'superseded'
    ORDER BY document.revision DESC LIMIT 1;
    RETURN QUERY SELECT existing_record.id, prepared.id, prepared.status,
      evaluation.allowed, evaluation.blockers, true
    FROM public.merch_marking_shipping_gate_evaluations AS evaluation
    WHERE evaluation.id = existing_record.gate_evaluation_id;
    RETURN;
  END IF;

  SELECT evaluation.allowed, evaluation.blockers, evaluation.mode,
    evaluation.evidence_version, evaluation.snapshot_hash
  INTO gate_record
  FROM public.merch_marking_shipping_gate_evaluations AS evaluation
  WHERE evaluation.id = p_gate_evaluation_id
    AND evaluation.fulfillment_order_id = p_fulfillment_order_id
    AND evaluation.evaluated_by = p_actor_id
    AND evaluation.request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shipping gate evaluation not found' USING ERRCODE = 'MZB21';
  END IF;

  SELECT fulfillment_order.external_posting_number, fulfillment_order.source_channel,
    ozon_order.id AS ozon_order_id, ozon_order.shipped_at
  INTO order_record
  FROM public.merch_fulfillment_orders AS fulfillment_order
  JOIN public.merch_ozon_orders AS ozon_order
    ON ozon_order.fulfillment_order_id = fulfillment_order.id
  WHERE fulfillment_order.id = p_fulfillment_order_id
  FOR UPDATE OF fulfillment_order, ozon_order;
  IF NOT FOUND OR order_record.source_channel <> 'ozon_fbs'
     OR order_record.external_posting_number IS NULL
     OR order_record.shipped_at IS NULL THEN
    RAISE EXCEPTION 'physical handover requires a shipped Ozon FBS order'
      USING ERRCODE = 'MZB22';
  END IF;

  snapshot := jsonb_build_object(
    'postingNumber', order_record.external_posting_number,
    'ozonOrderId', order_record.ozon_order_id,
    'gateEvaluationId', p_gate_evaluation_id,
    'gateAllowed', gate_record.allowed,
    'gateMode', gate_record.mode,
    'blockers', to_jsonb(gate_record.blockers)
  );
  snapshot_digest := encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex');
  INSERT INTO public.merch_marking_handovers (
    fulfillment_order_id, gate_evaluation_id, posting_number,
    handover_source, source_reference, evidence_version, snapshot_hash,
    snapshot_redacted, occurred_at, withdrawal_deadline_at,
    deadline_calendar_version, recorded_by, request_id, idempotency_key
  ) VALUES (
    p_fulfillment_order_id, p_gate_evaluation_id,
    order_record.external_posting_number, 'operator_confirmed',
    'admin.rpc.shipOzonOrder:' || order_record.ozon_order_id::text,
    'operator-handover-v1', snapshot_digest, snapshot, happened_at,
    getomerch_marking.add_conservative_workdays(happened_at, 3),
    'weekday-conservative-v1', p_actor_id, p_request_id, p_idempotency_key
  ) RETURNING id INTO created_handover_id;

  INSERT INTO public.merch_marking_handover_units (
    handover_id, assignment_id, marking_unit_id, marking_code_id,
    product_cost_minor
  )
  SELECT created_handover_id, assignment.id, assignment.marking_unit_id,
    binding.marking_code_id, round(ozon_item.price * 100)::bigint
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_ozon_order_items AS ozon_item
    ON ozon_item.fulfillment_item_id = item.id
   AND ozon_item.source_active
  WHERE item.fulfillment_order_id = p_fulfillment_order_id
    AND item.source_active
    AND item.marking_requirement = 'required'
    AND assignment.status = 'active'
    AND assignment.unit_ordinal <= item.quantity
  ORDER BY assignment.id;

  UPDATE public.merch_marking_assignments AS assignment
  SET status = 'completed', completed_at = happened_at,
    revision = assignment.revision + 1, updated_at = happened_at
  FROM public.merch_marking_handover_units AS handover_unit
  WHERE handover_unit.handover_id = created_handover_id
    AND handover_unit.assignment_id = assignment.id;
  UPDATE public.merch_marking_units AS unit
  SET unit_state = 'shipped', custody_state = 'ozon',
    version = unit.version + 1, updated_at = happened_at
  FROM public.merch_marking_handover_units AS handover_unit
  WHERE handover_unit.handover_id = created_handover_id
    AND handover_unit.marking_unit_id = unit.id;
  UPDATE public.merch_marking_processes AS process
  SET status = 'completed', current_step = 'handed_to_ozon', next_action = NULL,
    completed_at = happened_at, version = process.version + 1,
    updated_at = happened_at
  FROM public.merch_marking_handover_units AS handover_unit
  WHERE handover_unit.handover_id = created_handover_id
    AND process.assignment_id = handover_unit.assignment_id
    AND process.process_type = 'jit_marking_unit'
    AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text]);

  IF NOT gate_record.allowed THEN
    INSERT INTO public.merch_marking_processes (
      process_type, status, fulfillment_order_id, source, source_key,
      priority, current_step, next_action, deadline_at,
      manual_review_reason, owner
    ) VALUES (
      'fbs_remote_withdrawal', 'manual_review', p_fulfillment_order_id,
      'shipping_handover', created_handover_id::text, 100,
      'handover_with_blockers', 'Сверить маркированные единицы и создать вывод',
      getomerch_marking.add_conservative_workdays(happened_at, 3),
      'Фактическая передача сохранена в observe-режиме с блокерами: '
        || array_to_string(gate_record.blockers, ', '), p_actor_id
    ) RETURNING id INTO created_process_id;
    RETURN QUERY SELECT created_handover_id, NULL::uuid, NULL::text,
      false, gate_record.blockers, false;
    RETURN;
  END IF;

  INSERT INTO public.merch_marking_processes (
    process_type, status, fulfillment_order_id, source, source_key,
    priority, current_step, next_action, deadline_at, owner
  ) VALUES (
    'fbs_remote_withdrawal', 'waiting_external', p_fulfillment_order_id,
    'shipping_handover', created_handover_id::text, 100,
    'withdrawal_draft', 'Подписать и отправить вывод из оборота',
    getomerch_marking.add_conservative_workdays(happened_at, 3), p_actor_id
  ) RETURNING id INTO created_process_id;

  SELECT * INTO prepared
  FROM getomerch_marking.prepare_withdrawal_document(
    created_handover_id, p_actor_id, p_request_id, false
  );
  RETURN QUERY SELECT created_handover_id, prepared.document_id,
    prepared.document_status, true, gate_record.blockers, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.get_withdrawal_document_material(
  p_document_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  document_id uuid, document_status text, api_contract_version text,
  posting_number text, action_date date, kpp text, fias_id text,
  location_name text, code_fingerprint text, gtin text, offer_id text,
  product_cost_minor bigint, code_ciphertext bytea, code_nonce bytea,
  code_auth_tag bytea, code_key_version integer, payload_hash text,
  payload_ciphertext bytea, payload_nonce bytea, payload_auth_tag bytea,
  payload_key_version integer, signature_hash text,
  signature_ciphertext bytea, signature_nonce bytea,
  signature_auth_tag bytea, signature_key_version integer,
  external_document_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_document_id IS NULL OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid withdrawal material request' USING ERRCODE = 'MZB30';
  END IF;
  RETURN QUERY
  SELECT document.id, document.status, document.api_contract_version,
    handover.posting_number, handover.occurred_at::date,
    document.location_snapshot->>'kpp', document.location_snapshot->>'fiasId',
    document.location_snapshot->>'name', link.code_fingerprint,
    link.gtin_snapshot, item.offer_id, handover_unit.product_cost_minor,
    code.code_ciphertext, code.code_nonce, code.code_auth_tag,
    code.encryption_key_version, document.payload_hash,
    document.payload_ciphertext, document.payload_nonce,
    document.payload_auth_tag, document.payload_key_version,
    document.signature_hash, document.signature_ciphertext,
    document.signature_nonce, document.signature_auth_tag,
    document.signature_key_version, document.external_document_id
  FROM public.merch_marking_documents AS document
  JOIN public.merch_marking_handovers AS handover ON handover.id = document.handover_id
  JOIN public.merch_marking_document_codes AS link ON link.document_id = document.id
  JOIN public.merch_marking_handover_units AS handover_unit
    ON handover_unit.handover_id = handover.id
   AND handover_unit.assignment_id = link.assignment_id
  JOIN public.merch_marking_codes AS code ON code.id = link.marking_code_id
  JOIN public.merch_marking_assignments AS assignment ON assignment.id = link.assignment_id
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  WHERE document.id = p_document_id
    AND document.document_type = 'withdrawal_remote_sale'
    AND link.operation_kind = 'withdrawal'
    AND link.link_state = 'active'
  ORDER BY assignment.unit_ordinal, assignment.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal document material not found' USING ERRCODE = 'MZB31';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_withdrawal_poll(
  p_document_id uuid,
  p_remote_status text,
  p_response_redacted jsonb,
  p_error_code text,
  p_error_message text,
  p_actor_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE next_status text;
DECLARE current_record record;
BEGIN
  IF p_remote_status IS NULL OR length(p_remote_status) NOT BETWEEN 1 AND 120
     OR jsonb_typeof(p_response_redacted) <> 'object'
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid withdrawal poll' USING ERRCODE = 'MZB32';
  END IF;
  next_status := CASE upper(p_remote_status)
    WHEN 'CHECKED_OK' THEN 'accepted'
    WHEN 'CHECKED_NOT_OK' THEN 'rejected'
    WHEN 'PROCESSING_ERROR' THEN 'rejected'
    WHEN 'PARSE_ERROR' THEN 'rejected'
    ELSE 'processing' END;
  SELECT document.status, document.process_id INTO current_record
  FROM public.merch_marking_documents AS document
  WHERE document.id = p_document_id
    AND document.document_type = 'withdrawal_remote_sale'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal document not found' USING ERRCODE = 'MZB31';
  END IF;
  IF current_record.status = ANY (ARRAY['accepted'::text, 'rejected'::text]) THEN
    RETURN current_record.status;
  END IF;
  IF current_record.status <> 'processing' THEN
    RAISE EXCEPTION 'withdrawal document is not being processed' USING ERRCODE = 'MZB32';
  END IF;

  UPDATE public.merch_marking_document_codes SET
    operation_result = CASE next_status
      WHEN 'accepted' THEN 'accepted' WHEN 'rejected' THEN 'rejected'
      ELSE 'pending' END,
    error_code = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_code, 'crpt_withdrawal_rejected') ELSE NULL END,
    error_message = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_message, 'GIS MT rejected the withdrawal document') ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE document_id = p_document_id;
  UPDATE public.merch_marking_documents SET
    status = next_status, response_redacted = p_response_redacted,
    error_code = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_code, 'crpt_withdrawal_rejected') ELSE NULL END,
    error_message = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_message, 'GIS MT rejected the withdrawal document') ELSE NULL END,
    checked_at = clock_timestamp(),
    accepted_at = CASE WHEN next_status = 'accepted' THEN clock_timestamp() ELSE NULL END,
    rejected_at = CASE WHEN next_status = 'rejected' THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE id = p_document_id;

  IF next_status = 'accepted' THEN
    UPDATE public.merch_marking_codes AS code SET
      crpt_state = 'withdrawn', crpt_status_raw = left(p_remote_status, 300),
      crpt_checked_at = clock_timestamp(), revision = code.revision + 1,
      updated_at = clock_timestamp()
    FROM public.merch_marking_document_codes AS link
    WHERE link.document_id = p_document_id
      AND code.id = link.marking_code_id;
    UPDATE public.merch_marking_withdrawal_confirmations SET
      withdrawal_state = 'confirmed', error_code = NULL, error_message = NULL,
      checked_at = clock_timestamp(), confirmed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE document_id = p_document_id;
    UPDATE public.merch_marking_processes SET
      status = 'completed', current_step = 'withdrawal_accepted',
      next_action = NULL, completed_at = clock_timestamp(),
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = current_record.process_id;
    INSERT INTO public.merch_marking_events (
      marking_code_id, marking_unit_id, code_binding_id, assignment_id,
      process_id, document_id, event_type, actor_type, actor_id, source,
      details_redacted, occurred_at
    )
    SELECT link.marking_code_id, link.marking_unit_id,
      assignment.code_binding_id, link.assignment_id,
      current_record.process_id, p_document_id,
      'crpt_withdrawal_confirmed', 'worker', p_actor_id,
      'marking_crpt_withdrawal',
      jsonb_build_object('state', 'withdrawn', 'action', 'DISTANCE'),
      clock_timestamp()
    FROM public.merch_marking_document_codes AS link
    JOIN public.merch_marking_assignments AS assignment
      ON assignment.id = link.assignment_id
    WHERE link.document_id = p_document_id;
  ELSIF next_status = 'rejected' THEN
    UPDATE public.merch_marking_withdrawal_confirmations SET
      withdrawal_state = 'requires_manual_review',
      error_code = coalesce(p_error_code, 'crpt_withdrawal_rejected'),
      error_message = coalesce(p_error_message, 'ГИС МТ отклонила вывод из оборота'),
      checked_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE document_id = p_document_id;
    UPDATE public.merch_marking_processes SET
      status = 'manual_review', current_step = 'withdrawal_rejected',
      next_action = 'Исправить и повторно отправить вывод из оборота',
      manual_review_reason = coalesce(p_error_message, 'ГИС МТ отклонила вывод из оборота'),
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = current_record.process_id;
  END IF;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_withdrawal_manual_review(
  p_document_id uuid,
  p_error_code text,
  p_error_message text,
  p_phase text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE process_id_value uuid;
DECLARE result text;
BEGIN
  SELECT document.process_id INTO process_id_value
  FROM public.merch_marking_documents AS document
  WHERE document.id = p_document_id
    AND document.document_type = 'withdrawal_remote_sale';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal document not found' USING ERRCODE = 'MZB31';
  END IF;
  SELECT getomerch_marking.record_introduction_manual_review(
    p_document_id, p_error_code, p_error_message,
    jsonb_build_object('phase', p_phase)
  ) INTO result;
  UPDATE public.merch_marking_withdrawal_confirmations SET
    withdrawal_state = 'requires_manual_review', error_code = p_error_code,
    error_message = p_error_message, checked_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE document_id = p_document_id;
  UPDATE public.merch_marking_processes SET
    status = 'manual_review', current_step = 'withdrawal_manual_review',
    next_action = 'Сверить вывод из оборота и создать исправленную ревизию',
    manual_review_reason = p_error_message,
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = process_id_value;
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.protect_marking_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marking documents are append-only' USING ERRCODE = 'MZA10';
  END IF;
  IF OLD.status = ANY (ARRAY['accepted'::text, 'superseded'::text]) THEN
    RAISE EXCEPTION 'terminal marking document is immutable' USING ERRCODE = 'MZA11';
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.operation_mode IS DISTINCT FROM OLD.operation_mode
    OR NEW.product_group IS DISTINCT FROM OLD.product_group
    OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.location_snapshot IS DISTINCT FROM OLD.location_snapshot
    OR NEW.fulfillment_order_id IS DISTINCT FROM OLD.fulfillment_order_id
    OR NEW.handover_id IS DISTINCT FROM OLD.handover_id
    OR NEW.process_id IS DISTINCT FROM OLD.process_id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.supersedes_document_id IS DISTINCT FROM OLD.supersedes_document_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.api_contract_version IS DISTINCT FROM OLD.api_contract_version
    OR NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
    OR NEW.payload_nonce IS DISTINCT FROM OLD.payload_nonce
    OR NEW.payload_auth_tag IS DISTINCT FROM OLD.payload_auth_tag
    OR NEW.payload_key_version IS DISTINCT FROM OLD.payload_key_version
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
  ) THEN
    RAISE EXCEPTION 'built marking document payload is immutable' USING ERRCODE = 'MZA12';
  END IF;
  IF OLD.status = 'draft' AND NEW.status <> ALL (
      ARRAY['draft'::text, 'payload_built'::text, 'requires_manual_review'::text])
    OR OLD.status = 'payload_built' AND NEW.status <> ALL (
      ARRAY['payload_built'::text, 'signed'::text, 'requires_manual_review'::text])
    OR OLD.status = 'signed' AND NEW.status <> ALL (
      ARRAY['signed'::text, 'submitting'::text, 'rejected'::text,
            'requires_manual_review'::text])
    OR OLD.status = 'submitting' AND NEW.status <> ALL (
      ARRAY['submitting'::text, 'processing'::text, 'requires_manual_review'::text])
    OR OLD.status = 'processing' AND NEW.status <> ALL (
      ARRAY['processing'::text, 'accepted'::text, 'rejected'::text,
            'requires_manual_review'::text])
    OR OLD.status = ANY (ARRAY['rejected'::text, 'requires_manual_review'::text])
      AND NEW.status <> ALL (ARRAY[OLD.status, 'superseded'::text]) THEN
    RAISE EXCEPTION 'invalid marking document transition' USING ERRCODE = 'MZA13';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.protect_marking_document_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE document_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marking document code is immutable' USING ERRCODE = 'MZA14';
  END IF;
  SELECT document.status INTO document_status
  FROM public.merch_marking_documents AS document
  WHERE document.id = NEW.document_id;
  IF document_status = ANY (ARRAY['accepted'::text, 'superseded'::text]) THEN
    RAISE EXCEPTION 'marking document code is immutable' USING ERRCODE = 'MZA14';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.marking_code_id IS DISTINCT FROM OLD.marking_code_id
    OR NEW.marking_unit_id IS DISTINCT FROM OLD.marking_unit_id
    OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
    OR NEW.gtin_snapshot IS DISTINCT FROM OLD.gtin_snapshot
    OR NEW.code_fingerprint IS DISTINCT FROM OLD.code_fingerprint
    OR NEW.operation_kind IS DISTINCT FROM OLD.operation_kind
  ) THEN
    RAISE EXCEPTION 'marking document code identity is immutable' USING ERRCODE = 'MZA14';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.protect_withdrawal_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'withdrawal confirmation is append-only' USING ERRCODE = 'MZB33';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id
     OR OLD.withdrawal_state = 'confirmed' THEN
    RAISE EXCEPTION 'confirmed withdrawal is immutable' USING ERRCODE = 'MZB33';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER merch_marking_withdrawal_confirmations_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_withdrawal_confirmations
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_withdrawal_confirmation();

-- Marketplace status is not physical handover evidence. Order status changes
-- may reconcile cancellations, but can no longer complete an assignment.
DROP TRIGGER merch_fulfillment_orders_reconcile_marking
  ON public.merch_fulfillment_orders;

CREATE OR REPLACE FUNCTION getomerch_marking.reconcile_jit_assignments_for_item(
  p_fulfillment_item_id uuid,
  p_actor_id text,
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE item_record record;
DECLARE assignment_record record;
DECLARE now_at timestamp with time zone := clock_timestamp();
DECLARE affected integer := 0;
BEGIN
  SELECT item.id, item.quantity, item.source_active,
    fulfillment_order.source_status
  INTO item_record
  FROM public.merch_fulfillment_order_items AS item
  JOIN public.merch_fulfillment_orders AS fulfillment_order
    ON fulfillment_order.id = item.fulfillment_order_id
  WHERE item.id = p_fulfillment_item_id
  FOR UPDATE OF item;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR assignment_record IN
    SELECT assignment.id, assignment.unit_ordinal,
      assignment.marking_unit_id, assignment.code_binding_id,
      binding.marking_code_id, binding.label_state, process.id AS process_id
    FROM public.merch_marking_assignments AS assignment
    JOIN public.merch_marking_code_bindings AS binding
      ON binding.id = assignment.code_binding_id
    LEFT JOIN public.merch_marking_processes AS process
      ON process.assignment_id = assignment.id
     AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
    WHERE assignment.fulfillment_item_id = item_record.id
      AND assignment.status = 'active'
      AND (NOT item_record.source_active
        OR assignment.unit_ordinal > item_record.quantity)
    ORDER BY assignment.unit_ordinal DESC, assignment.id
    FOR UPDATE OF assignment, binding
  LOOP
    IF assignment_record.label_state = 'not_rendered' THEN
      UPDATE public.merch_marking_assignments SET
        status = 'released', released_at = now_at,
        release_reason = coalesce(p_reason, 'fulfillment_item_reconciled'),
        revision = revision + 1, updated_at = now_at
      WHERE id = assignment_record.id;
      UPDATE public.merch_marking_code_bindings SET
        status = 'cancelled', updated_at = now_at
      WHERE id = assignment_record.code_binding_id;
      UPDATE public.merch_marking_units SET
        unit_state = 'cancelled', version = version + 1, updated_at = now_at
      WHERE id = assignment_record.marking_unit_id;
      UPDATE public.merch_marking_codes SET
        pool_state = 'available', revision = revision + 1, updated_at = now_at
      WHERE id = assignment_record.marking_code_id AND pool_state = 'reserved';
      UPDATE public.merch_marking_processes SET
        status = 'cancelled', current_step = 'assignment_reconciled',
        next_action = NULL, completed_at = now_at,
        version = version + 1, updated_at = now_at
      WHERE id = assignment_record.process_id;
    ELSE
      UPDATE public.merch_marking_assignments SET
        status = 'quarantined', released_at = now_at,
        release_reason = coalesce(p_reason, 'fulfillment_item_reconciled_after_render'),
        revision = revision + 1, updated_at = now_at
      WHERE id = assignment_record.id;
      UPDATE public.merch_marking_code_bindings SET
        status = 'cancelled', updated_at = now_at
      WHERE id = assignment_record.code_binding_id;
      UPDATE public.merch_marking_units SET
        unit_state = 'quarantined', version = version + 1, updated_at = now_at
      WHERE id = assignment_record.marking_unit_id;
      UPDATE public.merch_marking_codes SET
        pool_state = 'quarantined',
        blocked_reason = coalesce(p_reason, 'fulfillment_item_reconciled_after_render'),
        quarantined_at = now_at, quarantined_by = coalesce(p_actor_id, 'system'),
        revision = revision + 1, updated_at = now_at
      WHERE id = assignment_record.marking_code_id AND pool_state = 'reserved';
      UPDATE public.merch_marking_processes SET
        status = 'manual_review',
        current_step = 'assignment_reconciled_after_render',
        next_action = 'Определить судьбу сформированного КМ',
        manual_review_reason = coalesce(
          p_reason, 'fulfillment_item_reconciled_after_render'
        ), version = version + 1, updated_at = now_at
      WHERE id = assignment_record.process_id;
    END IF;

    INSERT INTO public.merch_marking_events (
      marking_code_id, marking_unit_id, code_binding_id, assignment_id,
      process_id, event_type, actor_type, actor_id, source,
      details_redacted, occurred_at
    ) VALUES (
      assignment_record.marking_code_id, assignment_record.marking_unit_id,
      assignment_record.code_binding_id, assignment_record.id,
      assignment_record.process_id, 'jit_assignment_reconciled', 'system',
      coalesce(p_actor_id, 'system'), 'fulfillment_projection',
      jsonb_build_object(
        'unitOrdinal', assignment_record.unit_ordinal,
        'quantity', item_record.quantity,
        'sourceActive', item_record.source_active,
        'sourceStatus', item_record.source_status,
        'labelState', assignment_record.label_state,
        'successfulHandoff', false,
        'reason', coalesce(p_reason, 'fulfillment_item_reconciled')
      ), now_at
    );
    affected := affected + 1;
  END LOOP;
  RETURN affected;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.reconcile_jit_order_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE item_record record;
BEGIN
  IF NEW.source_status IS DISTINCT FROM OLD.source_status
     AND NEW.source_status = ANY (ARRAY[
       'arbitration'::text, 'client_arbitration'::text,
       'not_accepted'::text, 'cancelled'::text
     ]) THEN
    FOR item_record IN
      SELECT item.id FROM public.merch_fulfillment_order_items AS item
      WHERE item.fulfillment_order_id = NEW.id ORDER BY item.id
    LOOP
      PERFORM getomerch_marking.reconcile_jit_assignments_for_item(
        item_record.id, 'fulfillment-trigger',
        'fulfillment_order_status:' || NEW.source_status
      );
    END LOOP;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER merch_fulfillment_orders_reconcile_marking
AFTER UPDATE OF source_status
ON public.merch_fulfillment_orders
FOR EACH ROW
EXECUTE FUNCTION getomerch_marking.reconcile_jit_order_trigger();

CREATE OR REPLACE VIEW getomerch_marking.document_safe
WITH (security_barrier = true)
AS
SELECT document.id, document.document_type, document.operation_mode,
  document.product_group, document.status, document.location_id,
  document.location_snapshot, document.revision, document.supersedes_document_id,
  document.idempotency_key, document.api_contract_version,
  document.payload_hash, document.signature_hash,
  document.certificate_thumbprint, document.external_document_id,
  document.response_redacted, document.error_code, document.error_message,
  document.attempt_count, document.created_by, document.request_id,
  document.created_at, document.updated_at, document.payload_built_at,
  document.signed_at, document.submitted_at, document.checked_at,
  document.accepted_at, document.rejected_at,
  introduction.circulation_state,
  introduction.raw_status AS circulation_raw_status,
  introduction.error_code AS circulation_error_code,
  introduction.error_message AS circulation_error_message,
  introduction.checked_at AS circulation_checked_at,
  introduction.confirmed_at AS circulation_confirmed_at,
  document.fulfillment_order_id, document.handover_id, document.process_id,
  withdrawal.withdrawal_state,
  withdrawal.error_code AS withdrawal_error_code,
  withdrawal.error_message AS withdrawal_error_message,
  withdrawal.checked_at AS withdrawal_checked_at,
  withdrawal.confirmed_at AS withdrawal_confirmed_at,
  handover.posting_number, handover.occurred_at AS handover_at,
  handover.withdrawal_deadline_at
FROM public.merch_marking_documents AS document
LEFT JOIN public.merch_marking_document_confirmations AS introduction
  ON introduction.document_id = document.id
LEFT JOIN public.merch_marking_withdrawal_confirmations AS withdrawal
  ON withdrawal.document_id = document.id
LEFT JOIN public.merch_marking_handovers AS handover
  ON handover.id = document.handover_id;

CREATE OR REPLACE VIEW getomerch_marking.document_code_safe
WITH (security_barrier = true)
AS
SELECT link.document_id, link.marking_code_id, link.marking_unit_id,
  link.assignment_id, link.gtin_snapshot, link.code_fingerprint,
  link.link_state, link.operation_result,
  link.error_code, link.error_message, code.crpt_state,
  assignment.external_posting_number, assignment.offer_id,
  assignment.unit_ordinal, link.created_at, link.updated_at,
  link.operation_kind
FROM public.merch_marking_document_codes AS link
JOIN public.merch_marking_codes AS code ON code.id = link.marking_code_id
JOIN getomerch_marking.assignment_safe AS assignment
  ON assignment.id = link.assignment_id;

CREATE VIEW getomerch_marking.shipping_handover_safe
WITH (security_barrier = true)
AS
SELECT handover.id, handover.fulfillment_order_id, handover.gate_evaluation_id,
  handover.posting_number, handover.handover_source,
  handover.evidence_version, handover.occurred_at,
  handover.withdrawal_deadline_at, handover.deadline_calendar_version,
  handover.recorded_by, handover.created_at,
  evaluation.mode AS gate_mode, evaluation.allowed AS gate_allowed,
  evaluation.blockers AS gate_blockers,
  document.id AS document_id, document.status AS document_status,
  document.revision AS document_revision,
  withdrawal.withdrawal_state,
  withdrawal.error_code AS withdrawal_error_code,
  withdrawal.error_message AS withdrawal_error_message,
  count(handover_unit.assignment_id)::integer AS unit_count
FROM public.merch_marking_handovers AS handover
JOIN public.merch_marking_shipping_gate_evaluations AS evaluation
  ON evaluation.id = handover.gate_evaluation_id
LEFT JOIN public.merch_marking_documents AS document
  ON document.handover_id = handover.id
 AND document.document_type = 'withdrawal_remote_sale'
 AND document.status <> 'superseded'
LEFT JOIN public.merch_marking_withdrawal_confirmations AS withdrawal
  ON withdrawal.document_id = document.id
LEFT JOIN public.merch_marking_handover_units AS handover_unit
  ON handover_unit.handover_id = handover.id
GROUP BY handover.id, evaluation.id, document.id, withdrawal.document_id;

CREATE OR REPLACE FUNCTION getomerch_marking.protect_handover_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'shipping handover history is append-only' USING ERRCODE = 'MZB40';
END
$function$;

CREATE TRIGGER merch_marking_shipping_gate_history_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_shipping_gate_evaluations
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_handover_history();
CREATE TRIGGER merch_marking_handovers_history_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_handovers
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_handover_history();
CREATE TRIGGER merch_marking_handover_units_history_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_handover_units
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_handover_history();

REVOKE ALL ON public.merch_marking_shipping_gate_evaluations,
  public.merch_marking_handovers,
  public.merch_marking_handover_units,
  public.merch_marking_withdrawal_confirmations
  FROM PUBLIC, getomerch_app;
GRANT SELECT ON public.merch_marking_shipping_gate_evaluations,
  public.merch_marking_handovers,
  public.merch_marking_handover_units,
  public.merch_marking_withdrawal_confirmations
  TO getomerch_backup;
REVOKE ALL ON getomerch_marking.shipping_handover_safe FROM PUBLIC;
GRANT SELECT ON getomerch_marking.shipping_handover_safe
  TO getomerch_app, getomerch_backup;

REVOKE ALL ON FUNCTION getomerch_marking.add_conservative_workdays(
  timestamp with time zone,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.evaluate_shipping_gate(
  uuid,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.prepare_withdrawal_document(
  uuid,text,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_shipping_handover(
  uuid,uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_withdrawal_document_material(
  uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_withdrawal_poll(
  uuid,text,jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_withdrawal_manual_review(
  uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.protect_handover_history()
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.add_conservative_workdays(
  timestamp with time zone,integer) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.evaluate_shipping_gate(
  uuid,text,text,uuid) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.prepare_withdrawal_document(
  uuid,text,uuid,boolean) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_shipping_handover(
  uuid,uuid,text,uuid,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.get_withdrawal_document_material(
  uuid,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_withdrawal_poll(
  uuid,text,jsonb,text,text,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_withdrawal_manual_review(
  uuid,text,text,text) TO getomerch_app;

COMMENT ON TABLE public.merch_marking_handovers IS
  'Immutable operator-confirmed physical Ozon FBS handovers; marketplace statuses are not handover evidence.';
COMMENT ON TABLE public.merch_marking_shipping_gate_evaluations IS
  'Append-only server-side marking readiness evaluations made before inventory mutation.';
COMMENT ON FUNCTION getomerch_marking.add_conservative_workdays(
  timestamp with time zone,integer) IS
  'Conservative Monday-Friday SLA. It never extends a deadline for public holidays and is intentionally earlier than or equal to the legal calendar deadline.';
