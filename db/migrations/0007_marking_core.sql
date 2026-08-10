-- Stage 3 marking core: product readiness references, operational processes,
-- evidence and append-only business events.
--
-- This migration intentionally does not store full marking codes and does not
-- enable any external Ozon, GIS MT or SUZ mutation.

CREATE SCHEMA IF NOT EXISTS getomerch_marking AUTHORIZATION getomerch_owner;

CREATE OR REPLACE FUNCTION getomerch_marking.is_valid_gtin14(value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
  checksum integer := 0;
  position integer;
  expected_digit integer;
BEGIN
  IF value !~ '^[0-9]{14}$' OR value = '00000000000000' THEN
    RETURN false;
  END IF;

  FOR position IN 1..13 LOOP
    checksum := checksum
      + substring(value FROM position FOR 1)::integer
        * CASE WHEN position % 2 = 1 THEN 3 ELSE 1 END;
  END LOOP;
  expected_digit := (10 - (checksum % 10)) % 10;
  RETURN right(value, 1)::integer = expected_digit;
END
$function$;

CREATE TABLE public.merch_marking_trade_items (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    gtin text NOT NULL UNIQUE,
    product_group text NOT NULL,
    tnved_code text,
    okpd2_code text,
    national_catalog_card_id text,
    national_catalog_status text,
    verification_status text DEFAULT 'draft'::text NOT NULL,
    verification_source text,
    source_snapshot_hash text,
    verified_at timestamp with time zone,
    verified_by text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_trade_items_gtin_check
      CHECK (getomerch_marking.is_valid_gtin14(gtin)),
    CONSTRAINT merch_marking_trade_items_product_group_check
      CHECK (length(product_group) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_trade_items_tnved_check
      CHECK (tnved_code IS NULL OR tnved_code ~ '^[0-9]{4,10}$'),
    CONSTRAINT merch_marking_trade_items_okpd2_check
      CHECK (okpd2_code IS NULL OR okpd2_code ~ '^[0-9.]{2,20}$'),
    CONSTRAINT merch_marking_trade_items_verification_status_check
      CHECK (
        verification_status = ANY (
          ARRAY['draft'::text, 'pending'::text, 'verified'::text,
                'blocked'::text, 'conflict'::text]
        )
      ),
    CONSTRAINT merch_marking_trade_items_snapshot_hash_check
      CHECK (
        source_snapshot_hash IS NULL
        OR source_snapshot_hash ~ '^[0-9a-f]{64}$'
      ),
    CONSTRAINT merch_marking_trade_items_verified_check
      CHECK (
        verification_status <> 'verified'
        OR (
          verification_source IS NOT NULL
          AND source_snapshot_hash IS NOT NULL
          AND verified_at IS NOT NULL
          AND verified_by IS NOT NULL
        )
      ),
    CONSTRAINT merch_marking_trade_items_archive_check
      CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE TABLE public.merch_marking_trade_item_documents (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    trade_item_id uuid NOT NULL
      REFERENCES public.merch_marking_trade_items(id) ON DELETE RESTRICT,
    document_type text NOT NULL,
    document_number text NOT NULL,
    issued_at date,
    valid_until date,
    status text DEFAULT 'unverified'::text NOT NULL,
    source_snapshot_hash text,
    verified_at timestamp with time zone,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_trade_item_documents_type_check
      CHECK (length(document_type) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_trade_item_documents_number_check
      CHECK (length(document_number) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_trade_item_documents_status_check
      CHECK (
        status = ANY (
          ARRAY['unverified'::text, 'valid'::text, 'expired'::text,
                'revoked'::text, 'rejected'::text]
        )
      ),
    CONSTRAINT merch_marking_trade_item_documents_dates_check
      CHECK (valid_until IS NULL OR issued_at IS NULL OR valid_until >= issued_at),
    CONSTRAINT merch_marking_trade_item_documents_snapshot_hash_check
      CHECK (
        source_snapshot_hash IS NULL
        OR source_snapshot_hash ~ '^[0-9a-f]{64}$'
      ),
    CONSTRAINT merch_marking_trade_item_documents_verified_check
      CHECK (status <> 'valid' OR verified_at IS NOT NULL),
    CONSTRAINT merch_marking_trade_item_documents_archive_check
      CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE TABLE public.merch_marking_product_profiles (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id uuid NOT NULL
      REFERENCES public.merch_products(id) ON DELETE RESTRICT,
    trade_item_id uuid
      REFERENCES public.merch_marking_trade_items(id) ON DELETE RESTRICT,
    requires_marking boolean DEFAULT false NOT NULL,
    production_mode text NOT NULL,
    fulfillment_marking_mode text NOT NULL,
    application_method text,
    application_surface text,
    label_template_version text,
    verification_status text DEFAULT 'draft'::text NOT NULL,
    verification_source text,
    source_snapshot_hash text,
    verified_at timestamp with time zone,
    verified_by text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_product_profiles_production_mode_check
      CHECK (
        production_mode = ANY (
          ARRAY['own_production'::text,
                'pre_marked_minor_customization'::text,
                'remarking_after_customization'::text]
        )
      ),
    CONSTRAINT merch_marking_product_profiles_fulfillment_mode_check
      CHECK (
        fulfillment_marking_mode = ANY (
          ARRAY['jit_after_order'::text, 'prebuilt_stock'::text,
                'pre_marked_minor_customization'::text]
        )
      ),
    CONSTRAINT merch_marking_product_profiles_mode_pair_check
      CHECK (
        (production_mode = 'pre_marked_minor_customization'
          AND fulfillment_marking_mode = 'pre_marked_minor_customization')
        OR
        (production_mode <> 'pre_marked_minor_customization'
          AND fulfillment_marking_mode <> 'pre_marked_minor_customization')
      ),
    CONSTRAINT merch_marking_product_profiles_verification_status_check
      CHECK (
        verification_status = ANY (
          ARRAY['draft'::text, 'pending'::text, 'verified'::text,
                'blocked'::text, 'conflict'::text]
        )
      ),
    CONSTRAINT merch_marking_product_profiles_snapshot_hash_check
      CHECK (
        source_snapshot_hash IS NULL
        OR source_snapshot_hash ~ '^[0-9a-f]{64}$'
      ),
    CONSTRAINT merch_marking_product_profiles_verified_check
      CHECK (
        verification_status <> 'verified'
        OR (
          verification_source IS NOT NULL
          AND source_snapshot_hash IS NOT NULL
          AND verified_at IS NOT NULL
          AND verified_by IS NOT NULL
        )
      ),
    CONSTRAINT merch_marking_product_profiles_trade_item_check
      CHECK (
        NOT requires_marking
        OR verification_status <> 'verified'
        OR trade_item_id IS NOT NULL
      ),
    CONSTRAINT merch_marking_product_profiles_archive_check
      CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE UNIQUE INDEX merch_marking_product_profiles_active_product
  ON public.merch_marking_product_profiles (product_id)
  WHERE archived_at IS NULL;
CREATE INDEX merch_marking_product_profiles_trade_item
  ON public.merch_marking_product_profiles (trade_item_id, verification_status)
  WHERE archived_at IS NULL AND trade_item_id IS NOT NULL;

CREATE TABLE public.merch_marking_locations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    warehouse_id uuid
      REFERENCES public.merch_warehouses(id) ON DELETE RESTRICT,
    kpp text,
    fias_id text,
    crpt_location_id text,
    address_snapshot text,
    status text DEFAULT 'draft'::text NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_locations_name_check
      CHECK (length(name) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_locations_kpp_check
      CHECK (kpp IS NULL OR kpp ~ '^[0-9]{9}$'),
    CONSTRAINT merch_marking_locations_fias_check
      CHECK (fias_id IS NULL OR length(fias_id) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_locations_crpt_id_check
      CHECK (crpt_location_id IS NULL OR length(crpt_location_id) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_locations_address_check
      CHECK (address_snapshot IS NULL OR length(address_snapshot) <= 4000),
    CONSTRAINT merch_marking_locations_status_check
      CHECK (
        status = ANY (
          ARRAY['draft'::text, 'pending'::text, 'verified'::text,
                'blocked'::text, 'archived'::text]
        )
      ),
    CONSTRAINT merch_marking_locations_verified_check
      CHECK (status <> 'verified' OR verified_at IS NOT NULL)
);

CREATE TABLE public.merch_marking_processes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    process_type text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    fulfillment_order_id uuid
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
    fulfillment_item_id uuid,
    marking_unit_id uuid,
    assignment_id uuid,
    source text NOT NULL,
    source_key text NOT NULL,
    priority integer DEFAULT 50 NOT NULL,
    current_step text NOT NULL,
    next_action text,
    deadline_at timestamp with time zone,
    manual_review_reason text,
    last_error_code text,
    owner text,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT merch_marking_processes_item_order_fkey
      FOREIGN KEY (fulfillment_item_id, fulfillment_order_id)
      REFERENCES public.merch_fulfillment_order_items(id, fulfillment_order_id)
      ON DELETE RESTRICT,
    CONSTRAINT merch_marking_processes_type_check
      CHECK (length(process_type) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_processes_status_check
      CHECK (
        status = ANY (
          ARRAY['open'::text, 'waiting_user'::text, 'waiting_external'::text,
                'ready'::text, 'completed'::text, 'manual_review'::text,
                'failed'::text, 'cancelled'::text]
        )
      ),
    CONSTRAINT merch_marking_processes_item_requires_order_check
      CHECK (fulfillment_item_id IS NULL OR fulfillment_order_id IS NOT NULL),
    CONSTRAINT merch_marking_processes_stage3_future_subjects_check
      CHECK (marking_unit_id IS NULL AND assignment_id IS NULL),
    CONSTRAINT merch_marking_processes_source_check
      CHECK (length(source) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_processes_source_key_check
      CHECK (length(source_key) BETWEEN 1 AND 500),
    CONSTRAINT merch_marking_processes_priority_check
      CHECK (priority BETWEEN 0 AND 100),
    CONSTRAINT merch_marking_processes_current_step_check
      CHECK (length(current_step) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_processes_next_action_check
      CHECK (next_action IS NULL OR length(next_action) BETWEEN 1 AND 240),
    CONSTRAINT merch_marking_processes_manual_review_check
      CHECK (
        status <> 'manual_review'
        OR (
          manual_review_reason IS NOT NULL
          AND length(manual_review_reason) BETWEEN 1 AND 1000
        )
      ),
    CONSTRAINT merch_marking_processes_failed_check
      CHECK (
        status <> 'failed'
        OR (
          last_error_code IS NOT NULL
          AND length(last_error_code) BETWEEN 1 AND 120
        )
      ),
    CONSTRAINT merch_marking_processes_version_check CHECK (version >= 1),
    CONSTRAINT merch_marking_processes_completion_check
      CHECK (
        (status = ANY (ARRAY['completed'::text, 'cancelled'::text])
          AND completed_at IS NOT NULL)
        OR
        (status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
          AND completed_at IS NULL)
      )
);

CREATE UNIQUE INDEX merch_marking_processes_active_business_key
  ON public.merch_marking_processes (process_type, source, source_key)
  WHERE status <> ALL (ARRAY['completed'::text, 'cancelled'::text]);
CREATE INDEX merch_marking_processes_queue
  ON public.merch_marking_processes (
    status,
    priority DESC,
    deadline_at ASC NULLS LAST,
    updated_at ASC
  )
  WHERE status <> ALL (ARRAY['completed'::text, 'cancelled'::text]);
CREATE INDEX merch_marking_processes_updated
  ON public.merch_marking_processes (updated_at DESC, id DESC);
CREATE INDEX merch_marking_processes_fulfillment
  ON public.merch_marking_processes (fulfillment_order_id, fulfillment_item_id)
  WHERE fulfillment_order_id IS NOT NULL;

CREATE TABLE public.merch_marking_evidence (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    process_id uuid
      REFERENCES public.merch_marking_processes(id) ON DELETE RESTRICT,
    product_profile_id uuid
      REFERENCES public.merch_marking_product_profiles(id) ON DELETE RESTRICT,
    marking_unit_id uuid,
    assignment_id uuid,
    evidence_type text NOT NULL,
    source text NOT NULL,
    external_reference text,
    scope_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    payload_envelope bytea,
    payload_hash text NOT NULL,
    details_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    verification_status text DEFAULT 'unverified'::text NOT NULL,
    verified_by text,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_evidence_stage3_future_subjects_check
      CHECK (marking_unit_id IS NULL AND assignment_id IS NULL),
    CONSTRAINT merch_marking_evidence_subject_check
      CHECK (process_id IS NOT NULL OR product_profile_id IS NOT NULL),
    CONSTRAINT merch_marking_evidence_type_check
      CHECK (length(evidence_type) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_evidence_source_check
      CHECK (length(source) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_evidence_external_reference_check
      CHECK (
        external_reference IS NULL
        OR length(external_reference) BETWEEN 1 AND 500
      ),
    CONSTRAINT merch_marking_evidence_scope_check
      CHECK (
        jsonb_typeof(scope_snapshot) = 'object'
        AND octet_length(scope_snapshot::text) <= 32768
      ),
    CONSTRAINT merch_marking_evidence_stage3_payload_check
      CHECK (payload_envelope IS NULL),
    CONSTRAINT merch_marking_evidence_payload_hash_check
      CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_evidence_details_check
      CHECK (
        jsonb_typeof(details_redacted) = 'object'
        AND octet_length(details_redacted::text) <= 32768
      ),
    CONSTRAINT merch_marking_evidence_verification_status_check
      CHECK (
        verification_status = ANY (
          ARRAY['unverified'::text, 'pending'::text, 'verified'::text,
                'rejected'::text, 'expired'::text]
        )
      ),
    CONSTRAINT merch_marking_evidence_verified_check
      CHECK (
        verification_status <> 'verified'
        OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)
      )
);

CREATE INDEX merch_marking_evidence_process
  ON public.merch_marking_evidence (process_id, observed_at DESC, id DESC)
  WHERE process_id IS NOT NULL;
CREATE INDEX merch_marking_evidence_profile
  ON public.merch_marking_evidence (
    product_profile_id,
    verification_status,
    evidence_type,
    observed_at DESC
  )
  WHERE product_profile_id IS NOT NULL;

CREATE TABLE public.merch_marking_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    marking_code_id uuid,
    marking_unit_id uuid,
    code_binding_id uuid,
    assignment_id uuid,
    process_id uuid
      REFERENCES public.merch_marking_processes(id) ON DELETE RESTRICT,
    document_id uuid,
    event_type text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    source text NOT NULL,
    details_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_events_stage3_future_subjects_check
      CHECK (
        marking_code_id IS NULL
        AND marking_unit_id IS NULL
        AND code_binding_id IS NULL
        AND assignment_id IS NULL
        AND document_id IS NULL
      ),
    CONSTRAINT merch_marking_events_subject_check
      CHECK (process_id IS NOT NULL),
    CONSTRAINT merch_marking_events_type_check
      CHECK (length(event_type) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_events_actor_type_check
      CHECK (
        actor_type = ANY (
          ARRAY['admin'::text, 'worker'::text, 'system'::text,
                'migration'::text]
        )
      ),
    CONSTRAINT merch_marking_events_actor_id_check
      CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_events_source_check
      CHECK (length(source) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_events_details_check
      CHECK (
        jsonb_typeof(details_redacted) = 'object'
        AND octet_length(details_redacted::text) <= 16384
      )
);

CREATE INDEX merch_marking_events_occurred
  ON public.merch_marking_events (occurred_at DESC, id DESC);
CREATE INDEX merch_marking_events_process
  ON public.merch_marking_events (process_id, occurred_at DESC, id DESC)
  WHERE process_id IS NOT NULL;
CREATE INDEX merch_marking_events_type
  ON public.merch_marking_events (event_type, occurred_at DESC, id DESC);

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
    profile.verification_status,
    profile.archived_at,
    product.is_blank AS product_is_blank,
    trade_item.product_group,
    trade_item.verification_status AS trade_verification_status,
    trade_item.archived_at AS trade_archived_at
  INTO profile_record
  FROM public.merch_marking_product_profiles AS profile
  JOIN public.merch_products AS product
    ON product.id = profile.product_id
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
    OR NOT profile_record.requires_marking
    OR profile_record.verification_status <> 'verified'
  THEN
    RETURN;
  END IF;

  IF profile_record.trade_item_id IS NULL
    OR profile_record.product_group IS NULL
    OR profile_record.product_group = ''
    OR profile_record.trade_verification_status <> 'verified'
    OR profile_record.trade_archived_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'verified marking profile requires an active verified trade item'
      USING ERRCODE = 'MZ101';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_evidence AS evidence
    WHERE evidence.product_profile_id = profile_record.id
      AND evidence.evidence_type = 'product_profile_mapping'
      AND evidence.verification_status = 'verified'
  ) THEN
    RAISE EXCEPTION 'verified marking profile requires verified product mapping evidence'
      USING ERRCODE = 'MZ102';
  END IF;

  IF (
    SELECT count(*)
    FROM public.merch_marking_product_profiles AS profile
    WHERE profile.trade_item_id = profile_record.trade_item_id
      AND profile.archived_at IS NULL
      AND profile.requires_marking
      AND profile.verification_status = 'verified'
  ) > 1 THEN
    FOR shared_profile IN
      SELECT profile.id
      FROM public.merch_marking_product_profiles AS profile
      WHERE profile.trade_item_id = profile_record.trade_item_id
        AND profile.archived_at IS NULL
        AND profile.requires_marking
        AND profile.verification_status = 'verified'
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM public.merch_marking_evidence AS evidence
        WHERE evidence.product_profile_id = shared_profile.id
          AND evidence.evidence_type = 'shared_trade_item_mapping'
          AND evidence.verification_status = 'verified'
      ) THEN
        RAISE EXCEPTION 'shared trade item requires verified evidence for every profile'
          USING ERRCODE = 'MZ103';
      END IF;
    END LOOP;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.check_product_profile_constraint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM getomerch_marking.assert_product_profile_ready(NEW.id);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.check_evidence_profile_constraint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.product_profile_id IS NOT NULL THEN
    PERFORM getomerch_marking.assert_product_profile_ready(OLD.product_profile_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.product_profile_id IS NOT NULL THEN
    PERFORM getomerch_marking.assert_product_profile_ready(NEW.product_profile_id);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.check_trade_item_profile_constraint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  profile_id uuid;
BEGIN
  FOR profile_id IN
    SELECT profile.id
    FROM public.merch_marking_product_profiles AS profile
    WHERE profile.trade_item_id = NEW.id
  LOOP
    PERFORM getomerch_marking.assert_product_profile_ready(profile_id);
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER merch_marking_product_profiles_readiness
AFTER INSERT OR UPDATE
ON public.merch_marking_product_profiles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION getomerch_marking.check_product_profile_constraint();

CREATE CONSTRAINT TRIGGER merch_marking_evidence_profile_readiness
AFTER INSERT OR UPDATE OR DELETE
ON public.merch_marking_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION getomerch_marking.check_evidence_profile_constraint();

CREATE CONSTRAINT TRIGGER merch_marking_trade_item_profile_readiness
AFTER UPDATE
ON public.merch_marking_trade_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION getomerch_marking.check_trade_item_profile_constraint();

CREATE OR REPLACE FUNCTION getomerch_marking.process_transition_allowed(
  from_status text,
  to_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE from_status
    WHEN 'open' THEN to_status = ANY (
      ARRAY['waiting_user', 'waiting_external', 'ready', 'manual_review',
            'failed', 'cancelled']
    )
    WHEN 'waiting_user' THEN to_status = ANY (
      ARRAY['open', 'waiting_external', 'ready', 'manual_review',
            'failed', 'cancelled']
    )
    WHEN 'waiting_external' THEN to_status = ANY (
      ARRAY['waiting_user', 'ready', 'manual_review', 'failed', 'cancelled']
    )
    WHEN 'ready' THEN to_status = ANY (
      ARRAY['waiting_user', 'waiting_external', 'completed', 'manual_review',
            'failed', 'cancelled']
    )
    WHEN 'manual_review' THEN to_status = ANY (
      ARRAY['open', 'waiting_user', 'waiting_external', 'ready', 'failed',
            'cancelled']
    )
    WHEN 'failed' THEN to_status = ANY (
      ARRAY['open', 'manual_review', 'cancelled']
    )
    ELSE false
  END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.create_process(
  p_process_type text,
  p_fulfillment_order_id uuid,
  p_fulfillment_item_id uuid,
  p_source text,
  p_source_key text,
  p_priority integer,
  p_current_step text,
  p_next_action text,
  p_deadline_at timestamp with time zone,
  p_actor_type text,
  p_actor_id text
)
RETURNS TABLE (
  id uuid,
  status text,
  version bigint,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  created_process public.merch_marking_processes%ROWTYPE;
BEGIN
  INSERT INTO public.merch_marking_processes (
    process_type,
    fulfillment_order_id,
    fulfillment_item_id,
    source,
    source_key,
    priority,
    current_step,
    next_action,
    deadline_at
  )
  VALUES (
    p_process_type,
    p_fulfillment_order_id,
    p_fulfillment_item_id,
    p_source,
    p_source_key,
    p_priority,
    p_current_step,
    p_next_action,
    p_deadline_at
  )
  RETURNING * INTO created_process;

  INSERT INTO public.merch_marking_events (
    process_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    created_process.id,
    'process_created',
    p_actor_type,
    p_actor_id,
    p_source,
    jsonb_build_object(
      'status', created_process.status,
      'currentStep', created_process.current_step,
      'version', created_process.version
    ),
    created_process.created_at
  );

  RETURN QUERY SELECT
    created_process.id,
    created_process.status,
    created_process.version,
    created_process.created_at,
    created_process.updated_at;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.transition_process(
  p_process_id uuid,
  p_expected_version bigint,
  p_to_status text,
  p_current_step text,
  p_next_action text,
  p_deadline_at timestamp with time zone,
  p_manual_review_reason text,
  p_last_error_code text,
  p_owner text,
  p_actor_type text,
  p_actor_id text,
  p_source text
)
RETURNS TABLE (
  id uuid,
  status text,
  version bigint,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_process public.merch_marking_processes%ROWTYPE;
  updated_process public.merch_marking_processes%ROWTYPE;
BEGIN
  SELECT process.*
  INTO current_process
  FROM public.merch_marking_processes AS process
  WHERE process.id = p_process_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking process not found' USING ERRCODE = 'MZ001';
  END IF;
  IF current_process.version <> p_expected_version THEN
    RAISE EXCEPTION 'marking process version conflict' USING ERRCODE = 'MZ002';
  END IF;
  IF NOT getomerch_marking.process_transition_allowed(
    current_process.status,
    p_to_status
  ) THEN
    RAISE EXCEPTION 'marking process transition is not allowed'
      USING ERRCODE = 'MZ003';
  END IF;

  UPDATE public.merch_marking_processes AS process
  SET
    status = p_to_status,
    current_step = p_current_step,
    next_action = p_next_action,
    deadline_at = p_deadline_at,
    manual_review_reason = CASE
      WHEN p_to_status = 'manual_review' THEN p_manual_review_reason
      ELSE NULL
    END,
    last_error_code = CASE
      WHEN p_to_status = 'failed' THEN p_last_error_code
      ELSE NULL
    END,
    owner = p_owner,
    version = process.version + 1,
    updated_at = clock_timestamp(),
    completed_at = CASE
      WHEN p_to_status = ANY (ARRAY['completed', 'cancelled'])
        THEN clock_timestamp()
      ELSE NULL
    END
  WHERE process.id = p_process_id
    AND process.version = p_expected_version
  RETURNING process.* INTO updated_process;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking process version conflict' USING ERRCODE = 'MZ002';
  END IF;

  INSERT INTO public.merch_marking_events (
    process_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    updated_process.id,
    'process_transitioned',
    p_actor_type,
    p_actor_id,
    p_source,
    jsonb_build_object(
      'fromStatus', current_process.status,
      'toStatus', updated_process.status,
      'currentStep', updated_process.current_step,
      'nextAction', updated_process.next_action,
      'version', updated_process.version
    ),
    updated_process.updated_at
  );

  RETURN QUERY SELECT
    updated_process.id,
    updated_process.status,
    updated_process.version,
    updated_process.created_at,
    updated_process.updated_at;
END
$function$;

REVOKE ALL ON SCHEMA getomerch_marking FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA getomerch_marking FROM PUBLIC;
REVOKE ALL ON
  public.merch_marking_trade_items,
  public.merch_marking_trade_item_documents,
  public.merch_marking_product_profiles,
  public.merch_marking_locations,
  public.merch_marking_processes,
  public.merch_marking_evidence,
  public.merch_marking_events
FROM getomerch_app;

GRANT USAGE ON SCHEMA getomerch_marking TO getomerch_app, getomerch_backup;
GRANT SELECT ON
  public.merch_marking_trade_items,
  public.merch_marking_trade_item_documents,
  public.merch_marking_product_profiles,
  public.merch_marking_locations,
  public.merch_marking_processes,
  public.merch_marking_evidence,
  public.merch_marking_events
TO getomerch_app, getomerch_backup;
GRANT SELECT ON SEQUENCE public.merch_marking_events_id_seq
TO getomerch_backup;
GRANT EXECUTE ON FUNCTION getomerch_marking.is_valid_gtin14(text)
TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.create_process(
  text, uuid, uuid, text, text, integer, text, text,
  timestamp with time zone, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.transition_process(
  uuid, bigint, text, text, text, timestamp with time zone,
  text, text, text, text, text, text
) TO getomerch_app;

COMMENT ON TABLE public.merch_marking_trade_item_documents IS
  'Optional reference documents; absence does not block marking readiness.';
COMMENT ON COLUMN public.merch_marking_evidence.payload_envelope IS
  'Reserved for a later encrypted-evidence stage; constrained to NULL in Stage 3.';
COMMENT ON COLUMN public.merch_marking_processes.marking_unit_id IS
  'Reserved for Stage 6; constrained to NULL until the unit table and FK exist.';
COMMENT ON COLUMN public.merch_marking_processes.assignment_id IS
  'Reserved for Stage 6; constrained to NULL until the assignment table and FK exist.';
