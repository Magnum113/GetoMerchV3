-- Stage 12: versioned Ozon return cases, LP_RETURN documents and explicit
-- seller/FBO custody transitions. External return data is evidence, not an
-- instruction to mutate CRPT or inventory.

ALTER TABLE public.merch_marking_units
  DROP CONSTRAINT merch_marking_units_custody_check,
  ADD CONSTRAINT merch_marking_units_custody_check CHECK (
    custody_state = ANY (ARRAY[
      'getomerch'::text, 'ozon'::text, 'ozon_fbo'::text, 'carrier'::text,
      'customer'::text, 'unknown'::text
    ])
  );

CREATE TABLE public.merch_marking_return_cases (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    source text DEFAULT 'ozon_fbs'::text NOT NULL,
    source_return_id text NOT NULL,
    source_return_item_id text NOT NULL,
    original_fulfillment_order_id uuid
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
    original_assignment_id uuid
      REFERENCES public.merch_marking_assignments(id) ON DELETE RESTRICT,
    handover_id uuid
      REFERENCES public.merch_marking_handovers(id) ON DELETE RESTRICT,
    marking_unit_id uuid
      REFERENCES public.merch_marking_units(id) ON DELETE RESTRICT,
    marking_code_id uuid
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    posting_number text NOT NULL,
    offer_id text,
    ozon_sku text,
    quantity integer NOT NULL,
    return_kind text DEFAULT 'unknown'::text NOT NULL,
    destination text DEFAULT 'unknown'::text NOT NULL,
    source_status text NOT NULL,
    process_status text DEFAULT 'detected'::text NOT NULL,
    paid boolean,
    source_snapshot_hash text NOT NULL,
    source_contract_version text NOT NULL,
    source_evidence_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    detected_at timestamp with time zone NOT NULL,
    source_observed_at timestamp with time zone,
    direction_confirmed_at timestamp with time zone,
    direction_confirmed_by text,
    seller_received_at timestamp with time zone,
    seller_received_by text,
    physical_condition text,
    receiving_warehouse_id uuid
      REFERENCES public.merch_warehouses(id) ON DELETE RESTRICT,
    inventory_transaction_id uuid
      REFERENCES public.merch_transactions(id) ON DELETE RESTRICT,
    fbo_intake_reference text,
    edo_document_reference text,
    fbo_transfer_confirmed_at timestamp with time zone,
    fbo_transfer_confirmed_by text,
    manual_review_reason text,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    UNIQUE (source, source_return_id, source_return_item_id),
    CONSTRAINT merch_marking_return_source_check
      CHECK (source = 'ozon_fbs'),
    CONSTRAINT merch_marking_return_source_id_check CHECK (
      length(source_return_id) BETWEEN 1 AND 300
      AND length(source_return_item_id) BETWEEN 1 AND 500
    ),
    CONSTRAINT merch_marking_return_posting_check
      CHECK (length(posting_number) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_return_offer_check
      CHECK (offer_id IS NULL OR length(offer_id) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_return_sku_check
      CHECK (ozon_sku IS NULL OR length(ozon_sku) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_return_quantity_check CHECK (quantity > 0),
    CONSTRAINT merch_marking_return_kind_check CHECK (return_kind = ANY (ARRAY[
      'cancel_before_handover'::text, 'return_to_seller'::text,
      'not_picked_up_to_seller'::text, 'to_ozon_fbo'::text,
      'fbo_return_to_seller'::text, 'unknown'::text
    ])),
    CONSTRAINT merch_marking_return_destination_check CHECK (destination = ANY (ARRAY[
      'unknown'::text, 'to_seller'::text, 'to_ozon_fbo'::text,
      'lost_destroyed'::text
    ])),
    CONSTRAINT merch_marking_return_process_check CHECK (process_status = ANY (ARRAY[
      'detected'::text, 'manual_review'::text, 'direction_confirmed'::text,
      'awaiting_withdrawal'::text, 'return_prepared'::text,
      'return_processing'::text, 'in_circulation'::text,
      'awaiting_physical_receipt'::text, 'awaiting_fbo_evidence'::text,
      'completed'::text, 'cancelled'::text
    ])),
    CONSTRAINT merch_marking_return_identity_check CHECK (
      (original_assignment_id IS NULL AND handover_id IS NULL
        AND marking_unit_id IS NULL AND marking_code_id IS NULL)
      OR
      (original_fulfillment_order_id IS NOT NULL
        AND original_assignment_id IS NOT NULL AND handover_id IS NOT NULL
        AND marking_unit_id IS NOT NULL AND marking_code_id IS NOT NULL
        AND quantity = 1)
    ),
    CONSTRAINT merch_marking_return_source_status_check
      CHECK (length(source_status) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_return_hash_check
      CHECK (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_return_contract_check
      CHECK (length(source_contract_version) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_return_evidence_check CHECK (
      jsonb_typeof(source_evidence_redacted) = 'object'
      AND octet_length(source_evidence_redacted::text) <= 32768
      AND NOT (source_evidence_redacted ?| ARRAY[
        'cis', 'ki', 'mark', 'markingCode', 'signature', 'token',
        'authorization', 'product_document'
      ])
    ),
    CONSTRAINT merch_marking_return_direction_check CHECK (
      (destination = 'unknown' AND direction_confirmed_at IS NULL
        AND direction_confirmed_by IS NULL AND paid IS NULL)
      OR
      (destination <> 'unknown' AND direction_confirmed_at IS NOT NULL
        AND direction_confirmed_by IS NOT NULL AND paid IS NOT NULL)
    ),
    CONSTRAINT merch_marking_return_receipt_check CHECK (
      (seller_received_at IS NULL AND seller_received_by IS NULL
        AND physical_condition IS NULL AND receiving_warehouse_id IS NULL
        AND inventory_transaction_id IS NULL)
      OR
      (destination = 'to_seller' AND seller_received_at IS NOT NULL
        AND seller_received_by IS NOT NULL AND physical_condition IS NOT NULL
        AND receiving_warehouse_id IS NOT NULL
        AND ((physical_condition = 'intact' AND inventory_transaction_id IS NOT NULL)
          OR (physical_condition <> 'intact' AND inventory_transaction_id IS NULL)))
    ),
    CONSTRAINT merch_marking_return_condition_check CHECK (
      physical_condition IS NULL OR physical_condition = ANY (ARRAY[
        'intact'::text, 'relabel_same_code'::text,
        'remark_required'::text, 'destroy_pending'::text
      ])
    ),
    CONSTRAINT merch_marking_return_fbo_check CHECK (
      (fbo_transfer_confirmed_at IS NULL AND fbo_transfer_confirmed_by IS NULL
        AND edo_document_reference IS NULL)
      OR
      (destination = 'to_ozon_fbo' AND fbo_transfer_confirmed_at IS NOT NULL
        AND fbo_transfer_confirmed_by IS NOT NULL
        AND fbo_intake_reference IS NOT NULL
        AND edo_document_reference IS NOT NULL)
    ),
    CONSTRAINT merch_marking_return_fbo_ref_check CHECK (
      (fbo_intake_reference IS NULL OR length(fbo_intake_reference) BETWEEN 1 AND 300)
      AND (edo_document_reference IS NULL OR length(edo_document_reference) BETWEEN 1 AND 300)
    ),
    CONSTRAINT merch_marking_return_actor_check CHECK (
      (direction_confirmed_by IS NULL OR length(direction_confirmed_by) BETWEEN 1 AND 200)
      AND (seller_received_by IS NULL OR length(seller_received_by) BETWEEN 1 AND 200)
      AND (fbo_transfer_confirmed_by IS NULL OR length(fbo_transfer_confirmed_by) BETWEEN 1 AND 200)
    ),
    CONSTRAINT merch_marking_return_review_check CHECK (
      manual_review_reason IS NULL OR length(manual_review_reason) BETWEEN 1 AND 1000
    ),
    CONSTRAINT merch_marking_return_version_check CHECK (version >= 1)
);

CREATE INDEX merch_marking_return_cases_status
  ON public.merch_marking_return_cases (process_status, updated_at DESC, id DESC);
CREATE INDEX merch_marking_return_cases_order
  ON public.merch_marking_return_cases (original_fulfillment_order_id, updated_at DESC)
  WHERE original_fulfillment_order_id IS NOT NULL;
CREATE INDEX merch_marking_return_cases_unit
  ON public.merch_marking_return_cases (marking_unit_id, updated_at DESC)
  WHERE marking_unit_id IS NOT NULL;

CREATE TABLE public.merch_marking_return_case_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    return_case_id uuid NOT NULL
      REFERENCES public.merch_marking_return_cases(id) ON DELETE RESTRICT,
    event_type text NOT NULL,
    case_version bigint NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    source text NOT NULL,
    details_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_return_event_type_check
      CHECK (length(event_type) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_return_event_version_check CHECK (case_version >= 1),
    CONSTRAINT merch_marking_return_event_actor_check CHECK (
      actor_type = ANY (ARRAY['system'::text, 'worker'::text, 'operator'::text])
      AND (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 200)
    ),
    CONSTRAINT merch_marking_return_event_source_check
      CHECK (length(source) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_return_event_details_check CHECK (
      jsonb_typeof(details_redacted) = 'object'
      AND octet_length(details_redacted::text) <= 32768
      AND NOT (details_redacted ?| ARRAY[
        'cis', 'ki', 'mark', 'markingCode', 'signature', 'token',
        'authorization', 'product_document'
      ])
    )
);

CREATE INDEX merch_marking_return_events_case
  ON public.merch_marking_return_case_events (return_case_id, id DESC);

ALTER TABLE public.merch_marking_documents
  DROP CONSTRAINT merch_marking_documents_type_check,
  DROP CONSTRAINT merch_marking_documents_mode_check,
  DROP CONSTRAINT merch_marking_documents_type_mode_check,
  ADD COLUMN return_case_id uuid
    REFERENCES public.merch_marking_return_cases(id) ON DELETE RESTRICT,
  ADD CONSTRAINT merch_marking_documents_type_check CHECK (
    document_type = ANY (ARRAY[
      'introduction'::text, 'withdrawal_remote_sale'::text,
      'return_to_circulation'::text
    ])
  ),
  ADD CONSTRAINT merch_marking_documents_mode_check CHECK (
    operation_mode = ANY (ARRAY[
      'own_production'::text, 'distance_sale'::text,
      'remote_sale_return'::text
    ])
  ),
  ADD CONSTRAINT merch_marking_documents_type_mode_check CHECK (
    (document_type = 'introduction' AND operation_mode = 'own_production'
      AND fulfillment_order_id IS NULL AND handover_id IS NULL
      AND return_case_id IS NULL)
    OR
    (document_type = 'withdrawal_remote_sale' AND operation_mode = 'distance_sale'
      AND fulfillment_order_id IS NOT NULL AND handover_id IS NOT NULL
      AND process_id IS NOT NULL AND return_case_id IS NULL)
    OR
    (document_type = 'return_to_circulation'
      AND operation_mode = 'remote_sale_return'
      AND fulfillment_order_id IS NOT NULL AND handover_id IS NOT NULL
      AND process_id IS NOT NULL AND return_case_id IS NOT NULL)
  );

CREATE UNIQUE INDEX merch_marking_documents_active_return_case
  ON public.merch_marking_documents (return_case_id)
  WHERE return_case_id IS NOT NULL AND status <> 'superseded';

ALTER TABLE public.merch_marking_document_codes
  DROP CONSTRAINT merch_marking_document_codes_operation_check,
  ADD CONSTRAINT merch_marking_document_codes_operation_check CHECK (
    operation_kind = ANY (ARRAY[
      'introduction'::text, 'withdrawal'::text, 'return_to_circulation'::text
    ])
  );

DROP INDEX merch_marking_document_codes_active_assignment_operation;
DROP INDEX merch_marking_document_codes_active_code_operation;
CREATE UNIQUE INDEX merch_marking_document_codes_active_assignment_operation
  ON public.merch_marking_document_codes (assignment_id, operation_kind)
  WHERE link_state = 'active' AND operation_kind <> 'return_to_circulation';
CREATE UNIQUE INDEX merch_marking_document_codes_active_code_operation
  ON public.merch_marking_document_codes (marking_code_id, operation_kind)
  WHERE link_state = 'active' AND operation_kind <> 'return_to_circulation';

CREATE TABLE public.merch_marking_return_confirmations (
    document_id uuid PRIMARY KEY
      REFERENCES public.merch_marking_documents(id) ON DELETE RESTRICT,
    return_state text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    error_message text,
    checked_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_return_confirmation_state_check CHECK (
      return_state = ANY (ARRAY[
        'pending'::text, 'confirmed'::text, 'requires_manual_review'::text
      ])
    ),
    CONSTRAINT merch_marking_return_confirmation_error_check CHECK (
      (return_state = 'requires_manual_review'
        AND error_code IS NOT NULL AND error_message IS NOT NULL)
      OR
      (return_state <> 'requires_manual_review'
        AND error_code IS NULL AND error_message IS NULL)
    ),
    CONSTRAINT merch_marking_return_confirmation_time_check CHECK (
      (return_state = 'confirmed' AND confirmed_at IS NOT NULL)
      OR (return_state <> 'confirmed' AND confirmed_at IS NULL)
    )
);

CREATE OR REPLACE FUNCTION getomerch_marking.upsert_ozon_return_case(
  p_source_return_id text,
  p_source_return_item_id text,
  p_posting_number text,
  p_offer_id text,
  p_ozon_sku text,
  p_quantity integer,
  p_return_kind text,
  p_source_status text,
  p_source_snapshot_hash text,
  p_source_contract_version text,
  p_source_evidence_redacted jsonb,
  p_source_observed_at timestamp with time zone,
  p_actor_id text
)
RETURNS TABLE (return_case_id uuid, case_version bigint, process_status text, identity_linked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE order_id_value uuid;
DECLARE matched record;
DECLARE match_count integer := 0;
DECLARE current_record record;
DECLARE created_id uuid;
DECLARE next_status text;
DECLARE next_version bigint;
BEGIN
  IF p_source_return_id IS NULL OR length(p_source_return_id) NOT BETWEEN 1 AND 300
     OR p_source_return_item_id IS NULL OR length(p_source_return_item_id) NOT BETWEEN 1 AND 500
     OR p_posting_number IS NULL OR length(p_posting_number) NOT BETWEEN 1 AND 300
     OR p_quantity < 1 OR p_source_status IS NULL
     OR p_return_kind <> ALL (ARRAY[
       'cancel_before_handover'::text, 'return_to_seller'::text,
       'not_picked_up_to_seller'::text, 'to_ozon_fbo'::text,
       'fbo_return_to_seller'::text, 'unknown'::text])
     OR p_source_snapshot_hash !~ '^[0-9a-f]{64}$'
     OR p_source_contract_version IS NULL
     OR jsonb_typeof(p_source_evidence_redacted) <> 'object'
     OR octet_length(p_source_evidence_redacted::text) > 32768
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Ozon return evidence' USING ERRCODE = 'MZC01';
  END IF;
  IF p_source_evidence_redacted ?| ARRAY[
    'cis', 'ki', 'mark', 'markingCode', 'signature', 'token',
    'authorization', 'product_document'
  ] THEN
    RAISE EXCEPTION 'sensitive Ozon return evidence is forbidden' USING ERRCODE = 'MZC01';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'marking-return:ozon_fbs:' || p_source_return_id || ':' || p_source_return_item_id, 0));

  SELECT NULL::uuid AS assignment_id, NULL::uuid AS handover_id,
    NULL::uuid AS marking_unit_id, NULL::uuid AS marking_code_id
  INTO matched;

  SELECT fulfillment_order.id INTO order_id_value
  FROM public.merch_fulfillment_orders AS fulfillment_order
  WHERE fulfillment_order.source_channel = 'ozon_fbs'
    AND fulfillment_order.external_posting_number = p_posting_number;

  IF order_id_value IS NOT NULL AND p_quantity = 1 THEN
    SELECT count(*)::integer INTO match_count
    FROM public.merch_fulfillment_order_items AS item
    JOIN public.merch_marking_assignments AS assignment
      ON assignment.fulfillment_item_id = item.id
     AND assignment.status = 'completed'
    JOIN public.merch_marking_handover_units AS handover_unit
      ON handover_unit.assignment_id = assignment.id
    JOIN public.merch_marking_handovers AS handover
      ON handover.id = handover_unit.handover_id
     AND handover.fulfillment_order_id = item.fulfillment_order_id
    WHERE item.fulfillment_order_id = order_id_value
      AND ((p_offer_id IS NOT NULL AND item.offer_id = p_offer_id)
        OR (p_ozon_sku IS NOT NULL AND item.external_product_id = p_ozon_sku));
    IF match_count = 1 THEN
      SELECT assignment.id AS assignment_id, handover.id AS handover_id,
        assignment.marking_unit_id, handover_unit.marking_code_id
      INTO matched
      FROM public.merch_fulfillment_order_items AS item
      JOIN public.merch_marking_assignments AS assignment
        ON assignment.fulfillment_item_id = item.id
       AND assignment.status = 'completed'
      JOIN public.merch_marking_handover_units AS handover_unit
        ON handover_unit.assignment_id = assignment.id
      JOIN public.merch_marking_handovers AS handover
        ON handover.id = handover_unit.handover_id
       AND handover.fulfillment_order_id = item.fulfillment_order_id
      WHERE item.fulfillment_order_id = order_id_value
        AND ((p_offer_id IS NOT NULL AND item.offer_id = p_offer_id)
          OR (p_ozon_sku IS NOT NULL AND item.external_product_id = p_ozon_sku));
    END IF;
  END IF;
  next_status := CASE
    WHEN p_return_kind = 'cancel_before_handover' AND matched.assignment_id IS NULL
      THEN 'cancelled'
    WHEN matched.assignment_id IS NULL THEN 'manual_review'
    ELSE 'detected'
  END;

  SELECT return_case.id, return_case.version, return_case.source_snapshot_hash,
    return_case.process_status, return_case.original_assignment_id
  INTO current_record
  FROM public.merch_marking_return_cases AS return_case
  WHERE return_case.source = 'ozon_fbs'
    AND return_case.source_return_id = p_source_return_id
    AND return_case.source_return_item_id = p_source_return_item_id
  FOR UPDATE;
  IF FOUND THEN
    IF current_record.source_snapshot_hash = p_source_snapshot_hash THEN
      RETURN QUERY SELECT current_record.id, current_record.version,
        current_record.process_status, current_record.original_assignment_id IS NOT NULL;
      RETURN;
    END IF;
    UPDATE public.merch_marking_return_cases SET
      source_status = left(p_source_status, 300),
      return_kind = p_return_kind,
      offer_id = p_offer_id,
      ozon_sku = p_ozon_sku,
      quantity = p_quantity,
      source_snapshot_hash = p_source_snapshot_hash,
      source_contract_version = p_source_contract_version,
      source_evidence_redacted = p_source_evidence_redacted,
      source_observed_at = p_source_observed_at,
      original_fulfillment_order_id = coalesce(original_fulfillment_order_id, order_id_value),
      original_assignment_id = coalesce(original_assignment_id, matched.assignment_id),
      handover_id = coalesce(handover_id, matched.handover_id),
      marking_unit_id = coalesce(marking_unit_id, matched.marking_unit_id),
      marking_code_id = coalesce(marking_code_id, matched.marking_code_id),
      process_status = CASE
        WHEN destination <> 'unknown' OR process_status <> ALL (
          ARRAY['detected'::text, 'manual_review'::text, 'cancelled'::text])
          THEN process_status
        WHEN coalesce(original_assignment_id, matched.assignment_id) IS NULL
          THEN 'manual_review'
        ELSE 'detected'
      END,
      manual_review_reason = CASE
        WHEN coalesce(original_assignment_id, matched.assignment_id) IS NULL
          THEN 'Ozon return cannot be linked to exactly one serialized handover unit'
        ELSE manual_review_reason
      END,
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = current_record.id
    RETURNING version, process_status INTO next_version, next_status;
    INSERT INTO public.merch_marking_return_case_events (
      return_case_id, event_type, case_version, actor_type, actor_id, source,
      details_redacted
    ) VALUES (
      current_record.id, 'ozon_return_evidence_updated', next_version,
      'worker', p_actor_id, 'ozon_returns_sync',
      jsonb_build_object('sourceStatus', left(p_source_status, 300),
        'contractVersion', p_source_contract_version,
        'snapshotHash', p_source_snapshot_hash)
    );
    RETURN QUERY SELECT current_record.id, next_version, next_status,
      coalesce(current_record.original_assignment_id, matched.assignment_id) IS NOT NULL;
    RETURN;
  END IF;

  INSERT INTO public.merch_marking_return_cases (
    source_return_id, source_return_item_id, original_fulfillment_order_id,
    original_assignment_id, handover_id, marking_unit_id, marking_code_id,
    posting_number, offer_id, ozon_sku, quantity, return_kind, source_status,
    process_status, source_snapshot_hash, source_contract_version,
    source_evidence_redacted, detected_at, source_observed_at,
    manual_review_reason
  ) VALUES (
    p_source_return_id, p_source_return_item_id, order_id_value,
    matched.assignment_id, matched.handover_id, matched.marking_unit_id,
    matched.marking_code_id, p_posting_number, p_offer_id, p_ozon_sku,
    p_quantity, p_return_kind, left(p_source_status, 300), next_status,
    p_source_snapshot_hash, p_source_contract_version,
    p_source_evidence_redacted, clock_timestamp(), p_source_observed_at,
    CASE WHEN matched.assignment_id IS NULL AND next_status = 'manual_review'
      THEN 'Ozon return cannot be linked to exactly one serialized handover unit'
      ELSE NULL END
  ) RETURNING id, version INTO created_id, next_version;
  INSERT INTO public.merch_marking_return_case_events (
    return_case_id, event_type, case_version, actor_type, actor_id, source,
    details_redacted
  ) VALUES (
    created_id, 'ozon_return_detected', next_version, 'worker', p_actor_id,
    'ozon_returns_sync',
    jsonb_build_object('returnKind', p_return_kind, 'sourceStatus', left(p_source_status, 300),
      'identityLinked', matched.assignment_id IS NOT NULL,
      'contractVersion', p_source_contract_version,
      'snapshotHash', p_source_snapshot_hash)
  );
  RETURN QUERY SELECT created_id, next_version, next_status,
    matched.assignment_id IS NOT NULL;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.confirm_return_direction(
  p_return_case_id uuid,
  p_expected_version bigint,
  p_destination text,
  p_paid boolean,
  p_actor_id text,
  p_request_id uuid
)
RETURNS TABLE (return_case_id uuid, case_version bigint, process_status text, destination text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record public.merch_marking_return_cases%ROWTYPE;
DECLARE next_status text;
BEGIN
  IF p_return_case_id IS NULL OR p_expected_version < 1
     OR p_destination <> ALL (ARRAY['to_seller'::text, 'to_ozon_fbo'::text])
     OR p_paid IS NULL OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid return direction confirmation' USING ERRCODE = 'MZC10';
  END IF;
  SELECT * INTO current_record FROM public.merch_marking_return_cases
  WHERE id = p_return_case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'return case not found' USING ERRCODE = 'MZC11'; END IF;
  IF current_record.version <> p_expected_version THEN
    RAISE EXCEPTION 'return case version conflict' USING ERRCODE = 'MZC12';
  END IF;
  IF current_record.original_assignment_id IS NULL OR current_record.handover_id IS NULL
     OR current_record.marking_unit_id IS NULL OR current_record.marking_code_id IS NULL THEN
    RAISE EXCEPTION 'return identity is ambiguous' USING ERRCODE = 'MZC13';
  END IF;
  IF current_record.seller_received_at IS NOT NULL
     OR current_record.fbo_transfer_confirmed_at IS NOT NULL
     OR current_record.process_status = 'completed' THEN
    RAISE EXCEPTION 'completed return direction is immutable' USING ERRCODE = 'MZC14';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.merch_marking_documents AS document
    WHERE document.return_case_id = p_return_case_id
      AND document.status = ANY (ARRAY[
        'submitting'::text, 'processing'::text])
  ) THEN
    RAISE EXCEPTION 'return direction cannot change during CRPT submission'
      USING ERRCODE = 'MZC15';
  END IF;
  IF current_record.paid IS DISTINCT FROM p_paid AND EXISTS (
    SELECT 1 FROM public.merch_marking_documents AS document
    WHERE document.return_case_id = p_return_case_id
      AND document.status = ANY (ARRAY[
        'payload_built'::text, 'signed'::text, 'submitting'::text,
        'processing'::text, 'accepted'::text])
  ) THEN
    RAISE EXCEPTION 'paid state is immutable after LP_RETURN payload creation'
      USING ERRCODE = 'MZC16';
  END IF;
  next_status := CASE
    WHEN current_record.process_status = ANY (ARRAY[
      'in_circulation'::text, 'awaiting_physical_receipt'::text,
      'awaiting_fbo_evidence'::text]) AND p_destination = 'to_seller'
      THEN 'awaiting_physical_receipt'
    WHEN current_record.process_status = ANY (ARRAY[
      'in_circulation'::text, 'awaiting_physical_receipt'::text,
      'awaiting_fbo_evidence'::text]) AND p_destination = 'to_ozon_fbo'
      THEN 'awaiting_fbo_evidence'
    ELSE 'direction_confirmed'
  END;
  UPDATE public.merch_marking_return_cases SET
    destination = p_destination, paid = p_paid,
    direction_confirmed_at = clock_timestamp(), direction_confirmed_by = p_actor_id,
    process_status = next_status, manual_review_reason = NULL,
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = p_return_case_id;
  INSERT INTO public.merch_marking_return_case_events (
    return_case_id, event_type, case_version, actor_type, actor_id, source,
    details_redacted
  ) VALUES (
    p_return_case_id,
    CASE WHEN current_record.destination <> 'unknown'
      AND current_record.destination <> p_destination
      THEN 'return_destination_changed' ELSE 'return_destination_confirmed' END,
    current_record.version + 1, 'operator', p_actor_id, 'admin',
    jsonb_build_object('from', current_record.destination, 'to', p_destination,
      'paid', p_paid, 'requestId', p_request_id)
  );
  RETURN QUERY SELECT p_return_case_id, current_record.version + 1,
    next_status, p_destination;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.prepare_return_document(
  p_return_case_id uuid,
  p_actor_id text,
  p_request_id uuid,
  p_force_correction boolean DEFAULT false
)
RETURNS TABLE (
  document_id uuid, document_status text, document_revision integer,
  reused boolean, no_op boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE case_record record;
DECLARE withdrawal_record record;
DECLARE existing_record record;
DECLARE process_id_value uuid;
DECLARE created_id uuid;
DECLARE next_revision integer := 1;
DECLARE fresh_in_circulation boolean := false;
BEGIN
  IF p_return_case_id IS NULL OR p_request_id IS NULL OR p_force_correction IS NULL
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid return document request' USING ERRCODE = 'MZC20';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'marking-return-document:' || p_return_case_id::text, 0));
  SELECT return_case.*, code.crpt_state, assignment.code_binding_id,
    item.offer_id, item.id AS fulfillment_item_id
  INTO case_record
  FROM public.merch_marking_return_cases AS return_case
  JOIN public.merch_marking_codes AS code ON code.id = return_case.marking_code_id
  JOIN public.merch_marking_assignments AS assignment
    ON assignment.id = return_case.original_assignment_id
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  WHERE return_case.id = p_return_case_id
  FOR UPDATE OF return_case, code;
  IF NOT FOUND THEN RAISE EXCEPTION 'linked return case not found' USING ERRCODE = 'MZC11'; END IF;
  IF case_record.destination = 'unknown' OR case_record.paid IS NULL THEN
    RAISE EXCEPTION 'return direction is not confirmed' USING ERRCODE = 'MZC21';
  END IF;
  IF case_record.destination = 'lost_destroyed' THEN
    RAISE EXCEPTION 'lost or destroyed return needs manual disposition' USING ERRCODE = 'MZC21';
  END IF;

  SELECT document.id, document.status, document.location_id,
    document.location_snapshot, confirmation.withdrawal_state
  INTO withdrawal_record
  FROM public.merch_marking_documents AS document
  LEFT JOIN public.merch_marking_withdrawal_confirmations AS confirmation
    ON confirmation.document_id = document.id
  WHERE document.handover_id = case_record.handover_id
    AND document.document_type = 'withdrawal_remote_sale'
    AND document.status <> 'superseded'
  ORDER BY document.revision DESC LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.merch_marking_crpt_queries AS query
    WHERE query.marking_code_id = case_record.marking_code_id
      AND query.query_type = 'code_status' AND query.status = 'succeeded'
      AND query.normalized_status = 'in_circulation'
      AND query.owner_matches IS TRUE AND query.gtin_matches IS TRUE
      AND query.checked_at >= clock_timestamp() - interval '24 hours'
  ) INTO fresh_in_circulation;

  IF (withdrawal_record.id IS NULL
      OR withdrawal_record.status <> 'accepted'
      OR withdrawal_record.withdrawal_state <> 'confirmed') THEN
    IF case_record.crpt_state = 'in_circulation' AND fresh_in_circulation THEN
      UPDATE public.merch_marking_return_cases SET
        process_status = CASE destination WHEN 'to_seller'
          THEN 'awaiting_physical_receipt' ELSE 'awaiting_fbo_evidence' END,
        manual_review_reason = NULL, version = version + 1,
        updated_at = clock_timestamp()
      WHERE id = p_return_case_id;
      INSERT INTO public.merch_marking_return_case_events (
        return_case_id, event_type, case_version, actor_type, actor_id, source,
        details_redacted
      ) VALUES (
        p_return_case_id, 'return_to_circulation_noop', case_record.version + 1,
        'worker', p_actor_id, 'marking_crpt_return',
        jsonb_build_object('reason', 'fresh_crpt_state_in_circulation')
      );
      RETURN QUERY SELECT NULL::uuid, 'accepted'::text, 0, false, true;
      RETURN;
    END IF;
    UPDATE public.merch_marking_return_cases SET
      process_status = 'awaiting_withdrawal',
      manual_review_reason = 'Original remote-sale withdrawal is not terminal and accepted',
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = p_return_case_id;
    RAISE EXCEPTION 'original withdrawal must be reconciled first' USING ERRCODE = 'MZC22';
  END IF;
  IF case_record.crpt_state <> 'withdrawn' THEN
    RAISE EXCEPTION 'withdrawal evidence and current KM state disagree' USING ERRCODE = 'MZC23';
  END IF;

  SELECT document.id, document.status, document.revision, document.error_code
  INTO existing_record
  FROM public.merch_marking_documents AS document
  WHERE document.return_case_id = p_return_case_id
    AND document.document_type = 'return_to_circulation'
    AND document.status <> 'superseded'
  FOR UPDATE;
  IF FOUND AND NOT p_force_correction THEN
    RETURN QUERY SELECT existing_record.id, existing_record.status,
      existing_record.revision, true, false;
    RETURN;
  END IF;
  IF FOUND THEN
    IF existing_record.status <> ALL (
      ARRAY['rejected'::text, 'requires_manual_review'::text])
       OR existing_record.error_code = 'crpt_submit_outcome_unknown' THEN
      RAISE EXCEPTION 'return document cannot be superseded' USING ERRCODE = 'MZC24';
    END IF;
    next_revision := existing_record.revision + 1;
    UPDATE public.merch_marking_document_codes SET
      link_state = 'superseded', updated_at = clock_timestamp()
    WHERE document_id = existing_record.id;
    UPDATE public.merch_marking_documents SET
      status = 'superseded', updated_at = clock_timestamp()
    WHERE id = existing_record.id;
  END IF;

  INSERT INTO public.merch_marking_processes (
    process_type, status, fulfillment_order_id, fulfillment_item_id,
    marking_unit_id, assignment_id, source, source_key, priority,
    current_step, next_action, owner
  ) VALUES (
    'fbs_return_to_circulation', 'waiting_external',
    case_record.original_fulfillment_order_id, case_record.fulfillment_item_id,
    case_record.marking_unit_id, case_record.original_assignment_id,
    'ozon_return_case', p_return_case_id::text, 100,
    'return_document_draft', 'Подписать и отправить возврат КМ в оборот', p_actor_id
  ) ON CONFLICT (process_type, source, source_key)
    WHERE status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
    DO UPDATE SET status = 'waiting_external',
      current_step = 'return_document_draft',
      next_action = 'Подписать и отправить возврат КМ в оборот',
      manual_review_reason = NULL, version = merch_marking_processes.version + 1,
      updated_at = clock_timestamp()
  RETURNING id INTO process_id_value;

  INSERT INTO public.merch_marking_documents (
    document_type, operation_mode, location_id, location_snapshot,
    fulfillment_order_id, handover_id, process_id, return_case_id, revision,
    supersedes_document_id, idempotency_key, api_contract_version,
    created_by, request_id
  ) VALUES (
    'return_to_circulation', 'remote_sale_return', withdrawal_record.location_id,
    withdrawal_record.location_snapshot, case_record.original_fulfillment_order_id,
    case_record.handover_id, process_id_value, p_return_case_id, next_revision,
    CASE WHEN existing_record.id IS NULL THEN NULL ELSE existing_record.id END,
    'lp-return:' || p_return_case_id::text || ':r' || next_revision::text,
    'true-api-lp-return-v649.0-2026-04-15', p_actor_id, p_request_id
  ) RETURNING id INTO created_id;
  INSERT INTO public.merch_marking_document_codes (
    document_id, marking_code_id, marking_unit_id, assignment_id,
    gtin_snapshot, code_fingerprint, operation_kind
  )
  SELECT created_id, case_record.marking_code_id, case_record.marking_unit_id,
    case_record.original_assignment_id, assignment.gtin_snapshot,
    code.fingerprint, 'return_to_circulation'
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_codes AS code ON code.id = case_record.marking_code_id
  WHERE assignment.id = case_record.original_assignment_id;
  INSERT INTO public.merch_marking_return_confirmations (document_id)
  VALUES (created_id);
  UPDATE public.merch_marking_return_cases SET
    process_status = 'return_prepared', manual_review_reason = NULL,
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = p_return_case_id;
  INSERT INTO public.merch_marking_return_case_events (
    return_case_id, event_type, case_version, actor_type, actor_id, source,
    details_redacted
  ) VALUES (
    p_return_case_id, 'crpt_return_draft_created', case_record.version + 1,
    'worker', p_actor_id, 'marking_crpt_return',
    jsonb_build_object('documentId', created_id, 'revision', next_revision,
      'documentType', 'LP_RETURN', 'returnType', 'REMOTE_SALE_RETURN')
  );
  RETURN QUERY SELECT created_id, 'draft'::text, next_revision, false, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.get_return_document_material(
  p_document_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  document_id uuid, document_status text, api_contract_version text,
  return_case_id uuid, source_return_id text, posting_number text,
  action_date date, paid boolean, code_fingerprint text, gtin text,
  offer_id text, code_ciphertext bytea, code_nonce bytea,
  code_auth_tag bytea, code_key_version integer, payload_hash text,
  payload_ciphertext bytea, payload_nonce bytea, payload_auth_tag bytea,
  payload_key_version integer, signature_hash text,
  signature_ciphertext bytea, signature_nonce bytea,
  signature_auth_tag bytea, signature_key_version integer,
  external_document_id text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_document_id IS NULL OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid return material request' USING ERRCODE = 'MZC25';
  END IF;
  RETURN QUERY
  SELECT document.id, document.status, document.api_contract_version,
    return_case.id, return_case.source_return_id, return_case.posting_number,
    coalesce(return_case.source_observed_at, return_case.detected_at)::date,
    return_case.paid, link.code_fingerprint, link.gtin_snapshot,
    item.offer_id, code.code_ciphertext, code.code_nonce,
    code.code_auth_tag, code.encryption_key_version,
    document.payload_hash, document.payload_ciphertext, document.payload_nonce,
    document.payload_auth_tag, document.payload_key_version,
    document.signature_hash, document.signature_ciphertext,
    document.signature_nonce, document.signature_auth_tag,
    document.signature_key_version, document.external_document_id
  FROM public.merch_marking_documents AS document
  JOIN public.merch_marking_return_cases AS return_case
    ON return_case.id = document.return_case_id
  JOIN public.merch_marking_document_codes AS link ON link.document_id = document.id
  JOIN public.merch_marking_codes AS code ON code.id = link.marking_code_id
  JOIN public.merch_marking_assignments AS assignment ON assignment.id = link.assignment_id
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  WHERE document.id = p_document_id
    AND document.document_type = 'return_to_circulation'
    AND link.operation_kind = 'return_to_circulation'
    AND link.link_state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return document material not found' USING ERRCODE = 'MZC25';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_return_poll(
  p_document_id uuid,
  p_remote_status text,
  p_response_redacted jsonb,
  p_error_code text,
  p_error_message text,
  p_actor_id text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE next_status text;
DECLARE current_record record;
DECLARE next_case_status text;
BEGIN
  IF p_remote_status IS NULL OR length(p_remote_status) NOT BETWEEN 1 AND 120
     OR jsonb_typeof(p_response_redacted) <> 'object'
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid return poll' USING ERRCODE = 'MZC26';
  END IF;
  next_status := CASE upper(p_remote_status)
    WHEN 'CHECKED_OK' THEN 'accepted'
    WHEN 'CHECKED_NOT_OK' THEN 'rejected'
    WHEN 'PROCESSING_ERROR' THEN 'rejected'
    WHEN 'PARSE_ERROR' THEN 'rejected'
    ELSE 'processing' END;
  SELECT document.status, document.process_id, document.return_case_id,
    return_case.destination, return_case.version
  INTO current_record
  FROM public.merch_marking_documents AS document
  JOIN public.merch_marking_return_cases AS return_case
    ON return_case.id = document.return_case_id
  WHERE document.id = p_document_id
    AND document.document_type = 'return_to_circulation'
  FOR UPDATE OF document, return_case;
  IF NOT FOUND THEN RAISE EXCEPTION 'return document not found' USING ERRCODE = 'MZC25'; END IF;
  IF current_record.status = ANY (ARRAY['accepted'::text, 'rejected'::text]) THEN
    RETURN current_record.status;
  END IF;
  IF current_record.status <> 'processing' THEN
    RAISE EXCEPTION 'return document is not processing' USING ERRCODE = 'MZC26';
  END IF;
  UPDATE public.merch_marking_document_codes SET
    operation_result = CASE next_status WHEN 'accepted' THEN 'accepted'
      WHEN 'rejected' THEN 'rejected' ELSE 'pending' END,
    error_code = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_code, 'crpt_return_rejected') ELSE NULL END,
    error_message = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_message, 'GIS MT rejected LP_RETURN') ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE document_id = p_document_id;
  UPDATE public.merch_marking_documents SET
    status = next_status, response_redacted = p_response_redacted,
    error_code = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_code, 'crpt_return_rejected') ELSE NULL END,
    error_message = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_message, 'GIS MT rejected LP_RETURN') ELSE NULL END,
    checked_at = clock_timestamp(),
    accepted_at = CASE WHEN next_status = 'accepted' THEN clock_timestamp() ELSE NULL END,
    rejected_at = CASE WHEN next_status = 'rejected' THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE id = p_document_id;
  IF next_status = 'accepted' THEN
    next_case_status := CASE current_record.destination
      WHEN 'to_seller' THEN 'awaiting_physical_receipt'
      WHEN 'to_ozon_fbo' THEN 'awaiting_fbo_evidence'
      ELSE 'manual_review' END;
    UPDATE public.merch_marking_codes AS code SET
      crpt_state = 'in_circulation', crpt_status_raw = left(p_remote_status, 300),
      crpt_checked_at = clock_timestamp(), revision = revision + 1,
      updated_at = clock_timestamp()
    FROM public.merch_marking_document_codes AS link
    WHERE link.document_id = p_document_id AND code.id = link.marking_code_id;
    UPDATE public.merch_marking_return_confirmations SET
      return_state = 'confirmed', error_code = NULL, error_message = NULL,
      checked_at = clock_timestamp(), confirmed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE document_id = p_document_id;
    UPDATE public.merch_marking_return_cases SET
      process_status = next_case_status,
      manual_review_reason = CASE WHEN next_case_status = 'manual_review'
        THEN 'Return destination is not confirmed' ELSE NULL END,
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = current_record.return_case_id;
    UPDATE public.merch_marking_processes SET
      status = 'waiting_user', current_step = 'return_in_circulation',
      next_action = CASE current_record.destination
        WHEN 'to_seller' THEN 'Подтвердить физическую приёмку и состояние товара'
        WHEN 'to_ozon_fbo' THEN 'Приложить FBO и ЭДО подтверждения передачи агенту'
        ELSE 'Уточнить направление возврата' END,
      manual_review_reason = NULL, version = version + 1,
      updated_at = clock_timestamp()
    WHERE id = current_record.process_id;
    INSERT INTO public.merch_marking_return_case_events (
      return_case_id, event_type, case_version, actor_type, actor_id, source,
      details_redacted
    ) VALUES (
      current_record.return_case_id, 'crpt_return_confirmed',
      current_record.version + 1, 'worker', p_actor_id, 'marking_crpt_return',
      jsonb_build_object('documentId', p_document_id, 'state', 'in_circulation')
    );
  ELSIF next_status = 'rejected' THEN
    UPDATE public.merch_marking_return_confirmations SET
      return_state = 'requires_manual_review',
      error_code = coalesce(p_error_code, 'crpt_return_rejected'),
      error_message = coalesce(p_error_message, 'ГИС МТ отклонила возврат в оборот'),
      checked_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE document_id = p_document_id;
    UPDATE public.merch_marking_return_cases SET
      process_status = 'manual_review',
      manual_review_reason = coalesce(p_error_message, 'ГИС МТ отклонила возврат в оборот'),
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = current_record.return_case_id;
    UPDATE public.merch_marking_processes SET
      status = 'manual_review', current_step = 'return_rejected',
      next_action = 'Сверить и создать исправленную ревизию LP_RETURN',
      manual_review_reason = coalesce(p_error_message, 'ГИС МТ отклонила возврат в оборот'),
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = current_record.process_id;
  ELSE
    UPDATE public.merch_marking_return_cases SET
      process_status = 'return_processing', version = version + 1,
      updated_at = clock_timestamp()
    WHERE id = current_record.return_case_id;
  END IF;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_return_manual_review(
  p_document_id uuid,
  p_error_code text,
  p_error_message text,
  p_phase text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record record;
DECLARE result text;
BEGIN
  SELECT document.return_case_id, document.process_id INTO current_record
  FROM public.merch_marking_documents AS document
  WHERE document.id = p_document_id
    AND document.document_type = 'return_to_circulation';
  IF NOT FOUND THEN RAISE EXCEPTION 'return document not found' USING ERRCODE = 'MZC25'; END IF;
  SELECT getomerch_marking.record_introduction_manual_review(
    p_document_id, p_error_code, p_error_message,
    jsonb_build_object('phase', p_phase)
  ) INTO result;
  UPDATE public.merch_marking_return_confirmations SET
    return_state = 'requires_manual_review', error_code = p_error_code,
    error_message = p_error_message, checked_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE document_id = p_document_id;
  UPDATE public.merch_marking_return_cases SET
    process_status = 'manual_review', manual_review_reason = p_error_message,
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = current_record.return_case_id;
  UPDATE public.merch_marking_processes SET
    status = 'manual_review', current_step = 'return_manual_review',
    next_action = 'Сверить LP_RETURN и создать исправленную ревизию',
    manual_review_reason = p_error_message, version = version + 1,
    updated_at = clock_timestamp()
  WHERE id = current_record.process_id;
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_seller_return_receipt(
  p_return_case_id uuid,
  p_expected_version bigint,
  p_condition text,
  p_warehouse_id uuid,
  p_inventory_transaction_id uuid,
  p_actor_id text,
  p_request_id uuid
)
RETURNS TABLE (return_case_id uuid, case_version bigint, process_status text, stock_received boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record record;
DECLARE next_status text;
DECLARE stock_received_value boolean;
BEGIN
  IF p_return_case_id IS NULL OR p_expected_version < 1 OR p_warehouse_id IS NULL
     OR p_condition <> ALL (ARRAY[
       'intact'::text, 'relabel_same_code'::text,
       'remark_required'::text, 'destroy_pending'::text])
     OR (p_condition = 'intact') <> (p_inventory_transaction_id IS NOT NULL)
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid seller return receipt' USING ERRCODE = 'MZC30';
  END IF;
  SELECT return_case.*, code.crpt_state INTO current_record
  FROM public.merch_marking_return_cases AS return_case
  JOIN public.merch_marking_codes AS code ON code.id = return_case.marking_code_id
  WHERE return_case.id = p_return_case_id
  FOR UPDATE OF return_case, code;
  IF NOT FOUND THEN RAISE EXCEPTION 'return case not found' USING ERRCODE = 'MZC11'; END IF;
  IF current_record.version <> p_expected_version THEN
    RAISE EXCEPTION 'return case version conflict' USING ERRCODE = 'MZC12';
  END IF;
  IF current_record.destination <> 'to_seller'
     OR current_record.process_status <> 'awaiting_physical_receipt'
     OR current_record.crpt_state <> 'in_circulation'
     OR current_record.seller_received_at IS NOT NULL THEN
    RAISE EXCEPTION 'seller return is not ready for physical receipt' USING ERRCODE = 'MZC31';
  END IF;
  stock_received_value := p_condition = 'intact';
  next_status := CASE WHEN stock_received_value THEN 'completed' ELSE 'manual_review' END;
  UPDATE public.merch_marking_units SET
    unit_state = CASE WHEN stock_received_value THEN 'returned' ELSE 'quarantined' END,
    custody_state = 'getomerch', warehouse_id = p_warehouse_id,
    last_stock_transaction_id = coalesce(p_inventory_transaction_id, last_stock_transaction_id),
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = current_record.marking_unit_id;
  UPDATE public.merch_marking_return_cases SET
    process_status = next_status, seller_received_at = clock_timestamp(),
    seller_received_by = p_actor_id, physical_condition = p_condition,
    receiving_warehouse_id = p_warehouse_id,
    inventory_transaction_id = p_inventory_transaction_id,
    manual_review_reason = CASE p_condition
      WHEN 'relabel_same_code' THEN 'Требуется повторная этикетка того же КМ до прихода в доступный остаток'
      WHEN 'remark_required' THEN 'Повреждён КМ: требуется отдельный процесс перемаркировки'
      WHEN 'destroy_pending' THEN 'Требуется документированная утилизация товара и КМ'
      ELSE NULL END,
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = p_return_case_id;
  UPDATE public.merch_marking_processes SET
    status = CASE WHEN stock_received_value THEN 'completed' ELSE 'manual_review' END,
    current_step = CASE WHEN stock_received_value THEN 'seller_return_received'
      ELSE 'seller_return_condition_review' END,
    next_action = CASE p_condition
      WHEN 'relabel_same_code' THEN 'Напечатать и нанести новую этикетку того же КМ'
      WHEN 'remark_required' THEN 'Запустить перемаркировку'
      WHEN 'destroy_pending' THEN 'Оформить утилизацию'
      ELSE NULL END,
    manual_review_reason = CASE WHEN stock_received_value THEN NULL
      ELSE 'Returned unit is quarantined pending condition-specific workflow' END,
    completed_at = CASE WHEN stock_received_value THEN clock_timestamp() ELSE NULL END,
    version = version + 1, updated_at = clock_timestamp()
  WHERE process_type = 'fbs_return_to_circulation'
    AND source = 'ozon_return_case' AND source_key = p_return_case_id::text
    AND status <> ALL (ARRAY['completed'::text, 'cancelled'::text]);
  INSERT INTO public.merch_marking_return_case_events (
    return_case_id, event_type, case_version, actor_type, actor_id, source,
    details_redacted
  ) VALUES (
    p_return_case_id, 'seller_return_physically_received',
    current_record.version + 1, 'operator', p_actor_id, 'admin',
    jsonb_build_object('condition', p_condition, 'warehouseId', p_warehouse_id,
      'stockReceived', stock_received_value, 'requestId', p_request_id)
  );
  RETURN QUERY SELECT p_return_case_id, current_record.version + 1,
    next_status, stock_received_value;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.confirm_return_fbo_transfer(
  p_return_case_id uuid,
  p_expected_version bigint,
  p_fbo_intake_reference text,
  p_edo_document_reference text,
  p_actor_id text,
  p_request_id uuid
)
RETURNS TABLE (return_case_id uuid, case_version bigint, process_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record record;
BEGIN
  IF p_return_case_id IS NULL OR p_expected_version < 1
     OR p_fbo_intake_reference IS NULL
     OR length(p_fbo_intake_reference) NOT BETWEEN 1 AND 300
     OR p_edo_document_reference IS NULL
     OR length(p_edo_document_reference) NOT BETWEEN 1 AND 300
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid FBO transfer evidence' USING ERRCODE = 'MZC40';
  END IF;
  SELECT return_case.*, code.crpt_state INTO current_record
  FROM public.merch_marking_return_cases AS return_case
  JOIN public.merch_marking_codes AS code ON code.id = return_case.marking_code_id
  WHERE return_case.id = p_return_case_id
  FOR UPDATE OF return_case, code;
  IF NOT FOUND THEN RAISE EXCEPTION 'return case not found' USING ERRCODE = 'MZC11'; END IF;
  IF current_record.version <> p_expected_version THEN
    RAISE EXCEPTION 'return case version conflict' USING ERRCODE = 'MZC12';
  END IF;
  IF current_record.destination <> 'to_ozon_fbo'
     OR current_record.process_status <> 'awaiting_fbo_evidence'
     OR current_record.crpt_state <> 'in_circulation'
     OR current_record.fbo_transfer_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'return is not ready for FBO transfer' USING ERRCODE = 'MZC41';
  END IF;
  UPDATE public.merch_marking_units SET
    unit_state = 'shipped', custody_state = 'ozon_fbo', warehouse_id = NULL,
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = current_record.marking_unit_id;
  UPDATE public.merch_marking_return_cases SET
    process_status = 'completed', fbo_intake_reference = p_fbo_intake_reference,
    edo_document_reference = p_edo_document_reference,
    fbo_transfer_confirmed_at = clock_timestamp(),
    fbo_transfer_confirmed_by = p_actor_id, manual_review_reason = NULL,
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = p_return_case_id;
  UPDATE public.merch_marking_processes SET
    status = 'completed', current_step = 'transferred_to_ozon_fbo',
    next_action = NULL, manual_review_reason = NULL,
    completed_at = clock_timestamp(), version = version + 1,
    updated_at = clock_timestamp()
  WHERE process_type = 'fbs_return_to_circulation'
    AND source = 'ozon_return_case' AND source_key = p_return_case_id::text
    AND status <> ALL (ARRAY['completed'::text, 'cancelled'::text]);
  INSERT INTO public.merch_marking_return_case_events (
    return_case_id, event_type, case_version, actor_type, actor_id, source,
    details_redacted
  ) VALUES (
    p_return_case_id, 'return_transferred_to_ozon_fbo',
    current_record.version + 1, 'operator', p_actor_id, 'admin',
    jsonb_build_object('fboIntakeReference', p_fbo_intake_reference,
      'edoDocumentReference', p_edo_document_reference,
      'stockReceived', false, 'requestId', p_request_id)
  );
  RETURN QUERY SELECT p_return_case_id, current_record.version + 1, 'completed'::text;
END
$function$;

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
  handover.withdrawal_deadline_at,
  document.return_case_id,
  return_confirmation.return_state,
  return_confirmation.error_code AS return_error_code,
  return_confirmation.error_message AS return_error_message,
  return_confirmation.checked_at AS return_checked_at,
  return_confirmation.confirmed_at AS return_confirmed_at
FROM public.merch_marking_documents AS document
LEFT JOIN public.merch_marking_document_confirmations AS introduction
  ON introduction.document_id = document.id
LEFT JOIN public.merch_marking_withdrawal_confirmations AS withdrawal
  ON withdrawal.document_id = document.id
LEFT JOIN public.merch_marking_return_confirmations AS return_confirmation
  ON return_confirmation.document_id = document.id
LEFT JOIN public.merch_marking_handovers AS handover
  ON handover.id = document.handover_id;

CREATE OR REPLACE FUNCTION getomerch_marking.get_seller_receipt_context(
  p_return_case_id uuid
)
RETURNS TABLE (
  id uuid, version bigint, process_status text, destination text,
  seller_received_at timestamp with time zone, product_id_snapshot uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_return_case_id IS NULL THEN
    RAISE EXCEPTION 'invalid seller receipt context' USING ERRCODE = 'MZC30';
  END IF;
  RETURN QUERY
  SELECT return_case.id, return_case.version, return_case.process_status,
    return_case.destination, return_case.seller_received_at,
    unit.product_id_snapshot
  FROM public.merch_marking_return_cases AS return_case
  JOIN public.merch_marking_units AS unit
    ON unit.id = return_case.marking_unit_id
  WHERE return_case.id = p_return_case_id
  FOR UPDATE OF return_case, unit;
END
$function$;

CREATE VIEW getomerch_marking.return_case_safe
WITH (security_barrier = true)
AS
SELECT return_case.id, return_case.source, return_case.source_return_id,
  return_case.source_return_item_id, return_case.original_fulfillment_order_id,
  return_case.original_assignment_id, return_case.handover_id,
  return_case.marking_unit_id, return_case.marking_code_id,
  return_case.posting_number, return_case.offer_id, return_case.ozon_sku,
  return_case.quantity, return_case.return_kind, return_case.destination,
  return_case.source_status, return_case.process_status, return_case.paid,
  return_case.source_snapshot_hash, return_case.source_contract_version,
  return_case.source_evidence_redacted, return_case.detected_at,
  return_case.source_observed_at, return_case.direction_confirmed_at,
  return_case.seller_received_at, return_case.physical_condition,
  return_case.receiving_warehouse_id, return_case.inventory_transaction_id,
  return_case.fbo_intake_reference, return_case.edo_document_reference,
  return_case.fbo_transfer_confirmed_at, return_case.manual_review_reason,
  return_case.version, return_case.created_at, return_case.updated_at,
  code.fingerprint AS code_fingerprint, code.crpt_state,
  assignment.gtin_snapshot AS gtin, unit.product_id_snapshot,
  unit.unit_state, unit.custody_state,
  document.id AS return_document_id, document.status AS return_document_status,
  document.revision AS return_document_revision,
  confirmation.return_state AS return_confirmation_state,
  warehouse.name AS receiving_warehouse_name
FROM public.merch_marking_return_cases AS return_case
LEFT JOIN public.merch_marking_codes AS code ON code.id = return_case.marking_code_id
LEFT JOIN public.merch_marking_units AS unit ON unit.id = return_case.marking_unit_id
LEFT JOIN public.merch_marking_assignments AS assignment
  ON assignment.id = return_case.original_assignment_id
LEFT JOIN public.merch_marking_documents AS document
  ON document.return_case_id = return_case.id
 AND document.document_type = 'return_to_circulation'
 AND document.status <> 'superseded'
LEFT JOIN public.merch_marking_return_confirmations AS confirmation
  ON confirmation.document_id = document.id
LEFT JOIN public.merch_warehouses AS warehouse
  ON warehouse.id = return_case.receiving_warehouse_id;

CREATE VIEW getomerch_marking.return_case_event_safe
WITH (security_barrier = true)
AS
SELECT event.id, event.return_case_id, event.event_type, event.case_version,
  event.actor_type, event.actor_id, event.source, event.details_redacted,
  event.occurred_at, event.created_at
FROM public.merch_marking_return_case_events AS event;

CREATE OR REPLACE FUNCTION getomerch_marking.protect_return_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'return history is append-only' USING ERRCODE = 'MZC50';
END
$function$;

CREATE TRIGGER merch_marking_return_events_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_return_case_events
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_return_history();

CREATE OR REPLACE FUNCTION getomerch_marking.protect_document_return_case()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.return_case_id IS DISTINCT FROM OLD.return_case_id THEN
    RAISE EXCEPTION 'marking document return case is immutable' USING ERRCODE = 'MZA12';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER merch_marking_documents_return_case_protect
BEFORE UPDATE OF return_case_id ON public.merch_marking_documents
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_document_return_case();

REVOKE ALL ON public.merch_marking_return_cases,
  public.merch_marking_return_case_events,
  public.merch_marking_return_confirmations
  FROM PUBLIC, getomerch_app;
GRANT SELECT ON public.merch_marking_return_cases,
  public.merch_marking_return_case_events,
  public.merch_marking_return_confirmations
  TO getomerch_backup;
REVOKE ALL ON getomerch_marking.return_case_safe,
  getomerch_marking.return_case_event_safe FROM PUBLIC;
GRANT SELECT ON getomerch_marking.return_case_safe,
  getomerch_marking.return_case_event_safe
  TO getomerch_app, getomerch_backup;

REVOKE ALL ON FUNCTION getomerch_marking.upsert_ozon_return_case(
  text,text,text,text,text,integer,text,text,text,text,jsonb,
  timestamp with time zone,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.confirm_return_direction(
  uuid,bigint,text,boolean,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.prepare_return_document(
  uuid,text,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_return_document_material(
  uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_return_poll(
  uuid,text,jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_return_manual_review(
  uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_seller_return_receipt(
  uuid,bigint,text,uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.confirm_return_fbo_transfer(
  uuid,bigint,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_seller_receipt_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.protect_return_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.protect_document_return_case() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.upsert_ozon_return_case(
  text,text,text,text,text,integer,text,text,text,text,jsonb,
  timestamp with time zone,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.confirm_return_direction(
  uuid,bigint,text,boolean,text,uuid) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.prepare_return_document(
  uuid,text,uuid,boolean) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.get_return_document_material(
  uuid,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_return_poll(
  uuid,text,jsonb,text,text,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_return_manual_review(
  uuid,text,text,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_seller_return_receipt(
  uuid,bigint,text,uuid,uuid,text,uuid) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.confirm_return_fbo_transfer(
  uuid,bigint,text,text,text,uuid) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.get_seller_receipt_context(uuid)
  TO getomerch_app;

COMMENT ON TABLE public.merch_marking_return_cases IS
  'One versioned case per Ozon return item; Ozon evidence never directly selects destination or mutates CRPT/inventory.';
COMMENT ON COLUMN public.merch_marking_return_cases.paid IS
  'Operator-confirmed payment fact used to build LP_RETURN; never inferred from a return status string.';
COMMENT ON COLUMN public.merch_marking_return_cases.inventory_transaction_id IS
  'Set only for physical seller receipt of an intact unit; FBS-to-FBO never has this transaction.';
