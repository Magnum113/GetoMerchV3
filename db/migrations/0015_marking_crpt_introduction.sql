-- Stage 10: durable LP_INTRODUCE_GOODS documents. Full marking codes,
-- canonical payloads and signatures remain encrypted at rest.

CREATE TABLE public.merch_marking_documents (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    document_type text NOT NULL,
    operation_mode text NOT NULL,
    product_group text DEFAULT 'lp'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    location_id uuid NOT NULL
      REFERENCES public.merch_marking_locations(id) ON DELETE RESTRICT,
    location_snapshot jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    supersedes_document_id uuid
      REFERENCES public.merch_marking_documents(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL UNIQUE,
    api_contract_version text NOT NULL,
    payload_ciphertext bytea,
    payload_nonce bytea,
    payload_auth_tag bytea,
    payload_key_version integer,
    payload_hash text,
    signature_ciphertext bytea,
    signature_nonce bytea,
    signature_auth_tag bytea,
    signature_key_version integer,
    signature_hash text,
    certificate_thumbprint text,
    external_document_id text UNIQUE,
    response_redacted jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    error_message text,
    attempt_count integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    request_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    payload_built_at timestamp with time zone,
    signed_at timestamp with time zone,
    submitted_at timestamp with time zone,
    checked_at timestamp with time zone,
    accepted_at timestamp with time zone,
    rejected_at timestamp with time zone,
    CONSTRAINT merch_marking_documents_type_check
      CHECK (document_type = 'introduction'),
    CONSTRAINT merch_marking_documents_mode_check
      CHECK (operation_mode = 'own_production'),
    CONSTRAINT merch_marking_documents_group_check
      CHECK (product_group = 'lp'),
    CONSTRAINT merch_marking_documents_status_check
      CHECK (status = ANY (ARRAY[
        'draft'::text, 'payload_built'::text, 'signed'::text, 'submitting'::text,
        'processing'::text, 'accepted'::text, 'rejected'::text,
        'requires_manual_review'::text, 'superseded'::text
      ])),
    CONSTRAINT merch_marking_documents_location_snapshot_check
      CHECK (jsonb_typeof(location_snapshot) = 'object'
        AND octet_length(location_snapshot::text) <= 16384),
    CONSTRAINT merch_marking_documents_revision_check CHECK (revision >= 1),
    CONSTRAINT merch_marking_documents_supersede_check
      CHECK ((revision = 1 AND supersedes_document_id IS NULL)
        OR (revision > 1 AND supersedes_document_id IS NOT NULL)),
    CONSTRAINT merch_marking_documents_idempotency_check
      CHECK (length(idempotency_key) BETWEEN 16 AND 300),
    CONSTRAINT merch_marking_documents_contract_check
      CHECK (length(api_contract_version) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_documents_payload_check CHECK (
      (payload_ciphertext IS NULL AND payload_nonce IS NULL
        AND payload_auth_tag IS NULL AND payload_key_version IS NULL
        AND payload_hash IS NULL AND payload_built_at IS NULL
        AND status = ANY (ARRAY['draft'::text, 'requires_manual_review'::text,
          'superseded'::text]))
      OR
      (payload_ciphertext IS NOT NULL
        AND octet_length(payload_ciphertext) BETWEEN 1 AND 1048576
        AND octet_length(payload_nonce) = 12
        AND octet_length(payload_auth_tag) = 16
        AND payload_key_version BETWEEN 1 AND 1000000
        AND payload_hash ~ '^[0-9a-f]{64}$' AND payload_built_at IS NOT NULL)
    ),
    CONSTRAINT merch_marking_documents_signature_check CHECK (
      (signature_ciphertext IS NULL AND signature_nonce IS NULL
        AND signature_auth_tag IS NULL AND signature_key_version IS NULL
        AND signature_hash IS NULL AND certificate_thumbprint IS NULL
        AND signed_at IS NULL
        AND status = ANY (ARRAY['draft'::text, 'payload_built'::text,
          'requires_manual_review'::text, 'superseded'::text]))
      OR
      (signature_ciphertext IS NOT NULL
        AND octet_length(signature_ciphertext) BETWEEN 64 AND 262144
        AND octet_length(signature_nonce) = 12
        AND octet_length(signature_auth_tag) = 16
        AND signature_key_version BETWEEN 1 AND 1000000
        AND signature_hash ~ '^[0-9a-f]{64}$'
        AND certificate_thumbprint ~ '^[0-9A-F]{40,128}$'
        AND signed_at IS NOT NULL)
    ),
    CONSTRAINT merch_marking_documents_external_check CHECK (
      (external_document_id ~ '^[A-Za-z0-9._:-]{1,200}$'
        AND submitted_at IS NOT NULL)
      OR
      (external_document_id IS NULL AND submitted_at IS NULL
        AND status <> ALL (ARRAY['processing'::text, 'accepted'::text, 'rejected'::text]))
    ),
    CONSTRAINT merch_marking_documents_response_check
      CHECK (jsonb_typeof(response_redacted) = 'object'
        AND octet_length(response_redacted::text) <= 32768),
    CONSTRAINT merch_marking_documents_error_check CHECK (
      ((error_code IS NULL) = (error_message IS NULL))
      AND (status <> ALL (ARRAY['rejected'::text, 'requires_manual_review'::text])
        OR (error_code IS NOT NULL AND error_message IS NOT NULL))
    ),
    CONSTRAINT merch_marking_documents_error_value_check CHECK (
      (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_:-]{2,120}$')
      AND (error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000)
    ),
    CONSTRAINT merch_marking_documents_actor_check
      CHECK (length(created_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_documents_attempt_check
      CHECK (attempt_count BETWEEN 0 AND 50),
    CONSTRAINT merch_marking_documents_terminal_time_check CHECK (
      (status = 'accepted' AND accepted_at IS NOT NULL AND rejected_at IS NULL)
      OR (status = 'rejected' AND rejected_at IS NOT NULL AND accepted_at IS NULL)
      OR (status = 'superseded')
      OR (status <> ALL (ARRAY['accepted'::text, 'rejected'::text, 'superseded'::text])
        AND accepted_at IS NULL AND rejected_at IS NULL)
    )
);

CREATE TABLE public.merch_marking_document_codes (
    document_id uuid NOT NULL
      REFERENCES public.merch_marking_documents(id) ON DELETE RESTRICT,
    marking_code_id uuid NOT NULL
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    marking_unit_id uuid NOT NULL
      REFERENCES public.merch_marking_units(id) ON DELETE RESTRICT,
    assignment_id uuid NOT NULL
      REFERENCES public.merch_marking_assignments(id) ON DELETE RESTRICT,
    gtin_snapshot text NOT NULL,
    code_fingerprint text NOT NULL,
    link_state text DEFAULT 'active'::text NOT NULL,
    operation_result text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (document_id, marking_code_id),
    CONSTRAINT merch_marking_document_codes_gtin_check
      CHECK (getomerch_marking.is_valid_gtin14(gtin_snapshot)),
    CONSTRAINT merch_marking_document_codes_fingerprint_check
      CHECK (code_fingerprint ~ '^[0-9a-f]{12}$'),
    CONSTRAINT merch_marking_document_codes_link_check
      CHECK (link_state = ANY (ARRAY['active'::text, 'superseded'::text])),
    CONSTRAINT merch_marking_document_codes_result_check
      CHECK (operation_result = ANY (ARRAY[
        'pending'::text, 'accepted'::text, 'rejected'::text,
        'requires_manual_review'::text
      ])),
    CONSTRAINT merch_marking_document_codes_error_check CHECK (
      (operation_result = ANY (ARRAY['rejected'::text, 'requires_manual_review'::text])
        AND error_code IS NOT NULL AND error_message IS NOT NULL)
      OR
      (operation_result <> ALL (ARRAY['rejected'::text, 'requires_manual_review'::text])
        AND error_code IS NULL AND error_message IS NULL)
    ),
    CONSTRAINT merch_marking_document_codes_error_value_check CHECK (
      (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_:-]{2,120}$')
      AND (error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000)
    )
);

CREATE TABLE public.merch_marking_document_confirmations (
    document_id uuid PRIMARY KEY
      REFERENCES public.merch_marking_documents(id) ON DELETE RESTRICT,
    circulation_state text DEFAULT 'pending'::text NOT NULL,
    raw_status text,
    error_code text,
    error_message text,
    checked_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_document_confirmations_state_check
      CHECK (circulation_state = ANY (ARRAY[
        'pending'::text, 'confirmed'::text, 'requires_manual_review'::text
      ])),
    CONSTRAINT merch_marking_document_confirmations_raw_check
      CHECK (raw_status IS NULL OR length(raw_status) BETWEEN 1 AND 300),
    CONSTRAINT merch_marking_document_confirmations_error_check CHECK (
      (circulation_state = 'requires_manual_review'
        AND error_code IS NOT NULL AND error_message IS NOT NULL)
      OR
      (circulation_state <> 'requires_manual_review'
        AND error_code IS NULL AND error_message IS NULL)
    ),
    CONSTRAINT merch_marking_document_confirmations_error_value_check CHECK (
      (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_:-]{2,120}$')
      AND (error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000)
    ),
    CONSTRAINT merch_marking_document_confirmations_time_check CHECK (
      (circulation_state = 'confirmed' AND confirmed_at IS NOT NULL)
      OR (circulation_state <> 'confirmed' AND confirmed_at IS NULL)
    )
);

CREATE OR REPLACE FUNCTION getomerch_marking.protect_marking_document_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marking document confirmation is append-only' USING ERRCODE = 'MZA15';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id
     OR OLD.circulation_state = 'confirmed' THEN
    RAISE EXCEPTION 'confirmed marking document state is immutable' USING ERRCODE = 'MZA15';
  END IF;
  IF OLD.circulation_state = 'pending'
       AND NEW.circulation_state <> ALL (ARRAY[
         'pending'::text, 'confirmed'::text, 'requires_manual_review'::text])
     OR OLD.circulation_state = 'requires_manual_review'
       AND NEW.circulation_state <> ALL (ARRAY[
         'requires_manual_review'::text, 'confirmed'::text]) THEN
    RAISE EXCEPTION 'invalid circulation confirmation transition' USING ERRCODE = 'MZA15';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER merch_marking_document_confirmations_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_document_confirmations
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_marking_document_confirmation();

CREATE UNIQUE INDEX merch_marking_document_codes_active_assignment
  ON public.merch_marking_document_codes (assignment_id)
  WHERE link_state = 'active';
CREATE UNIQUE INDEX merch_marking_document_codes_active_code
  ON public.merch_marking_document_codes (marking_code_id)
  WHERE link_state = 'active';
CREATE INDEX merch_marking_documents_status_updated
  ON public.merch_marking_documents (status, updated_at DESC, id DESC);
CREATE INDEX merch_marking_documents_external
  ON public.merch_marking_documents (external_document_id)
  WHERE external_document_id IS NOT NULL;

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

CREATE TRIGGER merch_marking_documents_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_documents
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_marking_document();

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
  IF document_status = ANY (
      ARRAY['accepted'::text, 'superseded'::text]) THEN
    RAISE EXCEPTION 'marking document code is immutable' USING ERRCODE = 'MZA14';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.marking_code_id IS DISTINCT FROM OLD.marking_code_id
    OR NEW.marking_unit_id IS DISTINCT FROM OLD.marking_unit_id
    OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
    OR NEW.gtin_snapshot IS DISTINCT FROM OLD.gtin_snapshot
    OR NEW.code_fingerprint IS DISTINCT FROM OLD.code_fingerprint
  ) THEN
    RAISE EXCEPTION 'marking document code identity is immutable' USING ERRCODE = 'MZA14';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER merch_marking_document_codes_protect
BEFORE UPDATE OR DELETE ON public.merch_marking_document_codes
FOR EACH ROW EXECUTE FUNCTION getomerch_marking.protect_marking_document_code();

CREATE OR REPLACE FUNCTION getomerch_marking.prepare_introduction_document(
  p_assignment_id uuid,
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
DECLARE current_record record;
DECLARE existing_record record;
DECLARE selected_location public.merch_marking_locations%ROWTYPE;
DECLARE location_count integer;
DECLARE next_revision integer := 1;
DECLARE created_id uuid;
BEGIN
  IF p_assignment_id IS NULL OR p_request_id IS NULL OR p_actor_id IS NULL
     OR length(p_actor_id) NOT BETWEEN 1 AND 200 OR p_force_correction IS NULL THEN
    RAISE EXCEPTION 'invalid introduction document request' USING ERRCODE = 'MZA20';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'marking-introduction:' || p_assignment_id::text, 0));

  SELECT assignment.id AS assignment_id, assignment.marking_unit_id,
    assignment.code_binding_id, assignment.gtin_snapshot,
    assignment.status AS assignment_status, unit.warehouse_id, unit.unit_state,
    binding.marking_code_id, binding.status AS binding_status,
    binding.label_state, binding.applied_at, code.pool_state, code.crpt_state,
    code.fingerprint, profile.operational_status, profile.verification_status,
    profile.production_mode, trade_item.product_group, trade_item.tnved_code,
    trade_item.verification_status AS trade_verification_status,
    process.id AS process_id
  INTO current_record
  FROM public.merch_marking_assignments AS assignment
  JOIN public.merch_marking_units AS unit ON unit.id = assignment.marking_unit_id
  JOIN public.merch_marking_code_bindings AS binding ON binding.id = assignment.code_binding_id
  JOIN public.merch_marking_codes AS code ON code.id = binding.marking_code_id
  JOIN public.merch_marking_product_profiles AS profile ON profile.id = assignment.product_profile_id
  JOIN public.merch_marking_trade_items AS trade_item ON trade_item.id = profile.trade_item_id
  LEFT JOIN public.merch_marking_processes AS process
    ON process.assignment_id = assignment.id
   AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
  WHERE assignment.id = p_assignment_id
  FOR UPDATE OF assignment, unit, binding, code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking assignment not found' USING ERRCODE = 'MZA21';
  END IF;
  IF current_record.assignment_status <> 'active'
     OR current_record.unit_state <> 'marking_pending'
     OR current_record.binding_status <> 'active'
     OR current_record.label_state <> 'applied'
     OR current_record.pool_state <> 'bound' THEN
    RAISE EXCEPTION 'marking assignment is not physically applied' USING ERRCODE = 'MZA22';
  END IF;
  IF current_record.operational_status <> 'enabled'
     OR current_record.verification_status <> 'verified'
     OR current_record.production_mode <> 'own_production'
     OR current_record.trade_verification_status <> 'verified'
     OR current_record.product_group <> 'lp'
     OR current_record.tnved_code !~ '^[0-9]{4,10}$' THEN
    RAISE EXCEPTION 'marking product profile is not ready for introduction' USING ERRCODE = 'MZA23';
  END IF;
  SELECT count(*)::integer INTO location_count
  FROM public.merch_marking_locations AS location
  WHERE location.warehouse_id = current_record.warehouse_id
    AND location.status = 'verified';
  IF location_count <> 1 THEN
    RAISE EXCEPTION 'exactly one verified marking location is required' USING ERRCODE = 'MZA24';
  END IF;
  SELECT location.* INTO selected_location
  FROM public.merch_marking_locations AS location
  WHERE location.warehouse_id = current_record.warehouse_id
    AND location.status = 'verified';

  SELECT document.id, document.status, document.revision, document.error_code
  INTO existing_record
  FROM public.merch_marking_document_codes AS link
  JOIN public.merch_marking_documents AS document ON document.id = link.document_id
  WHERE link.assignment_id = p_assignment_id AND link.link_state = 'active'
  FOR UPDATE OF document, link;
  IF FOUND AND NOT p_force_correction THEN
    RETURN QUERY SELECT existing_record.id, existing_record.status,
      existing_record.revision, true;
    RETURN;
  END IF;
  IF FOUND THEN
    IF existing_record.status <> ALL (
      ARRAY['rejected'::text, 'requires_manual_review'::text]) THEN
      RAISE EXCEPTION 'only failed introduction can be superseded' USING ERRCODE = 'MZA25';
    END IF;
    IF existing_record.error_code = 'crpt_submit_outcome_unknown' THEN
      RAISE EXCEPTION 'ambiguous submission must be reconciled before correction'
        USING ERRCODE = 'MZA35';
    END IF;
    next_revision := existing_record.revision + 1;
    UPDATE public.merch_marking_document_codes AS link
    SET link_state = 'superseded', updated_at = clock_timestamp()
    WHERE link.document_id = existing_record.id;
    UPDATE public.merch_marking_documents AS document
    SET status = 'superseded', updated_at = clock_timestamp()
    WHERE document.id = existing_record.id;
  END IF;

  INSERT INTO public.merch_marking_documents (
    document_type, operation_mode, location_id, location_snapshot, revision,
    supersedes_document_id, idempotency_key, api_contract_version,
    created_by, request_id
  ) VALUES (
    'introduction', 'own_production', selected_location.id,
    jsonb_build_object(
      'name', selected_location.name,
      'warehouseId', selected_location.warehouse_id,
      'kpp', selected_location.kpp,
      'fiasId', selected_location.fias_id,
      'crptLocationId', selected_location.crpt_location_id,
      'address', selected_location.address_snapshot,
      'verifiedAt', selected_location.verified_at
    ),
    next_revision, CASE WHEN existing_record.id IS NULL THEN NULL ELSE existing_record.id END,
    'lp-introduction:' || p_assignment_id::text || ':r' || next_revision::text,
    'true-api-v649.0-2026-04-15', p_actor_id, p_request_id
  ) RETURNING id INTO created_id;
  INSERT INTO public.merch_marking_document_codes (
    document_id, marking_code_id, marking_unit_id, assignment_id,
    gtin_snapshot, code_fingerprint
  ) VALUES (
    created_id, current_record.marking_code_id, current_record.marking_unit_id,
    current_record.assignment_id, current_record.gtin_snapshot,
    current_record.fingerprint
  );
  INSERT INTO public.merch_marking_document_confirmations (document_id)
  VALUES (created_id);
  INSERT INTO public.merch_marking_events (
    marking_code_id, marking_unit_id, code_binding_id, assignment_id,
    process_id, document_id, event_type, actor_type, actor_id, source,
    details_redacted, occurred_at
  ) VALUES (
    current_record.marking_code_id, current_record.marking_unit_id,
    current_record.code_binding_id, current_record.assignment_id,
    current_record.process_id, created_id, 'crpt_introduction_draft_created',
    'worker', p_actor_id, 'marking_crpt_introduction',
    jsonb_build_object('gtin', current_record.gtin_snapshot,
      'revision', next_revision, 'documentType', 'LP_INTRODUCE_GOODS'),
    clock_timestamp()
  );
  RETURN QUERY SELECT created_id, 'draft'::text, next_revision, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.get_introduction_document_material(
  p_document_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  document_id uuid, document_status text, api_contract_version text,
  gtin text, offer_id text, tnved_code text, production_date date,
  code_fingerprint text,
  code_ciphertext bytea, code_nonce bytea, code_auth_tag bytea,
  code_key_version integer, payload_hash text, payload_ciphertext bytea,
  payload_nonce bytea, payload_auth_tag bytea, payload_key_version integer,
  signature_hash text, signature_ciphertext bytea, signature_nonce bytea,
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
    RAISE EXCEPTION 'invalid introduction material request' USING ERRCODE = 'MZA26';
  END IF;
  RETURN QUERY
  SELECT document.id, document.status, document.api_contract_version,
    link.gtin_snapshot, assignment.offer_id, trade_item.tnved_code,
    binding.applied_at::date,
    link.code_fingerprint, code.code_ciphertext, code.code_nonce,
    code.code_auth_tag, code.encryption_key_version,
    document.payload_hash, document.payload_ciphertext, document.payload_nonce,
    document.payload_auth_tag, document.payload_key_version,
    document.signature_hash, document.signature_ciphertext,
    document.signature_nonce, document.signature_auth_tag,
    document.signature_key_version, document.external_document_id
  FROM public.merch_marking_documents AS document
  JOIN public.merch_marking_document_codes AS link ON link.document_id = document.id
  JOIN public.merch_marking_codes AS code ON code.id = link.marking_code_id
  JOIN public.merch_marking_code_bindings AS binding
    ON binding.marking_code_id = code.id AND binding.marking_unit_id = link.marking_unit_id
   AND binding.status = 'active'
  JOIN public.merch_marking_assignments AS assignment ON assignment.id = link.assignment_id
  JOIN public.merch_marking_product_profiles AS profile
    ON profile.id = assignment.product_profile_id
  JOIN public.merch_marking_trade_items AS trade_item ON trade_item.id = profile.trade_item_id
  WHERE document.id = p_document_id AND link.link_state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'introduction document material not found' USING ERRCODE = 'MZA27';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.store_introduction_payload(
  p_document_id uuid, p_payload_hash text, p_ciphertext bytea, p_nonce bytea,
  p_auth_tag bytea, p_key_version integer, p_actor_id text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record record;
BEGIN
  SELECT id, status, payload_hash INTO current_record
  FROM public.merch_marking_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document not found' USING ERRCODE = 'MZA27'; END IF;
  IF current_record.status <> 'draft' THEN
    IF current_record.payload_hash = p_payload_hash THEN RETURN current_record.status; END IF;
    RAISE EXCEPTION 'payload digest conflict' USING ERRCODE = 'MZA28';
  END IF;
  UPDATE public.merch_marking_documents SET
    status = 'payload_built', payload_hash = p_payload_hash,
    payload_ciphertext = p_ciphertext, payload_nonce = p_nonce,
    payload_auth_tag = p_auth_tag, payload_key_version = p_key_version,
    payload_built_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_document_id;
  RETURN 'payload_built';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.store_introduction_signature(
  p_document_id uuid, p_signature_hash text, p_ciphertext bytea, p_nonce bytea,
  p_auth_tag bytea, p_key_version integer, p_certificate_thumbprint text,
  p_actor_id text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record record;
BEGIN
  SELECT id, status, signature_hash INTO current_record
  FROM public.merch_marking_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document not found' USING ERRCODE = 'MZA27'; END IF;
  IF current_record.status <> 'payload_built' THEN
    IF current_record.signature_hash = p_signature_hash THEN RETURN current_record.status; END IF;
    RAISE EXCEPTION 'signature digest conflict' USING ERRCODE = 'MZA29';
  END IF;
  UPDATE public.merch_marking_documents SET status = 'signed',
    signature_hash = p_signature_hash, signature_ciphertext = p_ciphertext,
    signature_nonce = p_nonce, signature_auth_tag = p_auth_tag,
    signature_key_version = p_key_version,
    certificate_thumbprint = p_certificate_thumbprint,
    signed_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_document_id;
  RETURN 'signed';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_introduction_submitted(
  p_document_id uuid, p_external_document_id text,
  p_response_redacted jsonb, p_actor_id text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record record;
BEGIN
  SELECT id, status, external_document_id INTO current_record
  FROM public.merch_marking_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document not found' USING ERRCODE = 'MZA27'; END IF;
  IF current_record.status = ANY (ARRAY['processing'::text, 'accepted'::text]) THEN
    IF current_record.external_document_id = p_external_document_id THEN RETURN current_record.status; END IF;
    RAISE EXCEPTION 'external document conflict' USING ERRCODE = 'MZA30';
  END IF;
  IF current_record.status <> 'submitting' OR p_external_document_id !~ '^[A-Za-z0-9._:-]{1,200}$'
     OR jsonb_typeof(p_response_redacted) <> 'object' THEN
    RAISE EXCEPTION 'document is not submittable' USING ERRCODE = 'MZA31';
  END IF;
  UPDATE public.merch_marking_documents SET status = 'processing',
    external_document_id = p_external_document_id,
    response_redacted = p_response_redacted,
    submitted_at = clock_timestamp(), checked_at = clock_timestamp(),
    updated_at = clock_timestamp() WHERE id = p_document_id;
  RETURN 'processing';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_introduction_submit_started(
  p_document_id uuid, p_actor_id text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_status text;
BEGIN
  IF p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid introduction submit actor' USING ERRCODE = 'MZA31';
  END IF;
  SELECT document.status INTO current_status
  FROM public.merch_marking_documents AS document
  WHERE document.id = p_document_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document not found' USING ERRCODE = 'MZA27'; END IF;
  IF current_status = 'submitting' THEN RETURN current_status; END IF;
  IF current_status <> 'signed' THEN
    RAISE EXCEPTION 'document is not ready to submit' USING ERRCODE = 'MZA31';
  END IF;
  UPDATE public.merch_marking_documents SET
    status = 'submitting', attempt_count = attempt_count + 1,
    checked_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_document_id;
  RETURN 'submitting';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_introduction_poll(
  p_document_id uuid, p_remote_status text, p_response_redacted jsonb,
  p_error_code text, p_error_message text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE next_status text;
DECLARE current_status text;
BEGIN
  IF p_remote_status IS NULL OR length(p_remote_status) NOT BETWEEN 1 AND 120
     OR jsonb_typeof(p_response_redacted) <> 'object' THEN
    RAISE EXCEPTION 'invalid introduction poll' USING ERRCODE = 'MZA32';
  END IF;
  next_status := CASE upper(p_remote_status)
    WHEN 'CHECKED_OK' THEN 'accepted'
    WHEN 'CHECKED_NOT_OK' THEN 'rejected'
    WHEN 'PROCESSING_ERROR' THEN 'rejected'
    WHEN 'PARSE_ERROR' THEN 'rejected'
    ELSE 'processing' END;
  SELECT document.status INTO current_status
  FROM public.merch_marking_documents AS document
  WHERE document.id = p_document_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'MZA27';
  END IF;
  IF current_status = ANY (ARRAY['accepted'::text, 'rejected'::text]) THEN
    RETURN current_status;
  END IF;
  IF current_status <> 'processing' THEN
    RAISE EXCEPTION 'document is not being processed' USING ERRCODE = 'MZA32';
  END IF;
  -- Code results must change before the parent becomes terminal and immutable.
  UPDATE public.merch_marking_document_codes AS link SET
    operation_result = CASE next_status
      WHEN 'accepted' THEN 'accepted' WHEN 'rejected' THEN 'rejected'
      ELSE 'pending' END,
    error_code = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_code, 'crpt_document_rejected') ELSE NULL END,
    error_message = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_message, 'GIS MT rejected the introduction document') ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE link.document_id = p_document_id;
  UPDATE public.merch_marking_documents AS document SET
    status = next_status, response_redacted = p_response_redacted,
    error_code = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_code, 'crpt_document_rejected') ELSE NULL END,
    error_message = CASE WHEN next_status = 'rejected'
      THEN coalesce(p_error_message, 'GIS MT rejected the introduction document') ELSE NULL END,
    checked_at = clock_timestamp(),
    accepted_at = CASE WHEN next_status = 'accepted' THEN clock_timestamp() ELSE NULL END,
    rejected_at = CASE WHEN next_status = 'rejected' THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE document.id = p_document_id;
  IF next_status = 'accepted' THEN
    UPDATE public.merch_marking_codes AS code SET crpt_state = 'introduced',
      crpt_status_raw = 'INTRODUCED', crpt_checked_at = clock_timestamp(),
      revision = revision + 1, updated_at = clock_timestamp()
    FROM public.merch_marking_document_codes AS link
    WHERE link.document_id = p_document_id AND code.id = link.marking_code_id
      AND code.crpt_state <> 'in_circulation';
  END IF;
  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_introduction_manual_review(
  p_document_id uuid, p_error_code text, p_error_message text,
  p_response_redacted jsonb
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE public.merch_marking_document_codes SET
    operation_result = 'requires_manual_review', error_code = p_error_code,
    error_message = p_error_message, updated_at = clock_timestamp()
  WHERE document_id = p_document_id
    AND EXISTS (
      SELECT 1 FROM public.merch_marking_documents AS document
      WHERE document.id = p_document_id
        AND document.status = ANY (ARRAY[
          'draft'::text, 'payload_built'::text, 'signed'::text,
          'submitting'::text, 'processing'::text])
    );
  UPDATE public.merch_marking_documents AS document SET
    status = 'requires_manual_review', error_code = p_error_code,
    error_message = p_error_message, response_redacted = p_response_redacted,
    checked_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE document.id = p_document_id
    AND document.status = ANY (ARRAY[
      'draft'::text, 'payload_built'::text, 'signed'::text,
      'submitting'::text, 'processing'::text]);
  IF NOT FOUND THEN RAISE EXCEPTION 'document is not reviewable' USING ERRCODE = 'MZA33'; END IF;
  RETURN 'requires_manual_review';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.record_introduction_circulation_review(
  p_document_id uuid, p_error_code text, p_error_message text,
  p_raw_status text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_error_code !~ '^[A-Za-z0-9_:-]{2,120}$'
     OR length(p_error_message) NOT BETWEEN 1 AND 1000
     OR (p_raw_status IS NOT NULL AND length(p_raw_status) NOT BETWEEN 1 AND 300) THEN
    RAISE EXCEPTION 'invalid circulation review request' USING ERRCODE = 'MZA36';
  END IF;
  UPDATE public.merch_marking_document_confirmations AS confirmation SET
    circulation_state = 'requires_manual_review', raw_status = p_raw_status,
    error_code = p_error_code, error_message = p_error_message,
    checked_at = clock_timestamp(), updated_at = clock_timestamp()
  FROM public.merch_marking_documents AS document
  WHERE confirmation.document_id = p_document_id
    AND document.id = confirmation.document_id
    AND document.status = 'accepted'
    AND confirmation.circulation_state <> 'confirmed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted introduction confirmation required' USING ERRCODE = 'MZA34';
  END IF;
  RETURN 'requires_manual_review';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.confirm_introduction_circulation(
  p_document_id uuid, p_raw_status text, p_actor_id text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE current_record record;
BEGIN
  IF p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_raw_status IS NULL OR length(p_raw_status) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid circulation confirmation' USING ERRCODE = 'MZA36';
  END IF;
  SELECT document.status, confirmation.circulation_state,
    link.marking_code_id, link.marking_unit_id,
    link.assignment_id, assignment.code_binding_id, process.id AS process_id
  INTO current_record
  FROM public.merch_marking_documents AS document
  JOIN public.merch_marking_document_confirmations AS confirmation
    ON confirmation.document_id = document.id
  JOIN public.merch_marking_document_codes AS link ON link.document_id = document.id
  JOIN public.merch_marking_assignments AS assignment ON assignment.id = link.assignment_id
  LEFT JOIN public.merch_marking_processes AS process
    ON process.assignment_id = assignment.id
   AND process.status <> ALL (ARRAY['completed'::text, 'cancelled'::text])
  WHERE document.id = p_document_id AND link.link_state = 'active'
  FOR UPDATE OF assignment, confirmation;
  IF NOT FOUND OR current_record.status <> 'accepted' THEN
    RAISE EXCEPTION 'accepted introduction document required' USING ERRCODE = 'MZA34';
  END IF;
  IF current_record.circulation_state = 'confirmed' THEN
    RETURN;
  END IF;
  UPDATE public.merch_marking_codes SET crpt_state = 'in_circulation',
    crpt_status_raw = left(p_raw_status, 300), crpt_checked_at = clock_timestamp(),
    revision = revision + 1, updated_at = clock_timestamp()
  WHERE id = current_record.marking_code_id;
  UPDATE public.merch_marking_units SET unit_state = 'reserved',
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = current_record.marking_unit_id AND unit_state = 'marking_pending';
  UPDATE public.merch_marking_processes SET status = 'waiting_external',
    current_step = 'crpt_in_circulation', next_action = 'Передать КМ в Ozon',
    version = version + 1, updated_at = clock_timestamp()
  WHERE id = current_record.process_id;
  UPDATE public.merch_marking_document_confirmations SET
    circulation_state = 'confirmed', raw_status = p_raw_status,
    error_code = NULL, error_message = NULL, checked_at = clock_timestamp(),
    confirmed_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE document_id = p_document_id;
  INSERT INTO public.merch_marking_events (
    marking_code_id, marking_unit_id, code_binding_id, assignment_id,
    process_id, document_id, event_type, actor_type, actor_id, source,
    details_redacted, occurred_at
  ) VALUES (
    current_record.marking_code_id, current_record.marking_unit_id,
    current_record.code_binding_id, current_record.assignment_id,
    current_record.process_id, p_document_id, 'crpt_introduction_confirmed',
    'worker', p_actor_id, 'marking_crpt_introduction',
    jsonb_build_object('state', 'in_circulation'), clock_timestamp()
  );
END
$function$;

ALTER TABLE public.merch_marking_events
  DROP CONSTRAINT merch_marking_events_stage6_future_subjects_check,
  ADD CONSTRAINT merch_marking_events_document_fk
    FOREIGN KEY (document_id) REFERENCES public.merch_marking_documents(id) ON DELETE RESTRICT;

ALTER TABLE public.merch_marking_signature_requests
  DROP CONSTRAINT merch_marking_signature_requests_purpose_check,
  ADD CONSTRAINT merch_marking_signature_requests_purpose_check CHECK (
    purpose = ANY (ARRAY[
      'crpt_auth_attached_cades_bes'::text,
      'crpt_document_detached_cades_bes'::text
    ])
  );

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
  confirmation.circulation_state, confirmation.raw_status AS circulation_raw_status,
  confirmation.error_code AS circulation_error_code,
  confirmation.error_message AS circulation_error_message,
  confirmation.checked_at AS circulation_checked_at,
  confirmation.confirmed_at AS circulation_confirmed_at
FROM public.merch_marking_documents AS document
JOIN public.merch_marking_document_confirmations AS confirmation
  ON confirmation.document_id = document.id;

CREATE OR REPLACE VIEW getomerch_marking.document_code_safe
WITH (security_barrier = true)
AS
SELECT link.document_id, link.marking_code_id, link.marking_unit_id,
  link.assignment_id, link.gtin_snapshot, link.code_fingerprint,
  link.link_state, link.operation_result, link.error_code, link.error_message,
  code.crpt_state,
  assignment.external_posting_number, assignment.offer_id,
  assignment.unit_ordinal, link.created_at, link.updated_at
FROM public.merch_marking_document_codes AS link
JOIN public.merch_marking_codes AS code ON code.id = link.marking_code_id
JOIN getomerch_marking.assignment_safe AS assignment
  ON assignment.id = link.assignment_id;

REVOKE ALL ON public.merch_marking_documents,
  public.merch_marking_document_codes,
  public.merch_marking_document_confirmations FROM PUBLIC, getomerch_app;
GRANT SELECT ON public.merch_marking_documents,
  public.merch_marking_document_codes,
  public.merch_marking_document_confirmations TO getomerch_backup;
REVOKE ALL ON getomerch_marking.document_safe,
  getomerch_marking.document_code_safe FROM PUBLIC;
GRANT SELECT ON getomerch_marking.document_safe,
  getomerch_marking.document_code_safe TO getomerch_app, getomerch_backup;

REVOKE ALL ON FUNCTION getomerch_marking.prepare_introduction_document(
  uuid,text,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_introduction_document_material(
  uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.store_introduction_payload(
  uuid,text,bytea,bytea,bytea,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.store_introduction_signature(
  uuid,text,bytea,bytea,bytea,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_introduction_submitted(
  uuid,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_introduction_submit_started(
  uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_introduction_poll(
  uuid,text,jsonb,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_introduction_manual_review(
  uuid,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.record_introduction_circulation_review(
  uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.confirm_introduction_circulation(
  uuid,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.prepare_introduction_document(
  uuid,text,uuid,boolean) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.get_introduction_document_material(
  uuid,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.store_introduction_payload(
  uuid,text,bytea,bytea,bytea,integer,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.store_introduction_signature(
  uuid,text,bytea,bytea,bytea,integer,text,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_introduction_submitted(
  uuid,text,jsonb,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_introduction_submit_started(
  uuid,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_introduction_poll(
  uuid,text,jsonb,text,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_introduction_manual_review(
  uuid,text,text,jsonb) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.record_introduction_circulation_review(
  uuid,text,text,text) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.confirm_introduction_circulation(
  uuid,text,text) TO getomerch_app;

COMMENT ON TABLE public.merch_marking_documents IS
  'Encrypted, revisioned CRPT legal documents. Safe views never expose payloads or signatures.';
COMMENT ON FUNCTION getomerch_marking.record_introduction_manual_review(
  uuid,text,text,jsonb) IS
  'Stops automatic submission after an ambiguous external outcome; a correction requires an explicit new revision.';
