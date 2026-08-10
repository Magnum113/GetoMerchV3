-- Stage 7: protected label material access, deterministic label-render
-- accounting and server-computed assignment actions. PDF bytes remain
-- ephemeral and are never stored in PostgreSQL.

CREATE OR REPLACE FUNCTION getomerch_marking.get_jit_label_material(
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_actor_id text
)
RETURNS TABLE (
  assignment_id uuid,
  assignment_revision bigint,
  code_binding_id uuid,
  encryption_key_version integer,
  code_ciphertext bytea,
  code_nonce bytea,
  code_auth_tag bytea,
  gtin text,
  code_fingerprint text,
  offer_id text,
  product_sku text,
  posting_number text,
  unit_ordinal integer,
  item_quantity integer,
  label_state text,
  render_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_record record;
BEGIN
  IF p_assignment_id IS NULL
     OR p_expected_revision IS NULL
     OR p_expected_revision < 1
     OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid label material parameters'
      USING ERRCODE = 'MZ700';
  END IF;

  SELECT
    assignment.id,
    assignment.revision,
    assignment.status AS assignment_status,
    assignment.code_binding_id,
    assignment.unit_ordinal,
    binding.status AS binding_status,
    binding.label_state,
    binding.render_count,
    code.encryption_key_version,
    code.code_ciphertext,
    code.code_nonce,
    code.code_auth_tag,
    code.gtin_snapshot,
    code.fingerprint,
    code.pool_state,
    code.crpt_state,
    unit.unit_state,
    item.quantity,
    item.offer_id,
    item.source_active,
    product.sku,
    profile.verification_status AS profile_verification_status,
    profile.operational_status AS profile_operational_status,
    fulfillment_order.external_posting_number,
    fulfillment_order.source_status
  INTO current_record
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_codes AS code
    ON code.id = binding.marking_code_id
  JOIN public.merch_marking_units AS unit
    ON unit.id = assignment.marking_unit_id
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_fulfillment_orders AS fulfillment_order
    ON fulfillment_order.id = item.fulfillment_order_id
  JOIN public.merch_products AS product
    ON product.id = item.product_id
  JOIN public.merch_marking_product_profiles AS profile
    ON profile.id = assignment.product_profile_id
  WHERE assignment.id = p_assignment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking assignment not found'
      USING ERRCODE = 'MZ701';
  END IF;
  IF current_record.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking assignment version conflict'
      USING ERRCODE = 'MZ702';
  END IF;
  IF current_record.assignment_status <> 'active'
     OR current_record.binding_status <> ALL (
       ARRAY['planned'::text, 'active'::text]
     )
     OR current_record.label_state <> ALL (
       ARRAY['not_rendered'::text, 'label_rendered'::text,
             'printed'::text, 'applied'::text]
     )
     OR current_record.unit_state <> ALL (
       ARRAY['preparing'::text, 'marking_pending'::text, 'ready'::text]
     )
     OR current_record.pool_state <> ALL (
       ARRAY['reserved'::text, 'bound'::text]
     )
     OR current_record.crpt_state = ANY (
       ARRAY['withdrawn'::text, 'invalid'::text]
     )
     OR current_record.profile_verification_status <> 'verified'
     OR current_record.profile_operational_status <> 'enabled'
     OR NOT current_record.source_active
     OR current_record.unit_ordinal > current_record.quantity
     OR current_record.source_status = ANY (
       ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
             'sent_by_seller'::text, 'arbitration'::text,
             'client_arbitration'::text, 'not_accepted'::text,
             'cancelled'::text]
     ) THEN
    RAISE EXCEPTION 'label is not available for this assignment'
      USING ERRCODE = 'MZ703';
  END IF;

  RETURN QUERY SELECT
    current_record.id::uuid,
    current_record.revision::bigint,
    current_record.code_binding_id::uuid,
    current_record.encryption_key_version::integer,
    current_record.code_ciphertext::bytea,
    current_record.code_nonce::bytea,
    current_record.code_auth_tag::bytea,
    current_record.gtin_snapshot::text,
    current_record.fingerprint::text,
    current_record.offer_id::text,
    current_record.sku::text,
    current_record.external_posting_number::text,
    current_record.unit_ordinal::integer,
    current_record.quantity::integer,
    current_record.label_state::text,
    current_record.render_count::integer;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_jit_label_render(
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_code_binding_id uuid,
  p_code_fingerprint text,
  p_template_version text,
  p_actor_id text
)
RETURNS TABLE (
  assignment_id uuid,
  assignment_revision bigint,
  label_state text,
  render_count integer,
  template_version text,
  rendered_at timestamp with time zone,
  is_reprint boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_record record;
  now_at timestamp with time zone := clock_timestamp();
  next_label_state text;
BEGIN
  IF p_assignment_id IS NULL
     OR p_expected_revision IS NULL
     OR p_expected_revision < 1
     OR p_code_binding_id IS NULL
     OR p_code_fingerprint IS NULL
     OR p_code_fingerprint !~ '^[0-9a-f]{12}$'
     OR p_template_version IS NULL
     OR length(p_template_version) NOT BETWEEN 1 AND 120
     OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid label render parameters'
      USING ERRCODE = 'MZ700';
  END IF;

  SELECT
    assignment.id,
    assignment.revision,
    assignment.status AS assignment_status,
    assignment.fulfillment_item_id,
    assignment.marking_unit_id,
    assignment.code_binding_id,
    assignment.gtin_snapshot,
    assignment.unit_ordinal,
    binding.marking_code_id,
    binding.status AS binding_status,
    binding.label_state,
    binding.render_count,
    code.fingerprint,
    code.pool_state,
    code.crpt_state,
    unit.unit_state,
    item.quantity,
    item.source_active,
    fulfillment_order.source_status,
    process.id AS process_id
  INTO current_record
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_codes AS code
    ON code.id = binding.marking_code_id
  JOIN public.merch_marking_units AS unit
    ON unit.id = assignment.marking_unit_id
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_fulfillment_orders AS fulfillment_order
    ON fulfillment_order.id = item.fulfillment_order_id
  LEFT JOIN public.merch_marking_processes AS process
    ON process.assignment_id = assignment.id
   AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
  WHERE assignment.id = p_assignment_id
  FOR UPDATE OF assignment, binding, code, unit, item;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking assignment not found'
      USING ERRCODE = 'MZ701';
  END IF;
  IF current_record.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking assignment version conflict'
      USING ERRCODE = 'MZ702';
  END IF;
  IF current_record.code_binding_id <> p_code_binding_id
     OR current_record.fingerprint <> p_code_fingerprint THEN
    RAISE EXCEPTION 'marking binding changed before label render'
      USING ERRCODE = 'MZ704';
  END IF;
  IF current_record.assignment_status <> 'active'
     OR current_record.binding_status <> ALL (
       ARRAY['planned'::text, 'active'::text]
     )
     OR current_record.label_state <> ALL (
       ARRAY['not_rendered'::text, 'label_rendered'::text,
             'printed'::text, 'applied'::text]
     )
     OR current_record.unit_state <> ALL (
       ARRAY['preparing'::text, 'marking_pending'::text, 'ready'::text]
     )
     OR current_record.pool_state <> ALL (
       ARRAY['reserved'::text, 'bound'::text]
     )
     OR current_record.crpt_state = ANY (
       ARRAY['withdrawn'::text, 'invalid'::text]
     )
     OR NOT current_record.source_active
     OR current_record.unit_ordinal > current_record.quantity
     OR current_record.source_status = ANY (
       ARRAY['delivering'::text, 'delivered'::text, 'driver_pickup'::text,
             'sent_by_seller'::text, 'arbitration'::text,
             'client_arbitration'::text, 'not_accepted'::text,
             'cancelled'::text]
     ) THEN
    RAISE EXCEPTION 'label is not available for this assignment'
      USING ERRCODE = 'MZ703';
  END IF;

  next_label_state := CASE
    WHEN current_record.label_state = 'applied' THEN 'applied'
    ELSE 'label_rendered'
  END;

  UPDATE public.merch_marking_code_bindings AS binding
  SET
    label_state = next_label_state,
    template_version = p_template_version,
    render_count = binding.render_count + 1,
    first_rendered_at = coalesce(binding.first_rendered_at, now_at),
    last_rendered_at = now_at,
    updated_at = now_at
  WHERE binding.id = current_record.code_binding_id;

  UPDATE public.merch_marking_codes AS code
  SET
    label_exposed_at = coalesce(code.label_exposed_at, now_at),
    revision = code.revision + 1,
    updated_at = now_at
  WHERE code.id = current_record.marking_code_id;

  UPDATE public.merch_marking_assignments AS assignment
  SET
    revision = assignment.revision + 1,
    updated_at = now_at
  WHERE assignment.id = current_record.id;

  IF current_record.unit_state = 'preparing' THEN
    UPDATE public.merch_marking_processes AS process
    SET
      status = 'waiting_user',
      current_step = 'label_rendered',
      next_action = 'Нанести КМ и подтвердить нанесение',
      version = process.version + 1,
      updated_at = now_at
    WHERE process.id = current_record.process_id;
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
    current_record.marking_code_id,
    current_record.marking_unit_id,
    current_record.code_binding_id,
    current_record.id,
    current_record.process_id,
    CASE
      WHEN current_record.render_count = 0 THEN 'marking_label_generated'
      ELSE 'marking_label_reprinted'
    END,
    'admin',
    p_actor_id,
    'admin_marking_label',
    jsonb_build_object(
      'gtin', current_record.gtin_snapshot,
      'fingerprint', current_record.fingerprint,
      'unitOrdinal', current_record.unit_ordinal,
      'templateVersion', p_template_version,
      'renderCount', current_record.render_count + 1,
      'pageMillimeters', jsonb_build_array(58, 40)
    ),
    now_at
  );

  RETURN QUERY SELECT
    current_record.id::uuid,
    (current_record.revision + 1)::bigint,
    next_label_state,
    (current_record.render_count + 1)::integer,
    p_template_version,
    now_at,
    (current_record.render_count > 0);
