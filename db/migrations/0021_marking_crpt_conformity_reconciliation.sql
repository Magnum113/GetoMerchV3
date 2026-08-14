-- Stage 10 hardening from the first production canary:
-- conformity references for LP_INTRODUCE_GOODS and explicit reconciliation
-- of create calls whose remote result was observed after a local timeout or
-- response-contract mismatch.

ALTER TABLE public.merch_marking_trade_item_documents
  ADD COLUMN verification_source text,
  ADD COLUMN external_reference text,
  ADD COLUMN verified_by text,
  ADD CONSTRAINT merch_marking_trade_item_documents_source_check CHECK (
    verification_source IS NULL OR length(verification_source) BETWEEN 1 AND 120
  ),
  ADD CONSTRAINT merch_marking_trade_item_documents_reference_check CHECK (
    external_reference IS NULL OR length(external_reference) BETWEEN 1 AND 500
  ),
  ADD CONSTRAINT merch_marking_trade_item_documents_actor_check CHECK (
    verified_by IS NULL OR length(verified_by) BETWEEN 1 AND 200
  );

CREATE INDEX merch_marking_trade_item_documents_active_conformity
  ON public.merch_marking_trade_item_documents (
    trade_item_id, issued_at DESC, id DESC
  )
  WHERE archived_at IS NULL
    AND document_type = ANY (ARRAY[
      'CONFORMITY_CERTIFICATE'::text,
      'CONFORMITY_DECLARATION'::text,
      'STATE_REGISTRATION_CERTIFICATE'::text
    ]);

