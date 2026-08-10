-- Stage 4 marking product readiness, exact product/channel mappings and
-- auditable draft backfill. This migration performs no external API writes
-- and never infers or activates a GTIN from a product name.

ALTER TABLE public.merch_marking_trade_items
    ADD COLUMN declared_product_type text,
    ADD COLUMN declared_fabric text,
    ADD COLUMN declared_color text,
    ADD COLUMN declared_size_int text,
    ADD COLUMN declared_size_ru text,
    ADD COLUMN declared_composition text;

ALTER TABLE public.merch_marking_trade_items
    ADD CONSTRAINT merch_marking_trade_items_declared_attribute_check
      CHECK (
        (declared_product_type IS NULL OR length(declared_product_type) BETWEEN 1 AND 200)
        AND (declared_fabric IS NULL OR length(declared_fabric) BETWEEN 1 AND 200)
        AND (declared_color IS NULL OR length(declared_color) BETWEEN 1 AND 200)
        AND (declared_size_int IS NULL OR length(declared_size_int) BETWEEN 1 AND 80)
        AND (declared_size_ru IS NULL OR length(declared_size_ru) BETWEEN 1 AND 80)
        AND (declared_composition IS NULL OR length(declared_composition) BETWEEN 1 AND 500)
      );

ALTER TABLE public.merch_marking_product_profiles
    ADD COLUMN marking_requirement text DEFAULT 'unknown'::text NOT NULL,
    ADD COLUMN marking_requirement_source text,
    ADD COLUMN marking_requirement_observed_at timestamp with time zone,
    ADD COLUMN operational_status text DEFAULT 'draft'::text NOT NULL,
    ADD COLUMN operational_status_reason text,
    ADD COLUMN operational_changed_at timestamp with time zone,
    ADD COLUMN operational_changed_by text,
    ADD COLUMN revision bigint DEFAULT 1 NOT NULL;

UPDATE public.merch_marking_product_profiles
SET marking_requirement = CASE
      WHEN requires_marking THEN 'required'
      ELSE 'unknown'
    END,
    marking_requirement_source = CASE
      WHEN requires_marking THEN coalesce(verification_source, 'stage3_migration')
      ELSE NULL
    END,
    marking_requirement_observed_at = CASE
      WHEN requires_marking THEN coalesce(verified_at, created_at)
      ELSE NULL
    END;

ALTER TABLE public.merch_marking_product_profiles
    ADD CONSTRAINT merch_marking_product_profiles_requirement_check
      CHECK (
        marking_requirement = ANY (
          ARRAY['unknown'::text, 'required'::text, 'not_required'::text]
        )
      ),
    ADD CONSTRAINT merch_marking_product_profiles_requirement_alignment_check
      CHECK (requires_marking = (marking_requirement = 'required')),
    ADD CONSTRAINT merch_marking_product_profiles_requirement_source_check
      CHECK (
        marking_requirement = 'unknown'
        OR (
          marking_requirement_source IS NOT NULL
          AND length(marking_requirement_source) BETWEEN 1 AND 200
          AND marking_requirement_observed_at IS NOT NULL
        )
      ),
    ADD CONSTRAINT merch_marking_product_profiles_operational_status_check
      CHECK (
        operational_status = ANY (
          ARRAY['draft'::text, 'enabled'::text, 'paused'::text]
        )
      ),
    ADD CONSTRAINT merch_marking_product_profiles_operational_reason_check
      CHECK (
        operational_status <> 'paused'
        OR (
          operational_status_reason IS NOT NULL
          AND length(operational_status_reason) BETWEEN 1 AND 1000
        )
      ),
    ADD CONSTRAINT merch_marking_product_profiles_operational_actor_check
      CHECK (
        operational_status = 'draft'
        OR (
          operational_changed_at IS NOT NULL
          AND operational_changed_by IS NOT NULL
          AND length(operational_changed_by) BETWEEN 1 AND 200
        )
      ),
    ADD CONSTRAINT merch_marking_product_profiles_revision_check
      CHECK (revision >= 1);