END
$function$;

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
  'not_started'::text AS ozon_state,
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
  CASE
    WHEN assignment.assignment_status <> 'active'
      THEN 'Подготовка единицы не активна'
    WHEN assignment.label_state <> 'applied'
      THEN 'КМ не нанесён'
    WHEN assignment.crpt_state <> ALL (
      ARRAY['introduced'::text, 'in_circulation'::text]
    )
      THEN 'Ожидается ввод в оборот'
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
) AS latest_event ON true;

CREATE VIEW getomerch_marking.jit_candidate_action_safe
WITH (security_barrier = true)
AS
SELECT
  candidate.fulfillment_item_id,
  candidate.fulfillment_order_id,
  candidate.source_channel,
  candidate.external_posting_number,
  candidate.source_status,
  candidate.offer_id,
  candidate.product_id,
  candidate.sku,
  candidate.quantity,
  candidate.marking_requirement,
  candidate.exemplar_flow_available,
  candidate.source_active,
  candidate.product_profile_id,
  candidate.operational_status,
  candidate.profile_verification_status,
  candidate.production_mode,
  candidate.fulfillment_marking_mode,
  candidate.trade_item_id,
  candidate.gtin,
  candidate.warehouse_id,
  candidate.warehouse_name,
  candidate.warehouse_type,
  candidate.blank_product_id,
  candidate.blank_quantity,
  candidate.decoration_slug,
  candidate.decoration_made_at,
  candidate.decoration_quantity,
  candidate.available_code_count,
  candidate.active_assignment_count,
  candidate.unassigned_quantity,
  (
    candidate.product_profile_id IS NOT NULL
    AND candidate.gtin IS NOT NULL
    AND candidate.operational_status = 'enabled'
    AND candidate.profile_verification_status = 'verified'
    AND candidate.fulfillment_marking_mode = 'jit_after_order'
    AND (
      candidate.source_channel <> 'ozon_fbs'
      OR candidate.exemplar_flow_available IS TRUE
    )
    AND candidate.blank_product_id IS NOT NULL
    AND candidate.blank_quantity > 0
    AND (
      candidate.decoration_slug <> 'print'
      OR candidate.decoration_quantity > 0
    )
    AND candidate.available_code_count > 0
    AND candidate.unassigned_quantity > 0
  ) AS can_prepare,
  CASE
    WHEN candidate.product_profile_id IS NULL OR candidate.gtin IS NULL
      THEN 'Нет готового профиля и GTIN'
    WHEN candidate.operational_status <> 'enabled'
      THEN 'Профиль не включён'
    WHEN candidate.profile_verification_status <> 'verified'
      THEN 'Профиль не подтверждён'
    WHEN candidate.fulfillment_marking_mode <> 'jit_after_order'
      THEN 'Профиль не в режиме JIT'
    WHEN candidate.source_channel = 'ozon_fbs'
      AND candidate.exemplar_flow_available IS DISTINCT FROM true
      THEN 'Ozon не подтвердил ввод экземпляров'
    WHEN candidate.blank_product_id IS NULL OR candidate.blank_quantity < 1
      THEN 'Нет пустого изделия'
    WHEN candidate.decoration_slug = 'print'
      AND candidate.decoration_quantity < 1
      THEN 'Нет принта'
    WHEN candidate.available_code_count < 1
      THEN 'Нет доступного КМ'
    WHEN candidate.unassigned_quantity < 1
      THEN 'Все единицы уже получили КМ'
    ELSE NULL
  END AS prepare_blocker,
  candidate.updated_at
FROM getomerch_marking.jit_candidate_safe AS candidate;

REVOKE ALL ON FUNCTION getomerch_marking.get_jit_label_material(
  uuid, bigint, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_jit_label_render(
  uuid, bigint, uuid, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.get_jit_label_material(
  uuid, bigint, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_jit_label_render(
  uuid, bigint, uuid, text, text, text
) TO getomerch_app;
GRANT SELECT ON
  getomerch_marking.assignment_action_safe,
  getomerch_marking.jit_candidate_action_safe
TO getomerch_app, getomerch_backup;

COMMENT ON FUNCTION getomerch_marking.get_jit_label_material(
  uuid, bigint, text
) IS
  'Narrow server-only path for encrypted label material; never expose its result through JSON.';
COMMENT ON FUNCTION getomerch_marking.record_jit_label_render(
  uuid, bigint, uuid, text, text, text
) IS
  'Records a successfully generated 58x40 label without asserting physical application.';
COMMENT ON VIEW getomerch_marking.assignment_action_safe IS
  'Redacted assignment projection with server-computed operator capabilities and blockers.';
COMMENT ON VIEW getomerch_marking.jit_candidate_action_safe IS
  'Redacted JIT candidate projection with server-computed preparation capability.';