CREATE OR REPLACE FUNCTION getomerch_marking.upsert_trade_item_conformity_document(
  p_profile_id uuid,
  p_expected_revision bigint,
  p_document_type text,
  p_document_number text,
  p_issued_at date,
  p_valid_until date,
  p_verification_source text,
  p_external_reference text,
  p_source_snapshot_hash text,
  p_actor_id text
)
RETURNS TABLE (
  document_id uuid,
  profile_revision bigint,
  trade_item_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  profile_record record;
  created_document_id uuid;
BEGIN
  IF p_profile_id IS NULL
     OR p_expected_revision IS NULL OR p_expected_revision < 1
     OR p_document_type IS NULL
     OR NOT (p_document_type = ANY (ARRAY[
       'CONFORMITY_CERTIFICATE'::text,
       'CONFORMITY_DECLARATION'::text,
       'STATE_REGISTRATION_CERTIFICATE'::text
     ]))
     OR p_document_number IS NULL
     OR length(btrim(p_document_number)) NOT BETWEEN 1 AND 300
     OR p_issued_at IS NULL
     OR p_issued_at > current_date
     OR p_issued_at < DATE '1900-01-01'
     OR (p_valid_until IS NOT NULL AND p_valid_until < p_issued_at)
     OR p_verification_source IS NULL
     OR length(p_verification_source) NOT BETWEEN 1 AND 120
     OR (p_external_reference IS NOT NULL
       AND length(p_external_reference) NOT BETWEEN 1 AND 500)
     OR p_source_snapshot_hash IS NULL
     OR p_source_snapshot_hash !~ '^[0-9a-f]{64}$'
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid conformity document request' USING ERRCODE = 'MZE00';
  END IF;

  SELECT profile.id, profile.trade_item_id, profile.revision
  INTO profile_record
  FROM public.merch_marking_product_profiles AS profile
  WHERE profile.id = p_profile_id
    AND profile.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR profile_record.trade_item_id IS NULL THEN
    RAISE EXCEPTION 'verified trade item profile not found' USING ERRCODE = 'MZE01';
  END IF;
  IF profile_record.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking profile revision conflict' USING ERRCODE = 'MZE02';
  END IF;

  UPDATE public.merch_marking_trade_item_documents AS document
  SET archived_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE document.trade_item_id = profile_record.trade_item_id
    AND document.archived_at IS NULL
    AND document.document_type = ANY (ARRAY[
      'CONFORMITY_CERTIFICATE'::text,
      'CONFORMITY_DECLARATION'::text,
      'STATE_REGISTRATION_CERTIFICATE'::text
    ]);

  INSERT INTO public.merch_marking_trade_item_documents (
    trade_item_id, document_type, document_number, issued_at, valid_until,
    status, verification_source, external_reference, source_snapshot_hash,
    verified_at, verified_by
  ) VALUES (
    profile_record.trade_item_id, p_document_type, btrim(p_document_number),
    p_issued_at, p_valid_until, 'valid', p_verification_source,
    p_external_reference, p_source_snapshot_hash, clock_timestamp(), p_actor_id
  )
  RETURNING id INTO created_document_id;

  UPDATE public.merch_marking_product_profiles AS profile
  SET revision = profile.revision + 1, updated_at = clock_timestamp()
  WHERE profile.trade_item_id = profile_record.trade_item_id
    AND profile.archived_at IS NULL;

  RETURN QUERY
  SELECT created_document_id, profile.revision, profile_record.trade_item_id
  FROM public.merch_marking_product_profiles AS profile
  WHERE profile.id = p_profile_id;
END
$function$;

DROP FUNCTION getomerch_marking.get_introduction_document_material(uuid,text);

CREATE FUNCTION getomerch_marking.get_introduction_document_material(
  p_document_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  document_id uuid, document_status text, api_contract_version text,
  gtin text, offer_id text, tnved_code text, production_date date,
  conformity_documents jsonb, code_fingerprint text,
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
    link.gtin_snapshot, item.offer_id, trade_item.tnved_code,
    binding.applied_at::date,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'type', conformity.document_type,
        'number', conformity.document_number,
        'date', to_char(conformity.issued_at, 'YYYY-MM-DD')
      ) ORDER BY conformity.issued_at, conformity.id)
      FROM public.merch_marking_trade_item_documents AS conformity
      WHERE conformity.trade_item_id = trade_item.id
        AND conformity.archived_at IS NULL
        AND conformity.status = 'valid'
        AND conformity.issued_at IS NOT NULL
        AND conformity.issued_at <= current_date
        AND (conformity.valid_until IS NULL OR conformity.valid_until >= current_date)
        AND conformity.document_type = ANY (ARRAY[
          'CONFORMITY_CERTIFICATE'::text,
          'CONFORMITY_DECLARATION'::text,
          'STATE_REGISTRATION_CERTIFICATE'::text
        ])
    ), '[]'::jsonb),
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
  JOIN public.merch_fulfillment_order_items AS item
    ON item.id = assignment.fulfillment_item_id
  JOIN public.merch_marking_product_profiles AS profile
    ON profile.id = assignment.product_profile_id
  JOIN public.merch_marking_trade_items AS trade_item ON trade_item.id = profile.trade_item_id
  WHERE document.id = p_document_id AND link.link_state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'introduction document material not found' USING ERRCODE = 'MZA27';
  END IF;
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
      AND NOT (
        OLD.status = 'requires_manual_review'
        AND OLD.error_code = 'crpt_submit_outcome_unknown'
        AND NEW.status = 'processing'
      )
      AND NEW.status <> ALL (ARRAY[OLD.status, 'superseded'::text]) THEN
    RAISE EXCEPTION 'invalid marking document transition' USING ERRCODE = 'MZA13';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.reconcile_introduction_submission(
  p_document_id uuid,
  p_external_document_id text,
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
DECLARE
  current_record record;
  next_status text;
BEGIN
  IF p_document_id IS NULL
     OR p_external_document_id !~ '^[A-Za-z0-9._:-]{1,200}$'
     OR p_remote_status IS NULL OR length(p_remote_status) NOT BETWEEN 1 AND 120
     OR jsonb_typeof(p_response_redacted) <> 'object'
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid introduction reconciliation request' USING ERRCODE = 'MZE10';
  END IF;

  SELECT document.status, document.external_document_id, document.error_code
  INTO current_record
  FROM public.merch_marking_documents AS document
  WHERE document.id = p_document_id
    AND document.document_type = 'introduction'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'introduction document not found' USING ERRCODE = 'MZE11';
  END IF;
  IF current_record.external_document_id = p_external_document_id
     AND current_record.status = ANY (ARRAY[
       'processing'::text, 'accepted'::text, 'rejected'::text
     ]) THEN
    RETURN current_record.status;
  END IF;
  IF current_record.status <> 'requires_manual_review'
     OR current_record.error_code <> 'crpt_submit_outcome_unknown'
     OR current_record.external_document_id IS NOT NULL THEN
    RAISE EXCEPTION 'document is not awaiting submission reconciliation'
      USING ERRCODE = 'MZE12';
  END IF;

  UPDATE public.merch_marking_documents AS document
  SET status = 'processing', external_document_id = p_external_document_id,
    submitted_at = coalesce(document.submitted_at, clock_timestamp()),
    response_redacted = p_response_redacted || jsonb_build_object(
      'reconciled', true, 'reconciledBy', p_actor_id
    ),
    error_code = NULL, error_message = NULL,
    checked_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE document.id = p_document_id;

  SELECT getomerch_marking.record_introduction_poll(
    p_document_id, p_remote_status,
    p_response_redacted || jsonb_build_object('reconciled', true),
    p_error_code, p_error_message
  ) INTO next_status;
  RETURN next_status;
END
$function$;

REVOKE ALL ON FUNCTION getomerch_marking.upsert_trade_item_conformity_document(
  uuid,bigint,text,text,date,date,text,text,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_introduction_document_material(
  uuid,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.reconcile_introduction_submission(
  uuid,text,text,jsonb,text,text,text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.upsert_trade_item_conformity_document(
  uuid,bigint,text,text,date,date,text,text,text,text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.get_introduction_document_material(
  uuid,text
) TO getomerch_marking_worker;
GRANT EXECUTE ON FUNCTION getomerch_marking.reconcile_introduction_submission(
  uuid,text,text,jsonb,text,text,text
) TO getomerch_app;

COMMENT ON FUNCTION getomerch_marking.reconcile_introduction_submission(
  uuid,text,text,jsonb,text,text,text
) IS 'Attaches a remotely verified CRPT document to one ambiguous local introduction submission.';