CREATE TABLE public.merch_marking_product_profile_channels (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    product_profile_id uuid NOT NULL
      REFERENCES public.merch_marking_product_profiles(id) ON DELETE RESTRICT,
    channel text NOT NULL,
    offer_id text,
    external_product_id text,
    external_sku text,
    marking_requirement text DEFAULT 'unknown'::text NOT NULL,
    requirement_source text,
    observed_at timestamp with time zone,
    source_snapshot_hash text,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_profile_channels_channel_check
      CHECK (channel = ANY (ARRAY['ozon_fbs'::text, 'komui'::text])),
    CONSTRAINT merch_marking_profile_channels_offer_check
      CHECK (offer_id IS NULL OR length(offer_id) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_profile_channels_product_check
      CHECK (
        external_product_id IS NULL
        OR length(external_product_id) BETWEEN 1 AND 200
      ),
    CONSTRAINT merch_marking_profile_channels_sku_check
      CHECK (external_sku IS NULL OR length(external_sku) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_profile_channels_requirement_check
      CHECK (
        marking_requirement = ANY (
          ARRAY['unknown'::text, 'required'::text, 'not_required'::text]
        )
      ),
    CONSTRAINT merch_marking_profile_channels_requirement_source_check
      CHECK (
        marking_requirement = 'unknown'
        OR (
          requirement_source IS NOT NULL
          AND length(requirement_source) BETWEEN 1 AND 200
          AND observed_at IS NOT NULL
        )
      ),
    CONSTRAINT merch_marking_profile_channels_snapshot_hash_check
      CHECK (
        source_snapshot_hash IS NULL
        OR source_snapshot_hash ~ '^[0-9a-f]{64}$'
      ),
    UNIQUE (product_profile_id, channel)
);

CREATE UNIQUE INDEX merch_marking_profile_channels_offer
  ON public.merch_marking_product_profile_channels (channel, offer_id)
  WHERE is_enabled AND offer_id IS NOT NULL;
CREATE INDEX merch_marking_profile_channels_external_sku
  ON public.merch_marking_product_profile_channels (channel, external_sku)
  WHERE is_enabled AND external_sku IS NOT NULL;

CREATE TABLE public.merch_marking_profile_backfill_runs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    status text DEFAULT 'preview'::text NOT NULL,
    source text NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    applied_by text,
    applied_at timestamp with time zone,
    CONSTRAINT merch_marking_profile_backfill_runs_status_check
      CHECK (status = ANY (ARRAY['preview'::text, 'applied'::text, 'failed'::text])),
    CONSTRAINT merch_marking_profile_backfill_runs_source_check
      CHECK (length(source) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_profile_backfill_runs_options_check
      CHECK (jsonb_typeof(options) = 'object' AND octet_length(options::text) <= 32768),
    CONSTRAINT merch_marking_profile_backfill_runs_summary_check
      CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 32768),
    CONSTRAINT merch_marking_profile_backfill_runs_apply_check
      CHECK (
        (status = 'applied' AND applied_by IS NOT NULL AND applied_at IS NOT NULL)
        OR status <> 'applied'
      )
);

CREATE TABLE public.merch_marking_profile_backfill_items (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    run_id uuid NOT NULL
      REFERENCES public.merch_marking_profile_backfill_runs(id) ON DELETE RESTRICT,
    product_id uuid NOT NULL
      REFERENCES public.merch_products(id) ON DELETE RESTRICT,
    action text NOT NULL,
    channel text NOT NULL,
    offer_id text,
    external_product_id text,
    external_sku text,
    proposed_requirement text DEFAULT 'unknown'::text NOT NULL,
    proposed_production_mode text NOT NULL,
    proposed_fulfillment_mode text NOT NULL,
    exact_gtin text,
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    errors text[] DEFAULT '{}'::text[] NOT NULL,
    warnings text[] DEFAULT '{}'::text[] NOT NULL,
    apply_status text DEFAULT 'pending'::text NOT NULL,
    applied_profile_id uuid
      REFERENCES public.merch_marking_product_profiles(id) ON DELETE RESTRICT,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT merch_marking_profile_backfill_items_action_check
      CHECK (action = ANY (ARRAY['create_draft'::text, 'skip'::text, 'conflict'::text])),
    CONSTRAINT merch_marking_profile_backfill_items_channel_check
      CHECK (channel = ANY (ARRAY['ozon_fbs'::text, 'komui'::text])),
    CONSTRAINT merch_marking_profile_backfill_items_offer_check
      CHECK (offer_id IS NULL OR length(offer_id) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_profile_backfill_items_requirement_check
      CHECK (
        proposed_requirement = ANY (
          ARRAY['unknown'::text, 'required'::text, 'not_required'::text]
        )
      ),
    CONSTRAINT merch_marking_profile_backfill_items_production_mode_check
      CHECK (
        proposed_production_mode = ANY (
          ARRAY['own_production'::text,
                'pre_marked_minor_customization'::text,
                'remarking_after_customization'::text]
        )
      ),
    CONSTRAINT merch_marking_profile_backfill_items_fulfillment_mode_check
      CHECK (
        proposed_fulfillment_mode = ANY (
          ARRAY['jit_after_order'::text, 'prebuilt_stock'::text,
                'pre_marked_minor_customization'::text]
        )
      ),
    CONSTRAINT merch_marking_profile_backfill_items_gtin_check
      CHECK (exact_gtin IS NULL OR getomerch_marking.is_valid_gtin14(exact_gtin)),
    CONSTRAINT merch_marking_profile_backfill_items_plan_check
      CHECK (jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 32768),
    CONSTRAINT merch_marking_profile_backfill_items_apply_status_check
      CHECK (
        apply_status = ANY (
          ARRAY['pending'::text, 'applied'::text, 'skipped'::text, 'failed'::text]
        )
      ),
    CONSTRAINT merch_marking_profile_backfill_items_applied_check
      CHECK (
        (apply_status = 'applied'
          AND applied_profile_id IS NOT NULL
          AND applied_at IS NOT NULL)
        OR apply_status <> 'applied'
      ),
    UNIQUE (run_id, product_id, channel)
);

CREATE INDEX merch_marking_profile_backfill_runs_created
  ON public.merch_marking_profile_backfill_runs (created_at DESC, id DESC);
CREATE INDEX merch_marking_profile_backfill_items_run
  ON public.merch_marking_profile_backfill_items (run_id, action, id);

ALTER TABLE public.merch_marking_events
    ADD COLUMN product_profile_id uuid
      REFERENCES public.merch_marking_product_profiles(id) ON DELETE RESTRICT;

ALTER TABLE public.merch_marking_events
    DROP CONSTRAINT merch_marking_events_subject_check,
    ADD CONSTRAINT merch_marking_events_subject_check
      CHECK (process_id IS NOT NULL OR product_profile_id IS NOT NULL);

CREATE INDEX merch_marking_events_product_profile
  ON public.merch_marking_events (
    product_profile_id,
    occurred_at DESC,
    id DESC
  )
  WHERE product_profile_id IS NOT NULL;

CREATE OR REPLACE FUNCTION getomerch_marking.normalized_attribute(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN value IS NULL THEN NULL
    ELSE regexp_replace(
      replace(lower(btrim(value)), 'ё', 'е'),
      '[^a-zа-я0-9]+',
      '',
      'g'
    )
  END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.assert_product_profile_ready(
  p_profile_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  profile_record record;
  shared_profile record;
BEGIN
  SELECT
    profile.id,
    profile.trade_item_id,
    profile.requires_marking,
    profile.marking_requirement,
    profile.verification_status,
    profile.operational_status,
    profile.archived_at,
    product.is_blank AS product_is_blank,
    trade_item.product_group,
    trade_item.verification_status AS trade_verification_status,
    trade_item.archived_at AS trade_archived_at,
    trade_item.declared_color,
    trade_item.declared_size_int,
    color.name AS product_color,
    size.name AS product_size
  INTO profile_record
  FROM public.merch_marking_product_profiles AS profile
  JOIN public.merch_products AS product
    ON product.id = profile.product_id
  LEFT JOIN public.merch_colors AS color
    ON color.id = product.color_id
  LEFT JOIN public.merch_sizes AS size
    ON size.id = product.size_id
  LEFT JOIN public.merch_marking_trade_items AS trade_item
    ON trade_item.id = profile.trade_item_id
  WHERE profile.id = p_profile_id;

  IF FOUND
    AND profile_record.archived_at IS NULL
    AND profile_record.product_is_blank
  THEN
    RAISE EXCEPTION 'active marking profile must reference a sellable product'
      USING ERRCODE = 'MZ104';
  END IF;

  IF NOT FOUND
    OR profile_record.archived_at IS NOT NULL
    OR profile_record.operational_status <> 'enabled'
  THEN
    RETURN;
  END IF;

  IF profile_record.marking_requirement = 'unknown' THEN
    RAISE EXCEPTION 'enabled marking profile cannot have unknown requirement'
      USING ERRCODE = 'MZ105';
  END IF;

  IF NOT profile_record.requires_marking THEN
    RETURN;
  END IF;

  IF profile_record.verification_status <> 'verified'
    OR profile_record.trade_item_id IS NULL
    OR profile_record.product_group IS NULL
    OR profile_record.product_group = ''
    OR profile_record.trade_verification_status <> 'verified'
    OR profile_record.trade_archived_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'enabled marking profile requires an active verified trade item'
      USING ERRCODE = 'MZ101';
  END IF;

  IF (
    profile_record.declared_color IS NOT NULL
    AND profile_record.product_color IS NOT NULL
    AND getomerch_marking.normalized_attribute(profile_record.declared_color)
      <> getomerch_marking.normalized_attribute(profile_record.product_color)
  ) OR (
    profile_record.declared_size_int IS NOT NULL
    AND profile_record.product_size IS NOT NULL
    AND getomerch_marking.normalized_attribute(profile_record.declared_size_int)
      <> getomerch_marking.normalized_attribute(profile_record.product_size)
  ) THEN
    RAISE EXCEPTION 'catalog attributes conflict with product variant'
      USING ERRCODE = 'MZ106';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.merch_marking_product_profile_channels AS channel
    JOIN LATERAL (
      SELECT item.marking_requirement
      FROM public.merch_fulfillment_order_items AS item
      JOIN public.merch_fulfillment_orders AS fulfillment_order
        ON fulfillment_order.id = item.fulfillment_order_id
      WHERE fulfillment_order.source_channel = 'ozon_fbs'
        AND item.source_active
        AND item.offer_id = channel.offer_id
      ORDER BY item.updated_at DESC, item.id DESC
      LIMIT 1
    ) AS observed ON true
    WHERE channel.product_profile_id = profile_record.id
      AND channel.channel = 'ozon_fbs'
      AND channel.is_enabled
      AND observed.marking_requirement <> 'unknown'
      AND observed.marking_requirement <> profile_record.marking_requirement
  ) THEN
    RAISE EXCEPTION 'Ozon marking requirement conflicts with product profile'
      USING ERRCODE = 'MZ107';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_evidence AS evidence
    WHERE evidence.product_profile_id = profile_record.id
      AND evidence.evidence_type = 'product_profile_mapping'
      AND evidence.verification_status = 'verified'
  ) THEN
    RAISE EXCEPTION 'enabled marking profile requires verified product mapping evidence'
      USING ERRCODE = 'MZ102';
  END IF;

  FOR shared_profile IN
    SELECT other_profile.id
    FROM public.merch_marking_product_profiles AS other_profile
    WHERE other_profile.trade_item_id = profile_record.trade_item_id
      AND other_profile.id <> profile_record.id
      AND other_profile.archived_at IS NULL
      AND other_profile.requires_marking
      AND other_profile.verification_status = 'verified'
      AND other_profile.operational_status = 'enabled'
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.merch_marking_evidence AS evidence
      WHERE evidence.product_profile_id = profile_record.id
        AND evidence.evidence_type = 'shared_trade_item_mapping'
        AND evidence.verification_status = 'verified'
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.merch_marking_evidence AS evidence
      WHERE evidence.product_profile_id = shared_profile.id
        AND evidence.evidence_type = 'shared_trade_item_mapping'
        AND evidence.verification_status = 'verified'
    ) THEN
      RAISE EXCEPTION 'shared trade item requires explicit verified evidence'
        USING ERRCODE = 'MZ103';
    END IF;
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.upsert_product_profile_draft(
  p_product_id uuid,
  p_expected_revision bigint,
  p_marking_requirement text,
  p_requirement_source text,
  p_requirement_observed_at timestamp with time zone,
  p_production_mode text,
  p_fulfillment_mode text,
  p_channel text,
  p_offer_id text,
  p_external_product_id text,
  p_external_sku text,
  p_source_snapshot_hash text,
  p_actor_type text,
  p_actor_id text
)
RETURNS TABLE (
  profile_id uuid,
  revision bigint,
  operational_status text,
  verification_status text,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_product public.merch_products%ROWTYPE;
  current_profile public.merch_marking_product_profiles%ROWTYPE;
  result_profile public.merch_marking_product_profiles%ROWTYPE;
  is_created boolean := false;
  material_change boolean := false;
BEGIN
  SELECT product.*
  INTO target_product
  FROM public.merch_products AS product
  WHERE product.id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking product not found' USING ERRCODE = 'MZ401';
  END IF;
  IF target_product.is_blank THEN
    RAISE EXCEPTION 'blank product cannot receive a marking profile'
      USING ERRCODE = 'MZ104';
  END IF;

  SELECT profile.*
  INTO current_profile
  FROM public.merch_marking_product_profiles AS profile
  WHERE profile.product_id = p_product_id
    AND profile.archived_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF p_expected_revision IS NULL
      OR current_profile.revision <> p_expected_revision
    THEN
      RAISE EXCEPTION 'marking profile revision conflict' USING ERRCODE = 'MZ404';
    END IF;

    material_change :=
      current_profile.marking_requirement IS DISTINCT FROM p_marking_requirement
      OR current_profile.production_mode IS DISTINCT FROM p_production_mode
      OR current_profile.fulfillment_marking_mode IS DISTINCT FROM p_fulfillment_mode;

    IF current_profile.operational_status = 'enabled' AND material_change THEN
      RAISE EXCEPTION 'pause profile before changing marking policy'
        USING ERRCODE = 'MZ402';
    END IF;

    UPDATE public.merch_marking_product_profiles AS profile
    SET
      requires_marking = p_marking_requirement = 'required',
      marking_requirement = p_marking_requirement,
      marking_requirement_source = CASE
        WHEN p_marking_requirement = 'unknown' THEN NULL
        ELSE p_requirement_source
      END,
      marking_requirement_observed_at = CASE
        WHEN p_marking_requirement = 'unknown' THEN NULL
        ELSE p_requirement_observed_at
      END,
      production_mode = p_production_mode,
      fulfillment_marking_mode = p_fulfillment_mode,
      verification_status = CASE
        WHEN material_change THEN 'draft'
        ELSE profile.verification_status
      END,
      verification_source = CASE
        WHEN material_change THEN NULL
        ELSE profile.verification_source
      END,
      source_snapshot_hash = CASE
        WHEN material_change THEN NULL
        ELSE profile.source_snapshot_hash
      END,
      verified_at = CASE WHEN material_change THEN NULL ELSE profile.verified_at END,
      verified_by = CASE WHEN material_change THEN NULL ELSE profile.verified_by END,
      revision = profile.revision + 1,
      updated_at = clock_timestamp()
    WHERE profile.id = current_profile.id
    RETURNING profile.* INTO result_profile;
  ELSE
    IF p_expected_revision IS NOT NULL THEN
      RAISE EXCEPTION 'marking profile revision conflict' USING ERRCODE = 'MZ404';
    END IF;

    INSERT INTO public.merch_marking_product_profiles (
      product_id,
      requires_marking,
      production_mode,
      fulfillment_marking_mode,
      marking_requirement,
      marking_requirement_source,
      marking_requirement_observed_at
    )
    VALUES (
      p_product_id,
      p_marking_requirement = 'required',
      p_production_mode,
      p_fulfillment_mode,
      p_marking_requirement,
      CASE WHEN p_marking_requirement = 'unknown' THEN NULL ELSE p_requirement_source END,
      CASE
        WHEN p_marking_requirement = 'unknown' THEN NULL
        ELSE p_requirement_observed_at
      END
    )
    RETURNING * INTO result_profile;
    is_created := true;
  END IF;

  INSERT INTO public.merch_marking_product_profile_channels (
    product_profile_id,
    channel,
    offer_id,
    external_product_id,
    external_sku,
    marking_requirement,
    requirement_source,
    observed_at,
    source_snapshot_hash
  )
  VALUES (
    result_profile.id,
    p_channel,
    p_offer_id,
    p_external_product_id,
    p_external_sku,
    p_marking_requirement,
    CASE WHEN p_marking_requirement = 'unknown' THEN NULL ELSE p_requirement_source END,
    CASE WHEN p_marking_requirement = 'unknown' THEN NULL ELSE p_requirement_observed_at END,
    p_source_snapshot_hash
  )
  ON CONFLICT (product_profile_id, channel) DO UPDATE
  SET
    offer_id = EXCLUDED.offer_id,
    external_product_id = EXCLUDED.external_product_id,
    external_sku = EXCLUDED.external_sku,
    marking_requirement = EXCLUDED.marking_requirement,
    requirement_source = EXCLUDED.requirement_source,
    observed_at = EXCLUDED.observed_at,
    source_snapshot_hash = EXCLUDED.source_snapshot_hash,
    is_enabled = true,
    updated_at = clock_timestamp();

  INSERT INTO public.merch_marking_events (
    product_profile_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    result_profile.id,
    CASE WHEN is_created THEN 'product_profile_created' ELSE 'product_profile_updated' END,
    p_actor_type,
    p_actor_id,
    'product_readiness',
    jsonb_build_object(
      'channel', p_channel,
      'markingRequirement', p_marking_requirement,
      'productionMode', p_production_mode,
      'fulfillmentMode', p_fulfillment_mode,
      'revision', result_profile.revision
    ),
    result_profile.updated_at
  );

  RETURN QUERY SELECT
    result_profile.id,
    result_profile.revision,
    result_profile.operational_status,
    result_profile.verification_status,
    is_created;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.verify_trade_item_and_profile(
  p_profile_id uuid,
  p_expected_revision bigint,
  p_gtin text,
  p_product_group text,
  p_tnved_code text,
  p_national_catalog_card_id text,
  p_national_catalog_status text,
  p_declared_product_type text,
  p_declared_fabric text,
  p_declared_color text,
  p_declared_size_int text,
  p_declared_size_ru text,
  p_declared_composition text,
  p_verification_source text,
  p_source_snapshot_hash text,
  p_external_reference text,
  p_actor_type text,
  p_actor_id text
)
RETURNS TABLE (
  result_profile_id uuid,
  trade_item_id uuid,
  revision bigint,
  verification_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_profile public.merch_marking_product_profiles%ROWTYPE;
  new_profile public.merch_marking_product_profiles%ROWTYPE;
  current_trade_item public.merch_marking_trade_items%ROWTYPE;
  result_trade_item public.merch_marking_trade_items%ROWTYPE;
  channel_snapshot jsonb := '[]'::jsonb;
BEGIN
  IF NOT getomerch_marking.is_valid_gtin14(p_gtin) THEN
    RAISE EXCEPTION 'invalid GTIN-14' USING ERRCODE = 'MZ400';
  END IF;

  SELECT profile.*
  INTO current_profile
  FROM public.merch_marking_product_profiles AS profile
  WHERE profile.id = p_profile_id
    AND profile.archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active marking profile not found' USING ERRCODE = 'MZ403';
  END IF;
  IF current_profile.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking profile revision conflict' USING ERRCODE = 'MZ404';
  END IF;
  IF current_profile.operational_status = 'enabled'
    AND current_profile.trade_item_id IS DISTINCT FROM (
      SELECT item.id FROM public.merch_marking_trade_items AS item WHERE item.gtin = p_gtin
    )
  THEN
    RAISE EXCEPTION 'pause profile before changing GTIN'
      USING ERRCODE = 'MZ402';
  END IF;

  SELECT item.*
  INTO current_trade_item
  FROM public.merch_marking_trade_items AS item
  WHERE item.gtin = p_gtin
  FOR UPDATE;

  IF FOUND
    AND current_trade_item.verification_status = 'verified'
    AND (
      current_trade_item.product_group IS DISTINCT FROM p_product_group
      OR (
        current_trade_item.declared_color IS NOT NULL
        AND p_declared_color IS NOT NULL
        AND getomerch_marking.normalized_attribute(current_trade_item.declared_color)
          <> getomerch_marking.normalized_attribute(p_declared_color)
      )
      OR (
        current_trade_item.declared_size_int IS NOT NULL
        AND p_declared_size_int IS NOT NULL
        AND getomerch_marking.normalized_attribute(current_trade_item.declared_size_int)
          <> getomerch_marking.normalized_attribute(p_declared_size_int)
      )
    )
  THEN
    RAISE EXCEPTION 'verified GTIN has incompatible attributes'
      USING ERRCODE = 'MZ405';
  END IF;

  INSERT INTO public.merch_marking_trade_items (
    gtin,
    product_group,
    tnved_code,
    national_catalog_card_id,
    national_catalog_status,
    verification_status,
    verification_source,
    source_snapshot_hash,
    verified_at,
    verified_by,
    declared_product_type,
    declared_fabric,
    declared_color,
    declared_size_int,
    declared_size_ru,
    declared_composition
  )
  VALUES (
    p_gtin,
    p_product_group,
    p_tnved_code,
    p_national_catalog_card_id,
    p_national_catalog_status,
    'verified',
    p_verification_source,
    p_source_snapshot_hash,
    clock_timestamp(),
    p_actor_id,
    p_declared_product_type,
    p_declared_fabric,
    p_declared_color,
    p_declared_size_int,
    p_declared_size_ru,
    p_declared_composition
  )
  ON CONFLICT (gtin) DO UPDATE
  SET
    product_group = EXCLUDED.product_group,
    tnved_code = EXCLUDED.tnved_code,
    national_catalog_card_id = EXCLUDED.national_catalog_card_id,
    national_catalog_status = EXCLUDED.national_catalog_status,
    verification_status = 'verified',
    verification_source = EXCLUDED.verification_source,
    source_snapshot_hash = EXCLUDED.source_snapshot_hash,
    verified_at = clock_timestamp(),
    verified_by = EXCLUDED.verified_by,
    declared_product_type = EXCLUDED.declared_product_type,
    declared_fabric = EXCLUDED.declared_fabric,
    declared_color = EXCLUDED.declared_color,
    declared_size_int = EXCLUDED.declared_size_int,
    declared_size_ru = EXCLUDED.declared_size_ru,
    declared_composition = EXCLUDED.declared_composition,
    archived_at = NULL,
    updated_at = clock_timestamp()
  RETURNING * INTO result_trade_item;

  IF current_profile.trade_item_id IS NOT NULL
    AND current_profile.trade_item_id <> result_trade_item.id
  THEN
    SELECT coalesce(
      jsonb_agg(jsonb_build_object(
        'channel', channel.channel,
        'offer_id', channel.offer_id,
        'external_product_id', channel.external_product_id,
        'external_sku', channel.external_sku,
        'marking_requirement', channel.marking_requirement,
        'requirement_source', channel.requirement_source,
        'observed_at', channel.observed_at,
        'source_snapshot_hash', channel.source_snapshot_hash,
        'is_enabled', channel.is_enabled
      )),
      '[]'::jsonb
    )
    INTO channel_snapshot
    FROM public.merch_marking_product_profile_channels AS channel
    WHERE channel.product_profile_id = current_profile.id;

    UPDATE public.merch_marking_product_profiles AS profile
    SET
      archived_at = clock_timestamp(),
      operational_status = 'paused',
      operational_status_reason = 'GTIN replaced',
      operational_changed_at = clock_timestamp(),
      operational_changed_by = p_actor_id,
      revision = profile.revision + 1,
      updated_at = clock_timestamp()
    WHERE profile.id = current_profile.id;

    UPDATE public.merch_marking_product_profile_channels AS channel
    SET is_enabled = false, updated_at = clock_timestamp()
    WHERE channel.product_profile_id = current_profile.id
      AND channel.is_enabled;

    INSERT INTO public.merch_marking_product_profiles (
      product_id,
      trade_item_id,
      requires_marking,
      production_mode,
      fulfillment_marking_mode,
      application_method,
      application_surface,
      label_template_version,
      verification_status,
      verification_source,
      source_snapshot_hash,
      verified_at,
      verified_by,
      marking_requirement,
      marking_requirement_source,
      marking_requirement_observed_at
    )
    VALUES (
      current_profile.product_id,
      result_trade_item.id,
      current_profile.requires_marking,
      current_profile.production_mode,
      current_profile.fulfillment_marking_mode,
      current_profile.application_method,
      current_profile.application_surface,
      current_profile.label_template_version,
      'verified',
      p_verification_source,
      p_source_snapshot_hash,
      clock_timestamp(),
      p_actor_id,
      current_profile.marking_requirement,
      current_profile.marking_requirement_source,
      current_profile.marking_requirement_observed_at
    )
    RETURNING * INTO new_profile;

    INSERT INTO public.merch_marking_product_profile_channels (
      product_profile_id,
      channel,
      offer_id,
      external_product_id,
      external_sku,
      marking_requirement,
      requirement_source,
      observed_at,
      source_snapshot_hash,
      is_enabled
    )
    SELECT
      new_profile.id,
      snapshot.channel,
      snapshot.offer_id,
      snapshot.external_product_id,
      snapshot.external_sku,
      snapshot.marking_requirement,
      snapshot.requirement_source,
      snapshot.observed_at,
      snapshot.source_snapshot_hash,
      snapshot.is_enabled
    FROM jsonb_to_recordset(channel_snapshot) AS snapshot(
      channel text,
      offer_id text,
      external_product_id text,
      external_sku text,
      marking_requirement text,
      requirement_source text,
      observed_at timestamp with time zone,
      source_snapshot_hash text,
      is_enabled boolean
    );
  ELSE
    UPDATE public.merch_marking_product_profiles AS profile
    SET
      trade_item_id = result_trade_item.id,
      verification_status = 'verified',
      verification_source = p_verification_source,
      source_snapshot_hash = p_source_snapshot_hash,
      verified_at = clock_timestamp(),
      verified_by = p_actor_id,
      revision = profile.revision + 1,
      updated_at = clock_timestamp()
    WHERE profile.id = current_profile.id
    RETURNING profile.* INTO new_profile;
  END IF;

  INSERT INTO public.merch_marking_evidence (
    product_profile_id,
    evidence_type,
    source,
    external_reference,
    scope_snapshot,
    observed_at,
    payload_hash,
    details_redacted,
    verification_status,
    verified_by,
    verified_at
  )
  VALUES (
    new_profile.id,
    'product_profile_mapping',
    p_verification_source,
    p_external_reference,
    jsonb_build_object(
      'gtin', p_gtin,
      'nationalCatalogCardId', p_national_catalog_card_id,
      'productId', new_profile.product_id
    ),
    clock_timestamp(),
    p_source_snapshot_hash,
    jsonb_build_object(
      'productGroup', p_product_group,
      'nationalCatalogStatus', p_national_catalog_status
    ),
    'verified',
    p_actor_id,
    clock_timestamp()
  );

  INSERT INTO public.merch_marking_events (
    product_profile_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    new_profile.id,
    'product_profile_gtin_verified',
    p_actor_type,
    p_actor_id,
    p_verification_source,
    jsonb_build_object(
      'gtin', p_gtin,
      'tradeItemId', result_trade_item.id,
      'revision', new_profile.revision
    ),
    new_profile.updated_at
  );

  RETURN QUERY SELECT
    new_profile.id,
    result_trade_item.id,
    new_profile.revision,
    new_profile.verification_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.attach_product_profile_evidence(
  p_profile_id uuid,
  p_expected_revision bigint,
  p_evidence_type text,
  p_source text,
  p_external_reference text,
  p_scope_snapshot jsonb,
  p_payload_hash text,
  p_details_redacted jsonb,
  p_verification_status text,
  p_actor_type text,
  p_actor_id text
)
RETURNS TABLE (
  evidence_id uuid,
  revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_profile public.merch_marking_product_profiles%ROWTYPE;
  created_evidence public.merch_marking_evidence%ROWTYPE;
  next_revision bigint;
BEGIN
  SELECT profile.*
  INTO current_profile
  FROM public.merch_marking_product_profiles AS profile
  WHERE profile.id = p_profile_id
    AND profile.archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active marking profile not found' USING ERRCODE = 'MZ403';
  END IF;
  IF current_profile.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking profile revision conflict' USING ERRCODE = 'MZ404';
  END IF;

  INSERT INTO public.merch_marking_evidence (
    product_profile_id,
    evidence_type,
    source,
    external_reference,
    scope_snapshot,
    observed_at,
    payload_hash,
    details_redacted,
    verification_status,
    verified_by,
    verified_at
  )
  VALUES (
    p_profile_id,
    p_evidence_type,
    p_source,
    p_external_reference,
    coalesce(p_scope_snapshot, '{}'::jsonb),
    clock_timestamp(),
    p_payload_hash,
    coalesce(p_details_redacted, '{}'::jsonb),
    p_verification_status,
    CASE WHEN p_verification_status = 'verified' THEN p_actor_id ELSE NULL END,
    CASE WHEN p_verification_status = 'verified' THEN clock_timestamp() ELSE NULL END
  )
  RETURNING * INTO created_evidence;

  UPDATE public.merch_marking_product_profiles AS profile
  SET revision = profile.revision + 1, updated_at = clock_timestamp()
  WHERE profile.id = p_profile_id
  RETURNING profile.revision INTO next_revision;

  INSERT INTO public.merch_marking_events (
    product_profile_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    p_profile_id,
    'product_profile_evidence_attached',
    p_actor_type,
    p_actor_id,
    p_source,
    jsonb_build_object(
      'evidenceId', created_evidence.id,
      'evidenceType', p_evidence_type,
      'verificationStatus', p_verification_status,
      'revision', next_revision
    ),
    clock_timestamp()
  );

  RETURN QUERY SELECT created_evidence.id, next_revision;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.set_product_profile_operational_status(
  p_profile_id uuid,
  p_expected_revision bigint,
  p_operational_status text,
  p_reason text,
  p_actor_type text,
  p_actor_id text
)
RETURNS TABLE (
  profile_id uuid,
  operational_status text,
  revision bigint,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_profile public.merch_marking_product_profiles%ROWTYPE;
  result_profile public.merch_marking_product_profiles%ROWTYPE;
BEGIN
  IF p_operational_status NOT IN ('enabled', 'paused') THEN
    RAISE EXCEPTION 'invalid operational status' USING ERRCODE = 'MZ406';
  END IF;

  SELECT profile.*
  INTO current_profile
  FROM public.merch_marking_product_profiles AS profile
  WHERE profile.id = p_profile_id
    AND profile.archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active marking profile not found' USING ERRCODE = 'MZ403';
  END IF;
  IF current_profile.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking profile revision conflict' USING ERRCODE = 'MZ404';
  END IF;

  UPDATE public.merch_marking_product_profiles AS profile
  SET
    operational_status = p_operational_status,
    operational_status_reason = CASE
      WHEN p_operational_status = 'paused' THEN p_reason
      ELSE NULL
    END,
    operational_changed_at = clock_timestamp(),
    operational_changed_by = p_actor_id,
    revision = profile.revision + 1,
    updated_at = clock_timestamp()
  WHERE profile.id = p_profile_id
  RETURNING profile.* INTO result_profile;

  PERFORM getomerch_marking.assert_product_profile_ready(result_profile.id);

  INSERT INTO public.merch_marking_events (
    product_profile_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    result_profile.id,
    CASE
      WHEN p_operational_status = 'enabled'
        THEN 'product_profile_enabled'
      ELSE 'product_profile_paused'
    END,
    p_actor_type,
    p_actor_id,
    'product_readiness',
    jsonb_build_object(
      'fromStatus', current_profile.operational_status,
      'toStatus', result_profile.operational_status,
      'reason', p_reason,
      'revision', result_profile.revision
    ),
    result_profile.updated_at
  );

  RETURN QUERY SELECT
    result_profile.id,
    result_profile.operational_status,
    result_profile.revision,
    result_profile.updated_at;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.create_profile_backfill_preview(
  p_source text,
  p_options jsonb,
  p_items jsonb,
  p_actor_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  created_run_id uuid;
  item jsonb;
  item_count integer;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'backfill items must be an array' USING ERRCODE = 'MZ407';
  END IF;
  item_count := jsonb_array_length(p_items);
  IF item_count < 1 OR item_count > 5000 THEN
    RAISE EXCEPTION 'backfill item count must be between 1 and 5000'
      USING ERRCODE = 'MZ407';
  END IF;

  INSERT INTO public.merch_marking_profile_backfill_runs (
    source,
    options,
    summary,
    created_by
  )
  VALUES (
    p_source,
    coalesce(p_options, '{}'::jsonb),
    jsonb_build_object('total', item_count),
    p_actor_id
  )
  RETURNING id INTO created_run_id;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.merch_products AS product
      WHERE product.id = (item->>'productId')::uuid
        AND NOT product.is_blank
    ) THEN
      RAISE EXCEPTION 'profile backfill product must be sellable'
        USING ERRCODE = 'MZ407';
    END IF;

    INSERT INTO public.merch_marking_profile_backfill_items (
      run_id,
      product_id,
      action,
      channel,
      offer_id,
      external_product_id,
      external_sku,
      proposed_requirement,
      proposed_production_mode,
      proposed_fulfillment_mode,
      exact_gtin,
      plan,
      errors,
      warnings
    )
    VALUES (
      created_run_id,
      (item->>'productId')::uuid,
      item->>'action',
      item->>'channel',
      nullif(item->>'offerId', ''),
      nullif(item->>'externalProductId', ''),
      nullif(item->>'externalSku', ''),
      coalesce(nullif(item->>'markingRequirement', ''), 'unknown'),
      item->>'productionMode',
      item->>'fulfillmentMode',
      nullif(item->>'gtin', ''),
      coalesce(item->'plan', '{}'::jsonb),
      coalesce(
        ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'errors', '[]'::jsonb))),
        '{}'::text[]
      ),
      coalesce(
        ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'warnings', '[]'::jsonb))),
        '{}'::text[]
      )
    );
  END LOOP;

  UPDATE public.merch_marking_profile_backfill_runs AS run
  SET summary = (
    SELECT jsonb_build_object(
      'total', count(*),
      'createDraft', count(*) FILTER (WHERE action = 'create_draft'),
      'skip', count(*) FILTER (WHERE action = 'skip'),
      'conflict', count(*) FILTER (WHERE action = 'conflict')
    )
    FROM public.merch_marking_profile_backfill_items AS candidate
    WHERE candidate.run_id = run.id
  )
  WHERE run.id = created_run_id;

  RETURN created_run_id;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.apply_profile_backfill(
  p_run_id uuid,
  p_actor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_run public.merch_marking_profile_backfill_runs%ROWTYPE;
  candidate public.merch_marking_profile_backfill_items%ROWTYPE;
  created_profile public.merch_marking_product_profiles%ROWTYPE;
  existing_profile_id uuid;
  result_summary jsonb;
BEGIN
  SELECT run.*
  INTO target_run
  FROM public.merch_marking_profile_backfill_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile backfill run not found' USING ERRCODE = 'MZ408';
  END IF;
  IF target_run.status = 'applied' THEN
    RETURN target_run.summary;
  END IF;
  IF target_run.status <> 'preview' THEN
    RAISE EXCEPTION 'profile backfill run cannot be applied'
      USING ERRCODE = 'MZ409';
  END IF;

  FOR candidate IN
    SELECT item.*
    FROM public.merch_marking_profile_backfill_items AS item
    WHERE item.run_id = p_run_id
    ORDER BY item.id
    FOR UPDATE
  LOOP
    IF candidate.action <> 'create_draft'
      OR cardinality(candidate.errors) > 0
    THEN
      UPDATE public.merch_marking_profile_backfill_items
      SET apply_status = 'skipped'
      WHERE id = candidate.id;
      CONTINUE;
    END IF;

    SELECT profile.id
    INTO existing_profile_id
    FROM public.merch_marking_product_profiles AS profile
    WHERE profile.product_id = candidate.product_id
      AND profile.archived_at IS NULL;

    IF FOUND THEN
      UPDATE public.merch_marking_profile_backfill_items
      SET
        apply_status = 'skipped',
        applied_profile_id = existing_profile_id
      WHERE id = candidate.id;
      CONTINUE;
    END IF;

    INSERT INTO public.merch_marking_product_profiles (
      product_id,
      requires_marking,
      production_mode,
      fulfillment_marking_mode,
      marking_requirement,
      marking_requirement_source,
      marking_requirement_observed_at
    )
    VALUES (
      candidate.product_id,
      candidate.proposed_requirement = 'required',
      candidate.proposed_production_mode,
      candidate.proposed_fulfillment_mode,
      candidate.proposed_requirement,
      CASE
        WHEN candidate.proposed_requirement = 'unknown'
          THEN NULL
        ELSE target_run.source
      END,
      CASE
        WHEN candidate.proposed_requirement = 'unknown'
          THEN NULL
        ELSE target_run.created_at
      END
    )
    RETURNING * INTO created_profile;

    INSERT INTO public.merch_marking_product_profile_channels (
      product_profile_id,
      channel,
      offer_id,
      external_product_id,
      external_sku,
      marking_requirement,
      requirement_source,
      observed_at
    )
    VALUES (
      created_profile.id,
      candidate.channel,
      candidate.offer_id,
      candidate.external_product_id,
      candidate.external_sku,
      candidate.proposed_requirement,
      CASE
        WHEN candidate.proposed_requirement = 'unknown'
          THEN NULL
        ELSE target_run.source
      END,
      CASE
        WHEN candidate.proposed_requirement = 'unknown'
          THEN NULL
        ELSE target_run.created_at
      END
    );

    INSERT INTO public.merch_marking_events (
      product_profile_id,
      event_type,
      actor_type,
      actor_id,
      source,
      details_redacted,
      occurred_at
    )
    VALUES (
      created_profile.id,
      'product_profile_backfilled',
      'admin',
      p_actor_id,
      target_run.source,
      jsonb_build_object(
        'runId', p_run_id,
        'channel', candidate.channel,
        'markingRequirement', candidate.proposed_requirement
      ),
      clock_timestamp()
    );

    UPDATE public.merch_marking_profile_backfill_items
    SET
      apply_status = 'applied',
      applied_profile_id = created_profile.id,
      applied_at = clock_timestamp()
    WHERE id = candidate.id;
  END LOOP;

  SELECT jsonb_build_object(
    'total', count(*),
    'applied', count(*) FILTER (WHERE apply_status = 'applied'),
    'skipped', count(*) FILTER (WHERE apply_status = 'skipped'),
    'failed', count(*) FILTER (WHERE apply_status = 'failed'),
    'conflicts', count(*) FILTER (WHERE action = 'conflict')
  )
  INTO result_summary
  FROM public.merch_marking_profile_backfill_items
  WHERE run_id = p_run_id;

  UPDATE public.merch_marking_profile_backfill_runs
  SET
    status = 'applied',
    summary = result_summary,
    applied_by = p_actor_id,
    applied_at = clock_timestamp()
  WHERE id = p_run_id;

  RETURN result_summary;
END
$function$;

REVOKE ALL ON
  public.merch_marking_product_profile_channels,
  public.merch_marking_profile_backfill_runs,
  public.merch_marking_profile_backfill_items
FROM getomerch_app;

GRANT SELECT ON
  public.merch_marking_product_profile_channels,
  public.merch_marking_profile_backfill_runs,
  public.merch_marking_profile_backfill_items
TO getomerch_app, getomerch_backup;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA getomerch_marking FROM PUBLIC;
GRANT EXECUTE ON FUNCTION getomerch_marking.normalized_attribute(text)
TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.upsert_product_profile_draft(
  uuid, bigint, text, text, timestamp with time zone, text, text, text, text, text,
  text, text, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.verify_trade_item_and_profile(
  uuid, bigint, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.attach_product_profile_evidence(
  uuid, bigint, text, text, text, jsonb, text, jsonb, text, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.set_product_profile_operational_status(
  uuid, bigint, text, text, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.create_profile_backfill_preview(
  text, jsonb, jsonb, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.apply_profile_backfill(uuid, text)
TO getomerch_app;

COMMENT ON TABLE public.merch_marking_product_profile_channels IS
  'Exact channel identifiers and requirement observations for a product profile.';
COMMENT ON TABLE public.merch_marking_profile_backfill_runs IS
  'Preview/apply batches that only create inactive draft profiles.';
COMMENT ON COLUMN public.merch_marking_profile_backfill_items.exact_gtin IS
  'Diagnostic exact mapping only; Stage 4 backfill never auto-confirms this GTIN.';
