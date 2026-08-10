-- Stage 6: serialized marking units, code bindings and JIT fulfillment
-- assignments. Inventory is changed by the application mutation in the same
-- transaction as complete_jit_application; prepare_jit_assignment never
-- changes aggregate stock.

CREATE TABLE public.merch_marking_units (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    product_profile_id uuid NOT NULL
      REFERENCES public.merch_marking_product_profiles(id) ON DELETE RESTRICT,
    product_id_snapshot uuid NOT NULL
      REFERENCES public.merch_products(id) ON DELETE RESTRICT,
    internal_serial text NOT NULL UNIQUE,
    unit_state text DEFAULT 'preparing'::text NOT NULL,
    custody_state text DEFAULT 'getomerch'::text NOT NULL,
    warehouse_id uuid
      REFERENCES public.merch_warehouses(id) ON DELETE RESTRICT,
    origin_type text NOT NULL,
    origin_reference_type text,
    origin_reference_key text,
    last_stock_transaction_id uuid
      REFERENCES public.merch_transactions(id) ON DELETE RESTRICT,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_units_profile_product_unique
      UNIQUE (id, product_profile_id),
    CONSTRAINT merch_marking_units_serial_check
      CHECK (length(internal_serial) BETWEEN 8 AND 120),
    CONSTRAINT merch_marking_units_state_check
      CHECK (
        unit_state = ANY (
          ARRAY['preparing'::text, 'marking_pending'::text, 'ready'::text,
                'reserved'::text, 'shipped'::text, 'returned'::text,
                'quarantined'::text, 'cancelled'::text, 'retired'::text,
                'destroyed'::text]
        )
      ),
    CONSTRAINT merch_marking_units_custody_check
      CHECK (
        custody_state = ANY (
          ARRAY['getomerch'::text, 'ozon'::text, 'carrier'::text,
                'customer'::text, 'unknown'::text]
        )
      ),
    CONSTRAINT merch_marking_units_origin_check
      CHECK (
        origin_type = ANY (
          ARRAY['own_production'::text, 'supplier_marked'::text,
                'remarking'::text]
        )
      ),
    CONSTRAINT merch_marking_units_origin_reference_check
      CHECK (
        (origin_reference_type IS NULL AND origin_reference_key IS NULL)
        OR (
          origin_reference_type IS NOT NULL
          AND length(origin_reference_type) BETWEEN 1 AND 120
          AND origin_reference_key IS NOT NULL
          AND length(origin_reference_key) BETWEEN 1 AND 500
        )
      ),
    CONSTRAINT merch_marking_units_version_check CHECK (version >= 1),
    CONSTRAINT merch_marking_units_stock_state_check
      CHECK (
        (unit_state = 'preparing' AND last_stock_transaction_id IS NULL)
        OR unit_state <> 'preparing'
      )
);

CREATE UNIQUE INDEX merch_marking_units_stock_transaction
  ON public.merch_marking_units (last_stock_transaction_id)
  WHERE last_stock_transaction_id IS NOT NULL;
CREATE INDEX merch_marking_units_profile_state
  ON public.merch_marking_units (product_profile_id, unit_state, updated_at DESC);
CREATE INDEX merch_marking_units_warehouse_state
  ON public.merch_marking_units (warehouse_id, unit_state, updated_at DESC)
  WHERE warehouse_id IS NOT NULL;

CREATE TABLE public.merch_marking_code_bindings (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    marking_unit_id uuid NOT NULL
      REFERENCES public.merch_marking_units(id) ON DELETE RESTRICT,
    marking_code_id uuid NOT NULL
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    status text DEFAULT 'planned'::text NOT NULL,
    label_state text DEFAULT 'not_rendered'::text NOT NULL,
    binding_reason text NOT NULL,
    template_version text,
    render_count integer DEFAULT 0 NOT NULL,
    print_confirmed_count integer DEFAULT 0 NOT NULL,
    bound_by text NOT NULL,
    bound_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    first_rendered_at timestamp with time zone,
    last_rendered_at timestamp with time zone,
    first_printed_at timestamp with time zone,
    last_printed_at timestamp with time zone,
    applied_at timestamp with time zone,
    removed_at timestamp with time zone,
    removal_reason text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_code_bindings_unit_unique
      UNIQUE (id, marking_unit_id),
    CONSTRAINT merch_marking_code_bindings_status_check
      CHECK (
        status = ANY (
          ARRAY['planned'::text, 'active'::text, 'removed'::text,
                'replaced'::text, 'cancelled'::text]
        )
      ),
    CONSTRAINT merch_marking_code_bindings_label_state_check
      CHECK (
        label_state = ANY (
          ARRAY['not_rendered'::text, 'label_rendered'::text, 'printed'::text,
                'applied'::text, 'damaged'::text, 'lost'::text,
                'destroyed'::text, 'unknown'::text]
        )
      ),
    CONSTRAINT merch_marking_code_bindings_reason_check
      CHECK (length(binding_reason) BETWEEN 1 AND 500),
    CONSTRAINT merch_marking_code_bindings_template_check
      CHECK (template_version IS NULL OR length(template_version) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_code_bindings_count_check
      CHECK (
        render_count >= 0
        AND print_confirmed_count >= 0
        AND print_confirmed_count <= render_count
      ),
    CONSTRAINT merch_marking_code_bindings_actor_check
      CHECK (length(bound_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_code_bindings_render_check
      CHECK (
        (
          render_count = 0
          AND first_rendered_at IS NULL
          AND last_rendered_at IS NULL
          AND label_state = 'not_rendered'
        )
        OR (
          render_count > 0
          AND first_rendered_at IS NOT NULL
          AND last_rendered_at IS NOT NULL
          AND label_state <> 'not_rendered'
        )
      ),
    CONSTRAINT merch_marking_code_bindings_print_check
      CHECK (
        (
          print_confirmed_count = 0
          AND first_printed_at IS NULL
          AND last_printed_at IS NULL
        )
        OR (
          print_confirmed_count > 0
          AND first_printed_at IS NOT NULL
          AND last_printed_at IS NOT NULL
        )
      ),
    CONSTRAINT merch_marking_code_bindings_applied_check
      CHECK (
        (
          status = 'active'
          AND label_state = 'applied'
          AND applied_at IS NOT NULL
          AND removed_at IS NULL
          AND removal_reason IS NULL
        )
        OR (
          status <> 'active'
          AND applied_at IS NULL
        )
      ),
    CONSTRAINT merch_marking_code_bindings_removed_check
      CHECK (
        (
          status = ANY (ARRAY['removed'::text, 'replaced'::text])
          AND removed_at IS NOT NULL
          AND removal_reason IS NOT NULL
          AND length(removal_reason) BETWEEN 1 AND 1000
        )
        OR (
          status <> ALL (ARRAY['removed'::text, 'replaced'::text])
          AND removed_at IS NULL
          AND removal_reason IS NULL
        )
      )
);

CREATE UNIQUE INDEX merch_marking_code_bindings_live_unit
  ON public.merch_marking_code_bindings (marking_unit_id)
  WHERE status = ANY (ARRAY['planned'::text, 'active'::text]);
CREATE UNIQUE INDEX merch_marking_code_bindings_live_code
  ON public.merch_marking_code_bindings (marking_code_id)
  WHERE status = ANY (ARRAY['planned'::text, 'active'::text]);
CREATE INDEX merch_marking_code_bindings_code_history
  ON public.merch_marking_code_bindings (marking_code_id, created_at DESC, id DESC);

CREATE TABLE public.merch_marking_assignments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fulfillment_item_id uuid NOT NULL
      REFERENCES public.merch_fulfillment_order_items(id) ON DELETE RESTRICT,
    unit_ordinal integer NOT NULL,
    marking_unit_id uuid NOT NULL,
    code_binding_id uuid NOT NULL,
    product_profile_id uuid NOT NULL
      REFERENCES public.merch_marking_product_profiles(id) ON DELETE RESTRICT,
    gtin_snapshot text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    assigned_by text NOT NULL,
    assigned_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    released_at timestamp with time zone,
    release_reason text,
    completed_at timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_assignments_unit_profile_fkey
      FOREIGN KEY (marking_unit_id, product_profile_id)
      REFERENCES public.merch_marking_units(id, product_profile_id)
      ON DELETE RESTRICT,
    CONSTRAINT merch_marking_assignments_binding_unit_fkey
      FOREIGN KEY (code_binding_id, marking_unit_id)
      REFERENCES public.merch_marking_code_bindings(id, marking_unit_id)
      ON DELETE RESTRICT,
    CONSTRAINT merch_marking_assignments_ordinal_check
      CHECK (unit_ordinal BETWEEN 1 AND 10000),
    CONSTRAINT merch_marking_assignments_gtin_check
      CHECK (getomerch_marking.is_valid_gtin14(gtin_snapshot)),
    CONSTRAINT merch_marking_assignments_status_check
      CHECK (
        status = ANY (
          ARRAY['active'::text, 'released'::text, 'quarantined'::text,
                'completed'::text, 'cancelled'::text]
        )
      ),
    CONSTRAINT merch_marking_assignments_actor_check
      CHECK (length(assigned_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_assignments_release_check
      CHECK (
        (
          status = ANY (
            ARRAY['released'::text, 'quarantined'::text, 'cancelled'::text]
          )
          AND released_at IS NOT NULL
          AND release_reason IS NOT NULL
          AND length(release_reason) BETWEEN 1 AND 1000
        )
        OR (
          status = ANY (ARRAY['active'::text, 'completed'::text])
          AND released_at IS NULL
          AND release_reason IS NULL
        )
      ),
    CONSTRAINT merch_marking_assignments_completion_check
      CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
      ),
    CONSTRAINT merch_marking_assignments_revision_check CHECK (revision >= 1)
);

CREATE UNIQUE INDEX merch_marking_assignments_active_unit
  ON public.merch_marking_assignments (marking_unit_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX merch_marking_assignments_active_slot
  ON public.merch_marking_assignments (fulfillment_item_id, unit_ordinal)
  WHERE status = 'active';
CREATE INDEX merch_marking_assignments_item_history
  ON public.merch_marking_assignments (
    fulfillment_item_id,
    unit_ordinal,
    created_at DESC,
    id DESC
  );
CREATE INDEX merch_marking_assignments_updated
  ON public.merch_marking_assignments (updated_at DESC, id DESC);

ALTER TABLE public.merch_marking_processes
    DROP CONSTRAINT merch_marking_processes_stage3_future_subjects_check,
    ADD CONSTRAINT merch_marking_processes_marking_unit_fk
      FOREIGN KEY (marking_unit_id)
      REFERENCES public.merch_marking_units(id) ON DELETE RESTRICT,
    ADD CONSTRAINT merch_marking_processes_assignment_fk
      FOREIGN KEY (assignment_id)
      REFERENCES public.merch_marking_assignments(id) ON DELETE RESTRICT;

ALTER TABLE public.merch_marking_evidence
    DROP CONSTRAINT merch_marking_evidence_stage3_future_subjects_check,
    DROP CONSTRAINT merch_marking_evidence_subject_check,
    ADD CONSTRAINT merch_marking_evidence_marking_unit_fk
      FOREIGN KEY (marking_unit_id)
      REFERENCES public.merch_marking_units(id) ON DELETE RESTRICT,
    ADD CONSTRAINT merch_marking_evidence_assignment_fk
      FOREIGN KEY (assignment_id)
      REFERENCES public.merch_marking_assignments(id) ON DELETE RESTRICT,
    ADD CONSTRAINT merch_marking_evidence_subject_check
      CHECK (
        process_id IS NOT NULL
        OR product_profile_id IS NOT NULL
        OR marking_unit_id IS NOT NULL
        OR assignment_id IS NOT NULL
      );

ALTER TABLE public.merch_marking_events
    DROP CONSTRAINT merch_marking_events_stage5_future_subjects_check,
    DROP CONSTRAINT merch_marking_events_subject_check,
    ADD CONSTRAINT merch_marking_events_marking_unit_fk
      FOREIGN KEY (marking_unit_id)
      REFERENCES public.merch_marking_units(id) ON DELETE RESTRICT,
    ADD CONSTRAINT merch_marking_events_code_binding_fk
      FOREIGN KEY (code_binding_id)
      REFERENCES public.merch_marking_code_bindings(id) ON DELETE RESTRICT,
    ADD CONSTRAINT merch_marking_events_assignment_fk
      FOREIGN KEY (assignment_id)
      REFERENCES public.merch_marking_assignments(id) ON DELETE RESTRICT,
    ADD CONSTRAINT merch_marking_events_stage6_future_subjects_check
      CHECK (document_id IS NULL),
    ADD CONSTRAINT merch_marking_events_subject_check
      CHECK (
        process_id IS NOT NULL
        OR product_profile_id IS NOT NULL
        OR marking_code_id IS NOT NULL
        OR marking_unit_id IS NOT NULL
        OR code_binding_id IS NOT NULL
        OR assignment_id IS NOT NULL
      );

CREATE INDEX merch_marking_events_unit
  ON public.merch_marking_events (marking_unit_id, occurred_at DESC, id DESC)
  WHERE marking_unit_id IS NOT NULL;
CREATE INDEX merch_marking_events_assignment
  ON public.merch_marking_events (assignment_id, occurred_at DESC, id DESC)
  WHERE assignment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION getomerch_marking.prepare_jit_assignment(
  p_fulfillment_item_id uuid,
  p_warehouse_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  assignment_id uuid,
  marking_unit_id uuid,
  code_binding_id uuid,
  process_id uuid,
  unit_ordinal integer,
  assignment_revision bigint,
  gtin text,
  code_fingerprint text,
  warehouse_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  item_record record;
  profile_record record;
  warehouse_record record;
  selected_code public.merch_marking_codes%ROWTYPE;
  created_unit_id uuid;
  created_binding_id uuid;
  created_assignment_id uuid;
  created_process_id uuid;
  selected_ordinal integer;
  now_at timestamp with time zone := clock_timestamp();
BEGIN
  IF p_fulfillment_item_id IS NULL
     OR p_warehouse_id IS NULL
     OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid JIT assignment parameters' USING ERRCODE = 'MZ600';
  END IF;

  SELECT
    item.id,
    item.fulfillment_order_id,
    item.product_id,
    item.offer_id,
    item.quantity,
    item.marking_requirement,
    item.exemplar_flow_available,
    item.source_active,
    fulfillment_order.source_channel,
    fulfillment_order.source_status,
    fulfillment_order.external_posting_number,
    product.sku,
    product.decoration_type_id,
    decoration.made_at AS decoration_made_at
  INTO item_record
  FROM public.merch_fulfillment_order_items AS item
  JOIN public.merch_fulfillment_orders AS fulfillment_order
    ON fulfillment_order.id = item.fulfillment_order_id
  LEFT JOIN public.merch_products AS product
    ON product.id = item.product_id
  LEFT JOIN public.merch_decoration_types AS decoration
    ON decoration.id = product.decoration_type_id
  WHERE item.id = p_fulfillment_item_id
  FOR UPDATE OF item;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment item not found' USING ERRCODE = 'MZ601';
  END IF;
  IF NOT item_record.source_active
     OR item_record.source_status = ANY (
       ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
             'sent_by_seller'::text, 'arbitration'::text,
             'client_arbitration'::text, 'not_accepted'::text,
             'cancelled'::text]
     ) THEN
    RAISE EXCEPTION 'fulfillment item is no longer preparable'
      USING ERRCODE = 'MZ602';
  END IF;
  IF item_record.product_id IS NULL
     OR item_record.marking_requirement <> 'required'
     OR item_record.decoration_made_at IS NULL THEN
    RAISE EXCEPTION 'fulfillment item is not ready for marking'
      USING ERRCODE = 'MZ603';
  END IF;
  IF item_record.source_channel = 'ozon_fbs'
     AND item_record.exemplar_flow_available IS NOT TRUE THEN
    RAISE EXCEPTION 'Ozon exemplar flow is not confirmed for fulfillment item'
      USING ERRCODE = 'MZ604';
  END IF;

  SELECT
    profile.id,
    profile.trade_item_id,
    profile.production_mode,
    profile.fulfillment_marking_mode,
    trade_item.gtin
  INTO profile_record
  FROM public.merch_marking_product_profiles AS profile
  JOIN public.merch_marking_trade_items AS trade_item
    ON trade_item.id = profile.trade_item_id
  WHERE profile.product_id = item_record.product_id
    AND profile.archived_at IS NULL
    AND profile.requires_marking
    AND profile.marking_requirement = 'required'
    AND profile.verification_status = 'verified'
    AND profile.operational_status = 'enabled'
    AND profile.production_mode = 'own_production'
    AND profile.fulfillment_marking_mode = 'jit_after_order'
    AND trade_item.archived_at IS NULL
    AND trade_item.verification_status = 'verified';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'verified enabled JIT profile not found'
      USING ERRCODE = 'MZ603';
  END IF;
  PERFORM getomerch_marking.assert_product_profile_ready(profile_record.id);

  IF NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_product_profile_channels AS channel
    WHERE channel.product_profile_id = profile_record.id
      AND channel.channel = item_record.source_channel
      AND channel.is_enabled
      AND (
        item_record.source_channel <> 'ozon_fbs'
        OR channel.offer_id = item_record.offer_id
      )
      AND channel.marking_requirement = 'required'
  ) THEN
    RAISE EXCEPTION 'product profile channel is not enabled for item'
      USING ERRCODE = 'MZ604';
  END IF;

  SELECT warehouse.id, warehouse.type
  INTO warehouse_record
  FROM public.merch_warehouses AS warehouse
  WHERE warehouse.id = p_warehouse_id
  FOR SHARE;

  IF NOT FOUND
     OR warehouse_record.type <> item_record.decoration_made_at THEN
    RAISE EXCEPTION 'warehouse does not match production location'
      USING ERRCODE = 'MZ605';
  END IF;

  SELECT slot
  INTO selected_ordinal
  FROM generate_series(1, item_record.quantity) AS slot
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_assignments AS assignment
    WHERE assignment.fulfillment_item_id = item_record.id
      AND assignment.unit_ordinal = slot
      AND assignment.status = 'active'
  )
  ORDER BY slot
  LIMIT 1;

  IF selected_ordinal IS NULL THEN
    RAISE EXCEPTION 'all fulfillment item slots are already assigned'
      USING ERRCODE = 'MZ606';
  END IF;

  SELECT code.*
  INTO selected_code
  FROM public.merch_marking_codes AS code
  WHERE code.trade_item_id = profile_record.trade_item_id
    AND code.gtin_snapshot = profile_record.gtin
    AND code.pool_state = 'available'
    AND code.crpt_state = ANY (ARRAY['emitted'::text, 'applied'::text])
    AND code.acquisition_mode = ANY (
      ARRAY['own_suz_emission'::text, 'remarking'::text]
    )
  ORDER BY code.created_at, code.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no available marking code for GTIN'
      USING ERRCODE = 'MZ607';
  END IF;

  INSERT INTO public.merch_marking_units (
    product_profile_id,
    product_id_snapshot,
    internal_serial,
    unit_state,
    custody_state,
    warehouse_id,
    origin_type,
    origin_reference_type,
    origin_reference_key
  )
  VALUES (
    profile_record.id,
    item_record.product_id,
    'JIT-' || upper(replace(gen_random_uuid()::text, '-', '')),
    'preparing',
    'getomerch',
    p_warehouse_id,
    CASE
      WHEN selected_code.acquisition_mode = 'remarking' THEN 'remarking'
      ELSE 'own_production'
    END,
    'fulfillment_item',
    item_record.id::text || ':' || selected_ordinal::text
  )
  RETURNING id INTO created_unit_id;

  INSERT INTO public.merch_marking_code_bindings (
    marking_unit_id,
    marking_code_id,
    status,
    label_state,
    binding_reason,
    bound_by,
    bound_at
  )
  VALUES (
    created_unit_id,
    selected_code.id,
    'planned',
    'not_rendered',
    'jit_fulfillment_assignment',
    p_actor_id,
    now_at
  )
  RETURNING id INTO created_binding_id;

  INSERT INTO public.merch_marking_assignments (
    fulfillment_item_id,
    unit_ordinal,
    marking_unit_id,
    code_binding_id,
    product_profile_id,
    gtin_snapshot,
    status,
    assigned_by,
    assigned_at
  )
  VALUES (
    item_record.id,
    selected_ordinal,
    created_unit_id,
    created_binding_id,
    profile_record.id,
    profile_record.gtin,
    'active',
    p_actor_id,
    now_at
  )
  RETURNING id INTO created_assignment_id;

  UPDATE public.merch_marking_codes AS code
  SET
    pool_state = 'reserved',
    revision = code.revision + 1,
    updated_at = now_at
  WHERE code.id = selected_code.id
    AND code.pool_state = 'available';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking code reservation race' USING ERRCODE = 'MZ608';
  END IF;

  INSERT INTO public.merch_marking_processes (
    process_type,
    status,
    fulfillment_order_id,
    fulfillment_item_id,
    marking_unit_id,
    assignment_id,
    source,
    source_key,
    priority,
    current_step,
    next_action,
    owner
  )
  VALUES (
    'jit_marking_unit',
    'waiting_user',
    item_record.fulfillment_order_id,
    item_record.id,
    created_unit_id,
    created_assignment_id,
    'fulfillment',
    created_assignment_id::text,
    70,
    'code_reserved',
    'Сформировать этикетку КМ',
    p_actor_id
  )
  RETURNING id INTO created_process_id;

  INSERT INTO public.merch_marking_events (
    marking_code_id,
    marking_unit_id,
    code_binding_id,
    assignment_id,
    process_id,
    product_profile_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    selected_code.id,
    created_unit_id,
    created_binding_id,
    created_assignment_id,
    created_process_id,
    profile_record.id,
    'jit_assignment_prepared',
    'admin',
    p_actor_id,
    'admin_marking_assignment',
    jsonb_build_object(
      'fulfillmentItemId', item_record.id,
      'unitOrdinal', selected_ordinal,
      'gtin', profile_record.gtin,
      'fingerprint', selected_code.fingerprint,
      'warehouseId', p_warehouse_id,
      'stockChanged', false
    ),
    now_at
  );

  RETURN QUERY SELECT
    created_assignment_id,
    created_unit_id,
    created_binding_id,
    created_process_id,
    selected_ordinal,
    1::bigint,
    profile_record.gtin::text,
    selected_code.fingerprint,
    p_warehouse_id;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.lock_jit_assignment_for_apply(
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_actor_id text
)
RETURNS TABLE (
  assignment_id uuid,
  marking_unit_id uuid,
  code_binding_id uuid,
  process_id uuid,
  finished_product_id uuid,
  blank_product_id uuid,
  warehouse_id uuid,
  assignment_revision bigint,
  gtin text,
  offer_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  locked_record record;
  selected_blank_id uuid;
BEGIN
  IF p_assignment_id IS NULL
     OR p_expected_revision IS NULL
     OR p_expected_revision < 1
     OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid apply parameters' USING ERRCODE = 'MZ610';
  END IF;

  SELECT
    assignment.id,
    assignment.revision,
    assignment.status AS assignment_status,
    assignment.unit_ordinal,
    assignment.marking_unit_id,
    assignment.code_binding_id,
    assignment.gtin_snapshot,
    unit.product_id_snapshot,
    unit.warehouse_id,
    unit.unit_state,
    binding.status AS binding_status,
    binding.label_state,
    code.pool_state,
    code.crpt_state,
    item.quantity,
    item.offer_id,
    item.source_active,
    fulfillment_order.source_status,
    process.id AS process_id,
    product.category_id,
    product.fabric_id,
    product.color_id,
    product.size_id
  INTO locked_record
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_units AS unit
    ON unit.id = assignment.marking_unit_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_codes AS code
    ON code.id = binding.marking_code_id
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_fulfillment_orders AS fulfillment_order
    ON fulfillment_order.id = item.fulfillment_order_id
  JOIN public.merch_products AS product
    ON product.id = unit.product_id_snapshot
  LEFT JOIN public.merch_marking_processes AS process
    ON process.assignment_id = assignment.id
   AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
  WHERE assignment.id = p_assignment_id
  FOR UPDATE OF assignment, unit, binding, code, item;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'JIT assignment not found' USING ERRCODE = 'MZ611';
  END IF;
  IF locked_record.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'JIT assignment version conflict' USING ERRCODE = 'MZ612';
  END IF;
  IF locked_record.assignment_status <> 'active'
     OR locked_record.unit_state <> 'preparing'
     OR locked_record.binding_status <> 'planned'
     OR locked_record.label_state <> ALL (
       ARRAY['label_rendered'::text, 'printed'::text]
     )
     OR locked_record.pool_state <> 'reserved'
     OR locked_record.crpt_state <> ALL (
       ARRAY['emitted'::text, 'applied'::text]
     ) THEN
    RAISE EXCEPTION 'assignment is not ready for applied confirmation'
      USING ERRCODE = 'MZ613';
  END IF;
  IF NOT locked_record.source_active
     OR locked_record.unit_ordinal > locked_record.quantity
     OR locked_record.source_status = ANY (
       ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
             'sent_by_seller'::text, 'arbitration'::text,
             'client_arbitration'::text, 'not_accepted'::text,
             'cancelled'::text]
     ) THEN
    RAISE EXCEPTION 'fulfillment item is no longer preparable'
      USING ERRCODE = 'MZ602';
  END IF;

  SELECT blank.id
  INTO selected_blank_id
  FROM public.merch_products AS blank
  WHERE blank.is_blank
    AND blank.category_id = locked_record.category_id
    AND blank.fabric_id = locked_record.fabric_id
    AND blank.color_id = locked_record.color_id
    AND blank.size_id = locked_record.size_id;

  IF selected_blank_id IS NULL THEN
    RAISE EXCEPTION 'matching blank product not found' USING ERRCODE = 'MZ614';
  END IF;

  RETURN QUERY SELECT
    locked_record.id::uuid,
    locked_record.marking_unit_id::uuid,
    locked_record.code_binding_id::uuid,
    locked_record.process_id::uuid,
    locked_record.product_id_snapshot::uuid,
    selected_blank_id,
    locked_record.warehouse_id::uuid,
    locked_record.revision::bigint,
    locked_record.gtin_snapshot::text,
    locked_record.offer_id::text;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.complete_jit_application(
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_stock_transaction_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  assignment_id uuid,
  assignment_revision bigint,
  unit_state text,
  binding_status text,
  label_state text,
  code_pool_state text,
  process_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_record record;
  now_at timestamp with time zone := clock_timestamp();
BEGIN
  IF p_stock_transaction_id IS NULL
     OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'stock transaction is required' USING ERRCODE = 'MZ615';
  END IF;

  SELECT
    assignment.id,
    assignment.revision,
    assignment.status AS assignment_status,
    assignment.marking_unit_id,
    assignment.code_binding_id,
    assignment.fulfillment_item_id,
    assignment.gtin_snapshot,
    unit.product_id_snapshot,
    unit.warehouse_id,
    unit.unit_state,
    binding.marking_code_id,
    binding.status AS binding_status,
    binding.label_state,
    process.id AS process_id
  INTO current_record
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_units AS unit
    ON unit.id = assignment.marking_unit_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  LEFT JOIN public.merch_marking_processes AS process
    ON process.assignment_id = assignment.id
   AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
  WHERE assignment.id = p_assignment_id
  FOR UPDATE OF assignment, unit, binding;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'JIT assignment not found' USING ERRCODE = 'MZ611';
  END IF;
  IF current_record.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'JIT assignment version conflict' USING ERRCODE = 'MZ612';
  END IF;
  IF current_record.assignment_status <> 'active'
     OR current_record.unit_state <> 'preparing'
     OR current_record.binding_status <> 'planned'
     OR current_record.label_state <> ALL (
       ARRAY['label_rendered'::text, 'printed'::text]
     ) THEN
    RAISE EXCEPTION 'assignment is not ready for applied confirmation'
      USING ERRCODE = 'MZ613';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.merch_transactions AS stock_transaction
    JOIN public.merch_products AS finished
      ON finished.id = current_record.product_id_snapshot
    JOIN public.merch_products AS blank
      ON blank.id = stock_transaction.source_product_id
    WHERE stock_transaction.id = p_stock_transaction_id
      AND stock_transaction.type = 'production'
      AND stock_transaction.product_id = current_record.product_id_snapshot
      AND stock_transaction.to_warehouse_id = current_record.warehouse_id
      AND stock_transaction.quantity = 1
      AND blank.is_blank
      AND blank.category_id = finished.category_id
      AND blank.fabric_id = finished.fabric_id
      AND blank.color_id = finished.color_id
      AND blank.size_id = finished.size_id
  ) THEN
    RAISE EXCEPTION 'stock transaction does not match marking unit'
      USING ERRCODE = 'MZ615';
  END IF;

  UPDATE public.merch_marking_codes AS code
  SET
    pool_state = 'bound',
    revision = code.revision + 1,
    updated_at = now_at
  WHERE code.id = current_record.marking_code_id
    AND code.pool_state = 'reserved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserved marking code is unavailable'
      USING ERRCODE = 'MZ613';
  END IF;

  UPDATE public.merch_marking_code_bindings AS binding
  SET
    status = 'active',
    label_state = 'applied',
    applied_at = now_at,
    updated_at = now_at
  WHERE binding.id = current_record.code_binding_id;

  UPDATE public.merch_marking_units AS unit
  SET
    unit_state = 'marking_pending',
    last_stock_transaction_id = p_stock_transaction_id,
    version = unit.version + 1,
    updated_at = now_at
  WHERE unit.id = current_record.marking_unit_id;

  UPDATE public.merch_marking_assignments AS assignment
  SET
    revision = assignment.revision + 1,
    updated_at = now_at
  WHERE assignment.id = current_record.id;

  UPDATE public.merch_marking_processes AS process
  SET
    status = 'waiting_external',
    current_step = 'marking_applied',
    next_action = 'Подготовить документы ГИС МТ',
    version = process.version + 1,
    updated_at = now_at
  WHERE process.id = current_record.process_id;

  INSERT INTO public.merch_marking_events (
    marking_code_id,
    marking_unit_id,
    code_binding_id,
    assignment_id,
    process_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    current_record.marking_code_id,
    current_record.marking_unit_id,
    current_record.code_binding_id,
    current_record.id,
    current_record.process_id,
    'marking_code_applied',
    'admin',
    p_actor_id,
    'admin_marking_assignment',
    jsonb_build_object(
      'fulfillmentItemId', current_record.fulfillment_item_id,
      'stockTransactionId', p_stock_transaction_id,
      'gtin', current_record.gtin_snapshot
    ),
    now_at
  );

  RETURN QUERY SELECT
    current_record.id::uuid,
    (current_record.revision + 1)::bigint,
    'marking_pending'::text,
    'active'::text,
    'applied'::text,
    'bound'::text,
    'waiting_external'::text;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.cancel_jit_assignment(
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_actor_id text
)
RETURNS TABLE (
  assignment_id uuid,
  assignment_status text,
  assignment_revision bigint,
  unit_state text,
  binding_status text,
  code_pool_state text,
  process_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_record record;
  now_at timestamp with time zone := clock_timestamp();
  next_assignment_status text;
  next_unit_state text;
  next_code_state text;
  next_process_status text;
BEGIN
  IF p_assignment_id IS NULL
     OR p_expected_revision IS NULL
     OR p_expected_revision < 1
     OR p_reason IS NULL
     OR length(trim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid JIT cancellation parameters'
      USING ERRCODE = 'MZ616';
  END IF;

  SELECT
    assignment.id,
    assignment.revision,
    assignment.status AS assignment_status,
    assignment.marking_unit_id,
    assignment.code_binding_id,
    unit.unit_state,
    binding.marking_code_id,
    binding.status AS binding_status,
    binding.label_state,
    code.pool_state,
    process.id AS process_id
  INTO current_record
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_units AS unit
    ON unit.id = assignment.marking_unit_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_codes AS code
    ON code.id = binding.marking_code_id
  LEFT JOIN public.merch_marking_processes AS process
    ON process.assignment_id = assignment.id
   AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
  WHERE assignment.id = p_assignment_id
  FOR UPDATE OF assignment, unit, binding, code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'JIT assignment not found' USING ERRCODE = 'MZ611';
  END IF;
  IF current_record.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'JIT assignment version conflict' USING ERRCODE = 'MZ612';
  END IF;
  IF current_record.assignment_status <> 'active'
     OR current_record.binding_status = 'active'
     OR current_record.label_state = 'applied'
     OR current_record.unit_state <> 'preparing' THEN
    RAISE EXCEPTION 'applied assignment requires manual unit resolution'
      USING ERRCODE = 'MZ617';
  END IF;

  IF current_record.label_state = 'not_rendered' THEN
    next_assignment_status := 'cancelled';
    next_unit_state := 'cancelled';
    next_code_state := 'available';
    next_process_status := 'cancelled';
  ELSE
    next_assignment_status := 'quarantined';
    next_unit_state := 'quarantined';
    next_code_state := 'quarantined';
    next_process_status := 'manual_review';
  END IF;

  UPDATE public.merch_marking_assignments AS assignment
  SET
    status = next_assignment_status,
    released_at = now_at,
    release_reason = trim(p_reason),
    revision = assignment.revision + 1,
    updated_at = now_at
  WHERE assignment.id = current_record.id;

  UPDATE public.merch_marking_code_bindings AS binding
  SET
    status = 'cancelled',
    updated_at = now_at
  WHERE binding.id = current_record.code_binding_id;

  UPDATE public.merch_marking_units AS unit
  SET
    unit_state = next_unit_state,
    version = unit.version + 1,
    updated_at = now_at
  WHERE unit.id = current_record.marking_unit_id;

  UPDATE public.merch_marking_codes AS code
  SET
    pool_state = next_code_state,
    blocked_reason = CASE
      WHEN next_code_state = 'quarantined' THEN trim(p_reason)
      ELSE NULL
    END,
    quarantined_at = CASE
      WHEN next_code_state = 'quarantined' THEN now_at
      ELSE NULL
    END,
    quarantined_by = CASE
      WHEN next_code_state = 'quarantined' THEN p_actor_id
      ELSE NULL
    END,
    revision = code.revision + 1,
    updated_at = now_at
  WHERE code.id = current_record.marking_code_id
    AND code.pool_state = 'reserved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserved marking code is unavailable'
      USING ERRCODE = 'MZ613';
  END IF;

  UPDATE public.merch_marking_processes AS process
  SET
    status = next_process_status,
    current_step = 'assignment_cancelled',
    next_action = CASE
      WHEN next_process_status = 'manual_review'
        THEN 'Разобрать распечатанный КМ в карантине'
      ELSE NULL
    END,
    manual_review_reason = CASE
      WHEN next_process_status = 'manual_review' THEN trim(p_reason)
      ELSE NULL
    END,
    completed_at = CASE
      WHEN next_process_status = 'cancelled' THEN now_at
      ELSE NULL
    END,
    version = process.version + 1,
    updated_at = now_at
  WHERE process.id = current_record.process_id;

  INSERT INTO public.merch_marking_events (
    marking_code_id,
    marking_unit_id,
    code_binding_id,
    assignment_id,
    process_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    current_record.marking_code_id,
    current_record.marking_unit_id,
    current_record.code_binding_id,
    current_record.id,
    current_record.process_id,
    'jit_assignment_cancelled',
    'admin',
    p_actor_id,
    'admin_marking_assignment',
    jsonb_build_object(
      'assignmentStatus', next_assignment_status,
      'codePoolState', next_code_state,
      'labelState', current_record.label_state,
      'reason', trim(p_reason)
    ),
    now_at
  );

  RETURN QUERY SELECT
    current_record.id::uuid,
    next_assignment_status,
    (current_record.revision + 1)::bigint,
    next_unit_state,
    'cancelled'::text,
    next_code_state,
    next_process_status;
END
$function$;

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
DECLARE
  item_record record;
  assignment_record record;
  now_at timestamp with time zone := clock_timestamp();
  affected integer := 0;
  successful_handoff boolean;
BEGIN
  SELECT
    item.id,
    item.quantity,
    item.source_active,
    fulfillment_order.source_status
  INTO item_record
  FROM public.merch_fulfillment_order_items AS item
  JOIN public.merch_fulfillment_orders AS fulfillment_order
    ON fulfillment_order.id = item.fulfillment_order_id
  WHERE item.id = p_fulfillment_item_id
  FOR UPDATE OF item;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  successful_handoff := item_record.source_status = ANY (
    ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
          'sent_by_seller'::text]
  );

  FOR assignment_record IN
    SELECT
      assignment.id,
      assignment.unit_ordinal,
      assignment.marking_unit_id,
      assignment.code_binding_id,
      binding.marking_code_id,
      binding.status AS binding_status,
      binding.label_state,
      process.id AS process_id
    FROM public.merch_marking_assignments AS assignment
    JOIN public.merch_marking_code_bindings AS binding
      ON binding.id = assignment.code_binding_id
    LEFT JOIN public.merch_marking_processes AS process
      ON process.assignment_id = assignment.id
     AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
    WHERE assignment.fulfillment_item_id = item_record.id
      AND assignment.status = 'active'
      AND (
        NOT item_record.source_active
        OR assignment.unit_ordinal > item_record.quantity
      )
    ORDER BY assignment.unit_ordinal DESC, assignment.id
    FOR UPDATE OF assignment, binding
  LOOP
    IF assignment_record.binding_status = 'active'
       AND assignment_record.label_state = 'applied' THEN
      UPDATE public.merch_marking_assignments AS assignment
      SET
        status = CASE WHEN successful_handoff THEN 'completed' ELSE 'released' END,
        released_at = CASE WHEN successful_handoff THEN NULL ELSE now_at END,
        release_reason = CASE
          WHEN successful_handoff THEN NULL
          ELSE coalesce(p_reason, 'fulfillment_item_reconciled_after_apply')
        END,
        completed_at = CASE WHEN successful_handoff THEN now_at ELSE NULL END,
        revision = assignment.revision + 1,
        updated_at = now_at
      WHERE assignment.id = assignment_record.id;

      UPDATE public.merch_marking_units AS unit
      SET
        unit_state = CASE WHEN successful_handoff THEN 'shipped' ELSE 'quarantined' END,
        custody_state = CASE WHEN successful_handoff THEN 'ozon' ELSE 'getomerch' END,
        version = unit.version + 1,
        updated_at = now_at
      WHERE unit.id = assignment_record.marking_unit_id;

      UPDATE public.merch_marking_processes AS process
      SET
        status = CASE WHEN successful_handoff THEN 'waiting_external' ELSE 'manual_review' END,
        current_step = CASE
          WHEN successful_handoff THEN 'handed_to_channel'
          ELSE 'assignment_reconciled_after_apply'
        END,
        next_action = CASE
          WHEN successful_handoff THEN 'Завершить документы ГИС МТ и Ozon'
          ELSE 'Определить судьбу маркированной единицы'
        END,
        manual_review_reason = CASE
          WHEN successful_handoff THEN NULL
          ELSE coalesce(p_reason, 'fulfillment_item_reconciled_after_apply')
        END,
        version = process.version + 1,
        updated_at = now_at
      WHERE process.id = assignment_record.process_id;
    ELSIF assignment_record.label_state = 'not_rendered' THEN
      UPDATE public.merch_marking_assignments AS assignment
      SET
        status = 'released',
        released_at = now_at,
        release_reason = coalesce(p_reason, 'fulfillment_item_reconciled'),
        revision = assignment.revision + 1,
        updated_at = now_at
      WHERE assignment.id = assignment_record.id;
      UPDATE public.merch_marking_code_bindings AS binding
      SET status = 'cancelled', updated_at = now_at
      WHERE binding.id = assignment_record.code_binding_id;
      UPDATE public.merch_marking_units AS unit
      SET
        unit_state = 'cancelled',
        version = unit.version + 1,
        updated_at = now_at
      WHERE unit.id = assignment_record.marking_unit_id;
      UPDATE public.merch_marking_codes AS code
      SET
        pool_state = 'available',
        revision = code.revision + 1,
        updated_at = now_at
      WHERE code.id = assignment_record.marking_code_id
        AND code.pool_state = 'reserved';
      UPDATE public.merch_marking_processes AS process
      SET
        status = 'cancelled',
        current_step = 'assignment_reconciled',
        next_action = NULL,
        completed_at = now_at,
        version = process.version + 1,
        updated_at = now_at
      WHERE process.id = assignment_record.process_id;
    ELSE
      UPDATE public.merch_marking_assignments AS assignment
      SET
        status = 'quarantined',
        released_at = now_at,
        release_reason = coalesce(p_reason, 'fulfillment_item_reconciled_after_render'),
        revision = assignment.revision + 1,
        updated_at = now_at
      WHERE assignment.id = assignment_record.id;
      UPDATE public.merch_marking_code_bindings AS binding
      SET status = 'cancelled', updated_at = now_at
      WHERE binding.id = assignment_record.code_binding_id;
      UPDATE public.merch_marking_units AS unit
      SET
        unit_state = 'quarantined',
        version = unit.version + 1,
        updated_at = now_at
      WHERE unit.id = assignment_record.marking_unit_id;
      UPDATE public.merch_marking_codes AS code
      SET
        pool_state = 'quarantined',
        blocked_reason = coalesce(p_reason, 'fulfillment_item_reconciled_after_render'),
        quarantined_at = now_at,
        quarantined_by = coalesce(p_actor_id, 'system'),
        revision = code.revision + 1,
        updated_at = now_at
      WHERE code.id = assignment_record.marking_code_id
        AND code.pool_state = 'reserved';
      UPDATE public.merch_marking_processes AS process
      SET
        status = 'manual_review',
        current_step = 'assignment_reconciled_after_render',
        next_action = 'Разобрать распечатанный КМ в карантине',
        manual_review_reason = coalesce(
          p_reason,
          'fulfillment_item_reconciled_after_render'
        ),
        version = process.version + 1,
        updated_at = now_at
      WHERE process.id = assignment_record.process_id;
    END IF;

    INSERT INTO public.merch_marking_events (
      marking_code_id,
      marking_unit_id,
      code_binding_id,
      assignment_id,
      process_id,
      event_type,
      actor_type,
      actor_id,
      source,
      details_redacted,
      occurred_at
    )
    VALUES (
      assignment_record.marking_code_id,
      assignment_record.marking_unit_id,
      assignment_record.code_binding_id,
      assignment_record.id,
      assignment_record.process_id,
      'jit_assignment_reconciled',
      'system',
      coalesce(p_actor_id, 'system'),
      'fulfillment_projection',
      jsonb_build_object(
        'unitOrdinal', assignment_record.unit_ordinal,
        'quantity', item_record.quantity,
        'sourceActive', item_record.source_active,
        'sourceStatus', item_record.source_status,
        'labelState', assignment_record.label_state,
        'successfulHandoff', successful_handoff,
        'reason', coalesce(p_reason, 'fulfillment_item_reconciled')
      ),
      now_at
    );
    affected := affected + 1;
  END LOOP;

  RETURN affected;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.reconcile_jit_item_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.source_active IS DISTINCT FROM OLD.source_active THEN
    PERFORM getomerch_marking.reconcile_jit_assignments_for_item(
      NEW.id,
      'fulfillment-trigger',
      CASE
        WHEN NOT NEW.source_active THEN 'fulfillment_item_inactive'
        WHEN NEW.quantity < OLD.quantity THEN 'fulfillment_quantity_decreased'
        ELSE 'fulfillment_item_changed'
      END
    );
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER merch_fulfillment_items_reconcile_marking
AFTER UPDATE OF quantity, source_active
ON public.merch_fulfillment_order_items
FOR EACH ROW
EXECUTE FUNCTION getomerch_marking.reconcile_jit_item_trigger();

CREATE OR REPLACE FUNCTION getomerch_marking.reconcile_jit_order_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  item_record record;
BEGIN
  IF NEW.source_status IS DISTINCT FROM OLD.source_status
     AND NEW.source_status = ANY (
       ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
             'sent_by_seller'::text, 'arbitration'::text,
             'client_arbitration'::text, 'not_accepted'::text,
             'cancelled'::text]
     ) THEN
    FOR item_record IN
      SELECT item.id
      FROM public.merch_fulfillment_order_items AS item
      WHERE item.fulfillment_order_id = NEW.id
      ORDER BY item.id
    LOOP
      PERFORM getomerch_marking.reconcile_jit_assignments_for_item(
        item_record.id,
        'fulfillment-trigger',
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

CREATE VIEW getomerch_marking.assignment_safe
WITH (security_barrier = true)
AS
SELECT
  assignment.id,
  assignment.fulfillment_item_id,
  item.fulfillment_order_id,
  fulfillment_order.source_channel,
  fulfillment_order.external_posting_number,
  fulfillment_order.source_status,
  item.offer_id,
  item.product_id,
  product.sku,
  item.quantity AS item_quantity,
  assignment.unit_ordinal,
  assignment.product_profile_id,
  assignment.gtin_snapshot,
  assignment.status AS assignment_status,
  assignment.revision AS assignment_revision,
  assignment.assigned_by,
  assignment.assigned_at,
  assignment.released_at,
  assignment.release_reason,
  assignment.completed_at,
  unit.id AS marking_unit_id,
  unit.internal_serial,
  unit.unit_state,
  unit.custody_state,
  unit.warehouse_id,
  warehouse.name AS warehouse_name,
  binding.id AS code_binding_id,
  binding.status AS binding_status,
  binding.label_state,
  binding.template_version,
  binding.render_count,
  binding.print_confirmed_count,
  code.id AS marking_code_id,
  code.fingerprint AS code_fingerprint,
  code.pool_state AS code_pool_state,
  code.crpt_state,
  process.id AS process_id,
  process.status AS process_status,
  process.current_step,
  process.next_action,
  assignment.created_at,
  assignment.updated_at
FROM public.merch_marking_assignments AS assignment
JOIN public.merch_fulfillment_order_items AS item
  ON item.id = assignment.fulfillment_item_id
JOIN public.merch_fulfillment_orders AS fulfillment_order
  ON fulfillment_order.id = item.fulfillment_order_id
JOIN public.merch_products AS product
  ON product.id = item.product_id
JOIN public.merch_marking_units AS unit
  ON unit.id = assignment.marking_unit_id
JOIN public.merch_marking_code_bindings AS binding
  ON binding.id = assignment.code_binding_id
JOIN public.merch_marking_codes AS code
  ON code.id = binding.marking_code_id
LEFT JOIN public.merch_warehouses AS warehouse
  ON warehouse.id = unit.warehouse_id
LEFT JOIN public.merch_marking_processes AS process
  ON process.assignment_id = assignment.id
 AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text]);

CREATE VIEW getomerch_marking.jit_candidate_safe
WITH (security_barrier = true)
AS
SELECT
  item.id AS fulfillment_item_id,
  item.fulfillment_order_id,
  fulfillment_order.source_channel,
  fulfillment_order.external_posting_number,
  fulfillment_order.source_status,
  item.offer_id,
  item.product_id,
  product.sku,
  item.quantity,
  item.marking_requirement,
  item.exemplar_flow_available,
  item.source_active,
  profile.id AS product_profile_id,
  profile.operational_status,
  profile.verification_status AS profile_verification_status,
  profile.production_mode,
  profile.fulfillment_marking_mode,
  trade_item.id AS trade_item_id,
  trade_item.gtin,
  warehouse.id AS warehouse_id,
  warehouse.name AS warehouse_name,
  warehouse.type AS warehouse_type,
  blank.id AS blank_product_id,
  coalesce(blank_inventory.quantity, 0)::integer AS blank_quantity,
  decoration.slug AS decoration_slug,
  decoration.made_at AS decoration_made_at,
  coalesce(print_inventory.quantity, 0)::integer AS decoration_quantity,
  coalesce(code_count.available_code_count, 0)::integer AS available_code_count,
  coalesce(assignment_count.active_assignment_count, 0)::integer
    AS active_assignment_count,
  greatest(
    item.quantity - coalesce(assignment_count.active_assignment_count, 0),
    0
  )::integer AS unassigned_quantity,
  item.updated_at
FROM public.merch_fulfillment_order_items AS item
JOIN public.merch_fulfillment_orders AS fulfillment_order
  ON fulfillment_order.id = item.fulfillment_order_id
JOIN public.merch_products AS product
  ON product.id = item.product_id
JOIN public.merch_decoration_types AS decoration
  ON decoration.id = product.decoration_type_id
LEFT JOIN public.merch_marking_product_profiles AS profile
  ON profile.product_id = product.id
 AND profile.archived_at IS NULL
LEFT JOIN public.merch_marking_trade_items AS trade_item
  ON trade_item.id = profile.trade_item_id
JOIN public.merch_warehouses AS warehouse
  ON warehouse.type = decoration.made_at
LEFT JOIN public.merch_products AS blank
  ON blank.is_blank
 AND blank.category_id = product.category_id
 AND blank.fabric_id = product.fabric_id
 AND blank.color_id = product.color_id
 AND blank.size_id = product.size_id
LEFT JOIN public.merch_inventory AS blank_inventory
  ON blank_inventory.product_id = blank.id
 AND blank_inventory.warehouse_id = warehouse.id
LEFT JOIN public.merch_print_inventory AS print_inventory
  ON print_inventory.design_id = product.design_id
 AND print_inventory.warehouse_id = warehouse.id
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS available_code_count
  FROM public.merch_marking_codes AS code
  WHERE code.trade_item_id = trade_item.id
    AND code.pool_state = 'available'
    AND code.crpt_state = ANY (ARRAY['emitted'::text, 'applied'::text])
) AS code_count ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS active_assignment_count
  FROM public.merch_marking_assignments AS assignment
  WHERE assignment.fulfillment_item_id = item.id
    AND assignment.status = 'active'
) AS assignment_count ON true
WHERE item.marking_requirement = 'required'
  AND item.source_active
  AND fulfillment_order.source_status <> ALL (
    ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
          'sent_by_seller'::text, 'arbitration'::text,
          'client_arbitration'::text, 'not_accepted'::text,
          'cancelled'::text]
  );

REVOKE ALL ON
  public.merch_marking_units,
  public.merch_marking_code_bindings,
  public.merch_marking_assignments
FROM getomerch_app;

REVOKE ALL ON FUNCTION getomerch_marking.prepare_jit_assignment(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.lock_jit_assignment_for_apply(
  uuid, bigint, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.complete_jit_application(
  uuid, bigint, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.cancel_jit_assignment(
  uuid, bigint, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.reconcile_jit_assignments_for_item(
  uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.reconcile_jit_item_trigger()
FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.reconcile_jit_order_trigger()
FROM PUBLIC;

GRANT SELECT ON
  public.merch_marking_units,
  public.merch_marking_code_bindings,
  public.merch_marking_assignments
TO getomerch_backup;

GRANT SELECT ON
  getomerch_marking.assignment_safe,
  getomerch_marking.jit_candidate_safe
TO getomerch_app, getomerch_backup;

GRANT EXECUTE ON FUNCTION getomerch_marking.prepare_jit_assignment(
  uuid, uuid, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.lock_jit_assignment_for_apply(
  uuid, bigint, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.complete_jit_application(
  uuid, bigint, uuid, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.cancel_jit_assignment(
  uuid, bigint, text, text
) TO getomerch_app;

COMMENT ON TABLE public.merch_marking_units IS
  'Serialized physical-unit subledger; preparing units are not aggregate stock.';
COMMENT ON TABLE public.merch_marking_code_bindings IS
  'Historical marking-code bindings; a rendered binding is never silently released.';
COMMENT ON TABLE public.merch_marking_assignments IS
  'Historical physical-unit assignments to fulfillment item unit slots.';
COMMENT ON VIEW getomerch_marking.assignment_safe IS
  'Operational assignment view without encrypted marking-code material.';
COMMENT ON FUNCTION getomerch_marking.complete_jit_application(
  uuid, bigint, uuid, text
) IS
  'Completes marking state after an atomic production movement created in the same transaction.';
