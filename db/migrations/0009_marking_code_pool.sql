-- Stage 5 secure marking-code pool and encrypted manual import.
--
-- Full marking codes are stored only as AES-256-GCM ciphertext. The web role
-- can read redacted security-barrier views and execute narrow commands, but
-- cannot select or mutate encrypted base tables directly.

CREATE OR REPLACE FUNCTION getomerch_marking.is_valid_hmac_set(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT
    jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) BETWEEN 1 AND 64
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS item
      WHERE jsonb_typeof(item) <> 'object'
        OR (item->>'keyVersion') !~ '^[1-9][0-9]{0,6}$'
        OR (item->>'digest') !~ '^[0-9a-f]{64}$'
    )
    AND (
      SELECT count(*) = count(DISTINCT (item->>'keyVersion')::integer)
      FROM jsonb_array_elements(value) AS item
    )
$function$;

CREATE TABLE public.merch_marking_import_batches (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    source text NOT NULL,
    filename text,
    content_type text,
    file_sha256 text NOT NULL,
    file_size_bytes bigint NOT NULL,
    expected_gtin text NOT NULL,
    trade_item_id uuid NOT NULL
      REFERENCES public.merch_marking_trade_items(id) ON DELETE RESTRICT,
    acquisition_mode text NOT NULL,
    status text DEFAULT 'preview'::text NOT NULL,
    rows_total integer DEFAULT 0 NOT NULL,
    rows_valid integer DEFAULT 0 NOT NULL,
    rows_duplicate integer DEFAULT 0 NOT NULL,
    rows_rejected integer DEFAULT 0 NOT NULL,
    rows_applied integer DEFAULT 0 NOT NULL,
    rows_race_duplicate integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    applied_by text,
    applied_at timestamp with time zone,
    error_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT merch_marking_import_batches_source_check
      CHECK (length(source) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_import_batches_filename_check
      CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 255),
    CONSTRAINT merch_marking_import_batches_content_type_check
      CHECK (content_type IS NULL OR length(content_type) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_import_batches_sha_check
      CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_import_batches_size_check
      CHECK (file_size_bytes BETWEEN 1 AND 2097152),
    CONSTRAINT merch_marking_import_batches_gtin_check
      CHECK (getomerch_marking.is_valid_gtin14(expected_gtin)),
    CONSTRAINT merch_marking_import_batches_acquisition_check
      CHECK (
        acquisition_mode = ANY (
          ARRAY['own_suz_emission'::text, 'remarking'::text]
        )
      ),
    CONSTRAINT merch_marking_import_batches_status_check
      CHECK (
        status = ANY (
          ARRAY['preview'::text, 'applied'::text, 'failed'::text,
                'expired'::text]
        )
      ),
    CONSTRAINT merch_marking_import_batches_counts_check
      CHECK (
        rows_total >= 0
        AND rows_valid >= 0
        AND rows_duplicate >= 0
        AND rows_rejected >= 0
        AND rows_applied >= 0
        AND rows_race_duplicate >= 0
        AND rows_valid + rows_duplicate + rows_rejected = rows_total
        AND rows_applied + rows_race_duplicate <= rows_valid
      ),
    CONSTRAINT merch_marking_import_batches_actor_check
      CHECK (length(created_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_import_batches_expiry_check
      CHECK (expires_at > created_at AND expires_at <= created_at + interval '48 hours'),
    CONSTRAINT merch_marking_import_batches_apply_check
      CHECK (
        (status = 'applied' AND applied_by IS NOT NULL AND applied_at IS NOT NULL)
        OR (status <> 'applied' AND applied_by IS NULL AND applied_at IS NULL)
      ),
    CONSTRAINT merch_marking_import_batches_error_check
      CHECK (
        jsonb_typeof(error_summary) = 'object'
        AND octet_length(error_summary::text) <= 32768
      )
);

CREATE INDEX merch_marking_import_batches_created
  ON public.merch_marking_import_batches (created_at DESC, id DESC);
CREATE INDEX merch_marking_import_batches_pending_expiry
  ON public.merch_marking_import_batches (expires_at, id)
  WHERE status = 'preview';

CREATE TABLE public.merch_marking_codes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    trade_item_id uuid NOT NULL
      REFERENCES public.merch_marking_trade_items(id) ON DELETE RESTRICT,
    gtin_snapshot text NOT NULL,
    code_ciphertext bytea NOT NULL,
    code_nonce bytea NOT NULL,
    code_auth_tag bytea NOT NULL,
    encryption_key_version integer NOT NULL,
    code_hmac bytea NOT NULL,
    hmac_key_version integer NOT NULL,
    fingerprint text NOT NULL,
    serial text,
    acquisition_mode text NOT NULL,
    import_batch_id uuid
      REFERENCES public.merch_marking_import_batches(id) ON DELETE RESTRICT,
    code_order_item_id uuid,
    pool_state text DEFAULT 'available'::text NOT NULL,
    crpt_state text DEFAULT 'emitted'::text NOT NULL,
    crpt_status_raw text,
    crpt_checked_at timestamp with time zone,
    blocked_reason text,
    label_exposed_at timestamp with time zone,
    quarantined_at timestamp with time zone,
    quarantined_by text,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_codes_gtin_check
      CHECK (getomerch_marking.is_valid_gtin14(gtin_snapshot)),
    CONSTRAINT merch_marking_codes_ciphertext_check
      CHECK (octet_length(code_ciphertext) BETWEEN 24 AND 512),
    CONSTRAINT merch_marking_codes_nonce_check
      CHECK (octet_length(code_nonce) = 12),
    CONSTRAINT merch_marking_codes_auth_tag_check
      CHECK (octet_length(code_auth_tag) = 16),
    CONSTRAINT merch_marking_codes_key_version_check
      CHECK (
        encryption_key_version BETWEEN 1 AND 1000000
        AND hmac_key_version BETWEEN 1 AND 1000000
      ),
    CONSTRAINT merch_marking_codes_hmac_check
      CHECK (octet_length(code_hmac) = 32),
    CONSTRAINT merch_marking_codes_fingerprint_check
      CHECK (fingerprint ~ '^[0-9a-f]{12}$'),
    CONSTRAINT merch_marking_codes_serial_check
      CHECK (
        serial IS NULL
        OR (
          length(serial) BETWEEN 1 AND 20
          AND serial ~ '^[!-~]+$'
        )
      ),
    CONSTRAINT merch_marking_codes_acquisition_check
      CHECK (
        acquisition_mode = ANY (
          ARRAY['own_suz_emission'::text, 'supplier_marked_import'::text,
                'remarking'::text]
        )
      ),
    CONSTRAINT merch_marking_codes_stage5_acquisition_check
      CHECK (
        acquisition_mode <> 'supplier_marked_import'
        OR pool_state <> 'available'
      ),
    CONSTRAINT merch_marking_codes_import_source_check
      CHECK (
        acquisition_mode = 'supplier_marked_import'
        OR import_batch_id IS NOT NULL
        OR code_order_item_id IS NOT NULL
      ),
    CONSTRAINT merch_marking_codes_pool_state_check
      CHECK (
        pool_state = ANY (
          ARRAY['available'::text, 'reserved'::text, 'bound'::text,
                'invalid'::text, 'quarantined'::text, 'retired'::text,
                'replaced'::text]
        )
      ),
    CONSTRAINT merch_marking_codes_crpt_state_check
      CHECK (
        crpt_state = ANY (
          ARRAY['unknown'::text, 'emitted'::text, 'applied'::text,
                'introduced'::text, 'in_circulation'::text,
                'withdrawn'::text, 'invalid'::text]
        )
      ),
    CONSTRAINT merch_marking_codes_crpt_status_check
      CHECK (crpt_status_raw IS NULL OR length(crpt_status_raw) <= 300),
    CONSTRAINT merch_marking_codes_blocked_reason_check
      CHECK (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 1000),
    CONSTRAINT merch_marking_codes_quarantine_check
      CHECK (
        (
          pool_state = 'quarantined'
          AND blocked_reason IS NOT NULL
          AND quarantined_at IS NOT NULL
          AND quarantined_by IS NOT NULL
        )
        OR (
          pool_state <> 'quarantined'
          AND quarantined_at IS NULL
          AND quarantined_by IS NULL
        )
      ),
    CONSTRAINT merch_marking_codes_revision_check
      CHECK (revision >= 1),
    CONSTRAINT merch_marking_codes_gtin_trade_item_unique
      UNIQUE (id, trade_item_id),
    CONSTRAINT merch_marking_codes_primary_hmac_unique
      UNIQUE (hmac_key_version, code_hmac)
);

CREATE INDEX merch_marking_codes_pool
  ON public.merch_marking_codes (trade_item_id, pool_state, crpt_state, created_at, id);
CREATE INDEX merch_marking_codes_import
  ON public.merch_marking_codes (import_batch_id, created_at, id)
  WHERE import_batch_id IS NOT NULL;

CREATE TABLE public.merch_marking_code_hmacs (
    marking_code_id uuid NOT NULL
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    hmac_key_version integer NOT NULL,
    code_hmac bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (marking_code_id, hmac_key_version),
    CONSTRAINT merch_marking_code_hmacs_version_check
      CHECK (hmac_key_version BETWEEN 1 AND 1000000),
    CONSTRAINT merch_marking_code_hmacs_digest_check
      CHECK (octet_length(code_hmac) = 32),
    CONSTRAINT merch_marking_code_hmacs_unique
      UNIQUE (hmac_key_version, code_hmac)
);

CREATE INDEX merch_marking_code_hmacs_lookup
  ON public.merch_marking_code_hmacs (hmac_key_version, code_hmac);

CREATE TABLE public.merch_marking_import_rows (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    batch_id uuid NOT NULL
      REFERENCES public.merch_marking_import_batches(id) ON DELETE RESTRICT,
    row_number integer NOT NULL,
    gtin text,
    trade_item_id uuid
      REFERENCES public.merch_marking_trade_items(id) ON DELETE RESTRICT,
    serial text,
    code_ciphertext bytea,
    code_nonce bytea,
    code_auth_tag bytea,
    encryption_key_version integer,
    code_hmac bytea,
    hmac_key_version integer,
    dedup_hmacs jsonb DEFAULT '[]'::jsonb NOT NULL,
    fingerprint text,
    validation_status text NOT NULL,
    error_codes text[] DEFAULT '{}'::text[] NOT NULL,
    applied_code_id uuid
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    scrubbed_at timestamp with time zone,
    UNIQUE (batch_id, row_number),
    CONSTRAINT merch_marking_import_rows_number_check
      CHECK (row_number BETWEEN 1 AND 5000),
    CONSTRAINT merch_marking_import_rows_gtin_check
      CHECK (gtin IS NULL OR getomerch_marking.is_valid_gtin14(gtin)),
    CONSTRAINT merch_marking_import_rows_serial_check
      CHECK (
        serial IS NULL
        OR (
          length(serial) BETWEEN 1 AND 20
          AND serial ~ '^[!-~]+$'
        )
      ),
    CONSTRAINT merch_marking_import_rows_envelope_check
      CHECK (
        (
          code_ciphertext IS NULL
          AND code_nonce IS NULL
          AND code_auth_tag IS NULL
          AND encryption_key_version IS NULL
        )
        OR (
          octet_length(code_ciphertext) BETWEEN 24 AND 512
          AND octet_length(code_nonce) = 12
          AND octet_length(code_auth_tag) = 16
          AND encryption_key_version BETWEEN 1 AND 1000000
        )
      ),
    CONSTRAINT merch_marking_import_rows_hmac_check
      CHECK (
        (
          code_hmac IS NULL
          AND hmac_key_version IS NULL
          AND dedup_hmacs = '[]'::jsonb
        )
        OR (
          octet_length(code_hmac) = 32
          AND hmac_key_version BETWEEN 1 AND 1000000
          AND getomerch_marking.is_valid_hmac_set(dedup_hmacs)
        )
      ),
    CONSTRAINT merch_marking_import_rows_fingerprint_check
      CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{12}$'),
    CONSTRAINT merch_marking_import_rows_status_check
      CHECK (
        validation_status = ANY (
          ARRAY['valid'::text, 'duplicate_file'::text,
                'duplicate_pool'::text, 'gtin_mismatch'::text,
                'rejected'::text, 'applied'::text, 'scrubbed'::text]
        )
      ),
    CONSTRAINT merch_marking_import_rows_valid_check
      CHECK (
        validation_status NOT IN ('valid', 'applied')
        OR (
          gtin IS NOT NULL
          AND trade_item_id IS NOT NULL
          AND (
            validation_status = 'applied'
            OR (
              code_ciphertext IS NOT NULL
              AND code_hmac IS NOT NULL
            )
          )
        )
      ),
    CONSTRAINT merch_marking_import_rows_applied_check
      CHECK (
        (validation_status = 'applied' AND applied_code_id IS NOT NULL)
        OR (validation_status <> 'applied' AND applied_code_id IS NULL)
      ),
    CONSTRAINT merch_marking_import_rows_scrub_check
      CHECK (
        scrubbed_at IS NULL
        OR (
          code_ciphertext IS NULL
          AND code_nonce IS NULL
          AND code_auth_tag IS NULL
          AND encryption_key_version IS NULL
          AND code_hmac IS NULL
          AND hmac_key_version IS NULL
          AND dedup_hmacs = '[]'::jsonb
        )
      ),
    CONSTRAINT merch_marking_import_rows_error_count_check
      CHECK (cardinality(error_codes) <= 20)
);

CREATE INDEX merch_marking_import_rows_batch
  ON public.merch_marking_import_rows (batch_id, row_number);
CREATE INDEX merch_marking_import_rows_pending
  ON public.merch_marking_import_rows (batch_id, validation_status, row_number)
  WHERE validation_status = 'valid';

ALTER TABLE public.merch_marking_events
    DROP CONSTRAINT merch_marking_events_stage3_future_subjects_check,
    DROP CONSTRAINT merch_marking_events_subject_check;

ALTER TABLE public.merch_marking_events
    ADD CONSTRAINT merch_marking_events_marking_code_fk
      FOREIGN KEY (marking_code_id)
      REFERENCES public.merch_marking_codes(id) ON DELETE RESTRICT,
    ADD CONSTRAINT merch_marking_events_stage5_future_subjects_check
      CHECK (
        marking_unit_id IS NULL
        AND code_binding_id IS NULL
        AND assignment_id IS NULL
        AND document_id IS NULL
      ),
    ADD CONSTRAINT merch_marking_events_subject_check
      CHECK (
        process_id IS NOT NULL
        OR product_profile_id IS NOT NULL
        OR marking_code_id IS NOT NULL
      );

CREATE INDEX merch_marking_events_code
  ON public.merch_marking_events (marking_code_id, occurred_at DESC, id DESC)
  WHERE marking_code_id IS NOT NULL;

CREATE OR REPLACE FUNCTION getomerch_marking.create_code_import_preview(
  p_source text,
  p_filename text,
  p_content_type text,
  p_file_sha256 text,
  p_file_size_bytes bigint,
  p_expected_gtin text,
  p_acquisition_mode text,
  p_rows jsonb,
  p_created_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_trade_item public.merch_marking_trade_items%ROWTYPE;
  created_batch_id uuid;
  item jsonb;
  item_status text;
  final_status text;
  item_errors text[];
  item_hmacs jsonb;
  item_hmac record;
  database_duplicate boolean;
  summary jsonb;
BEGIN
  IF p_source IS NULL OR length(p_source) NOT BETWEEN 1 AND 120
     OR p_created_by IS NULL OR length(p_created_by) NOT BETWEEN 1 AND 200
     OR p_file_sha256 !~ '^[0-9a-f]{64}$'
     OR p_file_size_bytes NOT BETWEEN 1 AND 2097152
     OR NOT getomerch_marking.is_valid_gtin14(p_expected_gtin)
     OR p_acquisition_mode NOT IN ('own_suz_emission', 'remarking')
     OR jsonb_typeof(p_rows) <> 'array'
     OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'invalid marking-code import preview'
      USING ERRCODE = 'MZ500';
  END IF;

  SELECT trade_item.*
  INTO target_trade_item
  FROM public.merch_marking_trade_items AS trade_item
  WHERE trade_item.gtin = p_expected_gtin
    AND trade_item.archived_at IS NULL
    AND trade_item.verification_status = 'verified'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'verified trade item not found'
      USING ERRCODE = 'MZ501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_product_profiles AS profile
    WHERE profile.trade_item_id = target_trade_item.id
      AND profile.archived_at IS NULL
      AND profile.requires_marking
      AND profile.verification_status = 'verified'
      AND profile.operational_status = 'enabled'
  ) THEN
    RAISE EXCEPTION 'enabled product profile not found'
      USING ERRCODE = 'MZ502';
  END IF;

  INSERT INTO public.merch_marking_import_batches (
    source,
    filename,
    content_type,
    file_sha256,
    file_size_bytes,
    expected_gtin,
    trade_item_id,
    acquisition_mode,
    created_by,
    expires_at
  )
  VALUES (
    p_source,
    nullif(p_filename, ''),
    nullif(p_content_type, ''),
    p_file_sha256,
    p_file_size_bytes,
    p_expected_gtin,
    target_trade_item.id,
    p_acquisition_mode,
    p_created_by,
    clock_timestamp() + interval '24 hours'
  )
  RETURNING id INTO created_batch_id;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF jsonb_typeof(item) <> 'object'
       OR coalesce(item->>'rowNumber', '') !~ '^[1-9][0-9]{0,3}$'
       OR (item->>'rowNumber')::integer > 5000
       OR coalesce(item->>'status', '') NOT IN (
         'valid', 'duplicate_file', 'gtin_mismatch', 'rejected'
       )
       OR jsonb_typeof(coalesce(item->'errorCodes', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(coalesce(item->'errorCodes', '[]'::jsonb)) > 20 THEN
      RAISE EXCEPTION 'invalid marking-code import row'
        USING ERRCODE = 'MZ503';
    END IF;

    item_status := item->>'status';
    item_hmacs := coalesce(item->'hmacs', '[]'::jsonb);
    item_errors := ARRAY(
      SELECT value
      FROM jsonb_array_elements_text(coalesce(item->'errorCodes', '[]'::jsonb))
    );

    IF item_status = 'valid' AND (
      coalesce(item->>'gtin', '') <> p_expected_gtin
      OR coalesce(item->>'fingerprint', '') !~ '^[0-9a-f]{12}$'
      OR coalesce(item->>'encryptionKeyVersion', '') !~ '^[1-9][0-9]{0,6}$'
      OR coalesce(item->>'hmacKeyVersion', '') !~ '^[1-9][0-9]{0,6}$'
      OR coalesce(item->>'primaryHmac', '') !~ '^[0-9a-f]{64}$'
      OR coalesce(item->>'ciphertext', '') !~ '^[A-Za-z0-9+/]+={0,2}$'
      OR coalesce(item->>'nonce', '') !~ '^[A-Za-z0-9+/]+={0,2}$'
      OR coalesce(item->>'authTag', '') !~ '^[A-Za-z0-9+/]+={0,2}$'
      OR NOT getomerch_marking.is_valid_hmac_set(item_hmacs)
    ) THEN
      RAISE EXCEPTION 'invalid encrypted marking-code import row'
        USING ERRCODE = 'MZ503';
    END IF;

    database_duplicate := false;
    IF item_status = 'valid' THEN
      FOR item_hmac IN
        SELECT
          (hmac_item->>'keyVersion')::integer AS key_version,
          decode(hmac_item->>'digest', 'hex') AS digest
        FROM jsonb_array_elements(item_hmacs) AS hmac_item
      LOOP
        IF EXISTS (
          SELECT 1
          FROM public.merch_marking_code_hmacs AS existing
          WHERE existing.hmac_key_version = item_hmac.key_version
            AND existing.code_hmac = item_hmac.digest
        ) THEN
          database_duplicate := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    final_status := CASE
      WHEN database_duplicate THEN 'duplicate_pool'
      ELSE item_status
    END;
    IF database_duplicate THEN
      item_errors := array_append(item_errors, 'duplicate_pool');
    END IF;

    INSERT INTO public.merch_marking_import_rows (
      batch_id,
      row_number,
      gtin,
      trade_item_id,
      serial,
      code_ciphertext,
      code_nonce,
      code_auth_tag,
      encryption_key_version,
      code_hmac,
      hmac_key_version,
      dedup_hmacs,
      fingerprint,
      validation_status,
      error_codes
    )
    VALUES (
      created_batch_id,
      (item->>'rowNumber')::integer,
      nullif(item->>'gtin', ''),
      CASE WHEN final_status = 'valid' THEN target_trade_item.id ELSE NULL END,
      nullif(item->>'serial', ''),
      CASE WHEN final_status = 'valid' THEN decode(item->>'ciphertext', 'base64') END,
      CASE WHEN final_status = 'valid' THEN decode(item->>'nonce', 'base64') END,
      CASE WHEN final_status = 'valid' THEN decode(item->>'authTag', 'base64') END,
      CASE
        WHEN final_status = 'valid' THEN (item->>'encryptionKeyVersion')::integer
      END,
      CASE WHEN final_status = 'valid' THEN decode(item->>'primaryHmac', 'hex') END,
      CASE WHEN final_status = 'valid' THEN (item->>'hmacKeyVersion')::integer END,
      CASE WHEN final_status = 'valid' THEN item_hmacs ELSE '[]'::jsonb END,
      nullif(item->>'fingerprint', ''),
      final_status,
      item_errors
    );
  END LOOP;

  SELECT jsonb_build_object(
    'total', count(*),
    'valid', count(*) FILTER (WHERE validation_status = 'valid'),
    'duplicate', count(*) FILTER (
      WHERE validation_status IN ('duplicate_file', 'duplicate_pool')
    ),
    'rejected', count(*) FILTER (
      WHERE validation_status NOT IN ('valid', 'duplicate_file', 'duplicate_pool')
    )
  )
  INTO summary
  FROM public.merch_marking_import_rows
  WHERE batch_id = created_batch_id;

  UPDATE public.merch_marking_import_batches
  SET
    rows_total = (summary->>'total')::integer,
    rows_valid = (summary->>'valid')::integer,
    rows_duplicate = (summary->>'duplicate')::integer,
    rows_rejected = (summary->>'rejected')::integer,
    error_summary = summary
  WHERE id = created_batch_id;

  RETURN created_batch_id;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.apply_code_import(
  p_batch_id uuid,
  p_actor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_batch public.merch_marking_import_batches%ROWTYPE;
  target_row public.merch_marking_import_rows%ROWTYPE;
  hmac_item record;
  created_code_id uuid;
  alias_inserted uuid;
  alias_number integer;
  duplicate_race boolean;
  applied_count integer := 0;
  race_duplicate_count integer := 0;
  result_summary jsonb;
BEGIN
  IF p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid marking import actor'
      USING ERRCODE = 'MZ504';
  END IF;

  SELECT batch.*
  INTO target_batch
  FROM public.merch_marking_import_batches AS batch
  WHERE batch.id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking import batch not found'
      USING ERRCODE = 'MZ505';
  END IF;
  IF target_batch.status = 'applied' THEN
    RETURN target_batch.error_summary;
  END IF;
  IF target_batch.status <> 'preview' THEN
    RAISE EXCEPTION 'marking import batch cannot be applied'
      USING ERRCODE = 'MZ506';
  END IF;
  IF target_batch.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'marking import batch expired'
      USING ERRCODE = 'MZ507';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_trade_items AS trade_item
    WHERE trade_item.id = target_batch.trade_item_id
      AND trade_item.gtin = target_batch.expected_gtin
      AND trade_item.archived_at IS NULL
      AND trade_item.verification_status = 'verified'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.merch_marking_product_profiles AS profile
    WHERE profile.trade_item_id = target_batch.trade_item_id
      AND profile.archived_at IS NULL
      AND profile.requires_marking
      AND profile.verification_status = 'verified'
      AND profile.operational_status = 'enabled'
  ) THEN
    RAISE EXCEPTION 'marking product is no longer ready'
      USING ERRCODE = 'MZ508';
  END IF;

  <<row_loop>>
  FOR target_row IN
    SELECT row_data.*
    FROM public.merch_marking_import_rows AS row_data
    WHERE row_data.batch_id = p_batch_id
      AND row_data.validation_status = 'valid'
    ORDER BY row_data.row_number
    FOR UPDATE
  LOOP
    created_code_id := gen_random_uuid();
    INSERT INTO public.merch_marking_codes (
      id,
      trade_item_id,
      gtin_snapshot,
      code_ciphertext,
      code_nonce,
      code_auth_tag,
      encryption_key_version,
      code_hmac,
      hmac_key_version,
      fingerprint,
      serial,
      acquisition_mode,
      import_batch_id,
      pool_state,
      crpt_state
    )
    VALUES (
      created_code_id,
      target_batch.trade_item_id,
      target_batch.expected_gtin,
      target_row.code_ciphertext,
      target_row.code_nonce,
      target_row.code_auth_tag,
      target_row.encryption_key_version,
      target_row.code_hmac,
      target_row.hmac_key_version,
      target_row.fingerprint,
      target_row.serial,
      target_batch.acquisition_mode,
      target_batch.id,
      'available',
      'emitted'
    )
    ON CONFLICT (hmac_key_version, code_hmac) DO NOTHING
    RETURNING id INTO alias_inserted;

    IF alias_inserted IS NULL THEN
      UPDATE public.merch_marking_import_rows
      SET
        validation_status = 'duplicate_pool',
        error_codes = array_append(error_codes, 'duplicate_pool_race'),
        code_ciphertext = NULL,
        code_nonce = NULL,
        code_auth_tag = NULL,
        encryption_key_version = NULL,
        code_hmac = NULL,
        hmac_key_version = NULL,
        dedup_hmacs = '[]'::jsonb,
        scrubbed_at = clock_timestamp()
      WHERE id = target_row.id;
      race_duplicate_count := race_duplicate_count + 1;
      CONTINUE row_loop;
    END IF;

    alias_number := 0;
    duplicate_race := false;
    FOR hmac_item IN
      SELECT
        (item->>'keyVersion')::integer AS key_version,
        decode(item->>'digest', 'hex') AS digest
      FROM jsonb_array_elements(target_row.dedup_hmacs) AS item
      ORDER BY (item->>'keyVersion')::integer
    LOOP
      alias_number := alias_number + 1;
      alias_inserted := NULL;
      INSERT INTO public.merch_marking_code_hmacs (
        marking_code_id,
        hmac_key_version,
        code_hmac
      )
      VALUES (created_code_id, hmac_item.key_version, hmac_item.digest)
      ON CONFLICT (hmac_key_version, code_hmac) DO NOTHING
      RETURNING marking_code_id INTO alias_inserted;

      IF alias_inserted IS NULL THEN
        IF alias_number = 1 THEN
          duplicate_race := true;
          EXIT;
        END IF;
        RAISE EXCEPTION 'inconsistent HMAC key coverage'
          USING ERRCODE = 'MZ509';
      END IF;
    END LOOP;

    IF duplicate_race THEN
      DELETE FROM public.merch_marking_codes
      WHERE id = created_code_id;
      UPDATE public.merch_marking_import_rows
      SET
        validation_status = 'duplicate_pool',
        error_codes = array_append(error_codes, 'duplicate_pool_race'),
        code_ciphertext = NULL,
        code_nonce = NULL,
        code_auth_tag = NULL,
        encryption_key_version = NULL,
        code_hmac = NULL,
        hmac_key_version = NULL,
        dedup_hmacs = '[]'::jsonb,
        scrubbed_at = clock_timestamp()
      WHERE id = target_row.id;
      race_duplicate_count := race_duplicate_count + 1;
      CONTINUE row_loop;
    END IF;

    UPDATE public.merch_marking_import_rows
    SET
      validation_status = 'applied',
      applied_code_id = created_code_id,
      code_ciphertext = NULL,
      code_nonce = NULL,
      code_auth_tag = NULL,
      encryption_key_version = NULL,
      code_hmac = NULL,
      hmac_key_version = NULL,
      dedup_hmacs = '[]'::jsonb,
      scrubbed_at = clock_timestamp()
    WHERE id = target_row.id;

    INSERT INTO public.merch_marking_events (
      marking_code_id,
      event_type,
      actor_type,
      actor_id,
      source,
      details_redacted,
      occurred_at
    )
    VALUES (
      created_code_id,
      'marking_code_imported',
      'admin',
      p_actor_id,
      target_batch.source,
      jsonb_build_object(
        'batchId', target_batch.id,
        'gtin', target_batch.expected_gtin,
        'fingerprint', target_row.fingerprint,
        'acquisitionMode', target_batch.acquisition_mode
      ),
      clock_timestamp()
    );
    applied_count := applied_count + 1;
  END LOOP;

  SELECT jsonb_build_object(
    'total', count(*),
    'applied', count(*) FILTER (WHERE validation_status = 'applied'),
    'duplicate', count(*) FILTER (
      WHERE validation_status IN ('duplicate_file', 'duplicate_pool')
    ),
    'rejected', count(*) FILTER (
      WHERE validation_status NOT IN (
        'valid', 'applied', 'duplicate_file', 'duplicate_pool'
      )
    ),
    'raceDuplicate', race_duplicate_count
  )
  INTO result_summary
  FROM public.merch_marking_import_rows
  WHERE batch_id = p_batch_id;

  UPDATE public.merch_marking_import_batches
  SET
    status = 'applied',
    rows_applied = applied_count,
    rows_race_duplicate = race_duplicate_count,
    applied_by = p_actor_id,
    applied_at = clock_timestamp(),
    error_summary = result_summary
  WHERE id = p_batch_id;

  RETURN result_summary;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.quarantine_code(
  p_code_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_actor_id text
)
RETURNS TABLE (
  code_id uuid,
  pool_state text,
  revision bigint,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_code public.merch_marking_codes%ROWTYPE;
  changed_code public.merch_marking_codes%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 1000
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid quarantine request'
      USING ERRCODE = 'MZ510';
  END IF;
  SELECT code.*
  INTO current_code
  FROM public.merch_marking_codes AS code
  WHERE code.id = p_code_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking code not found'
      USING ERRCODE = 'MZ511';
  END IF;
  IF current_code.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking code revision conflict'
      USING ERRCODE = 'MZ512';
  END IF;
  IF current_code.pool_state <> 'available' THEN
    RAISE EXCEPTION 'marking code cannot be quarantined'
      USING ERRCODE = 'MZ513';
  END IF;

  UPDATE public.merch_marking_codes AS code
  SET
    pool_state = 'quarantined',
    blocked_reason = p_reason,
    quarantined_at = clock_timestamp(),
    quarantined_by = p_actor_id,
    revision = code.revision + 1,
    updated_at = clock_timestamp()
  WHERE code.id = p_code_id
    AND code.revision = p_expected_revision
  RETURNING code.* INTO changed_code;

  INSERT INTO public.merch_marking_events (
    marking_code_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    changed_code.id,
    'marking_code_quarantined',
    'admin',
    p_actor_id,
    'admin',
    jsonb_build_object(
      'fromState', current_code.pool_state,
      'toState', changed_code.pool_state,
      'reason', p_reason,
      'fingerprint', changed_code.fingerprint,
      'revision', changed_code.revision
    ),
    changed_code.updated_at
  );

  RETURN QUERY SELECT
    changed_code.id,
    changed_code.pool_state,
    changed_code.revision,
    changed_code.updated_at;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.release_quarantined_code(
  p_code_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_destroyed_printed_copies boolean,
  p_actor_id text
)
RETURNS TABLE (
  code_id uuid,
  pool_state text,
  revision bigint,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  current_code public.merch_marking_codes%ROWTYPE;
  changed_code public.merch_marking_codes%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 1000
     OR NOT coalesce(p_destroyed_printed_copies, false)
     OR p_actor_id IS NULL OR length(p_actor_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid quarantine release request'
      USING ERRCODE = 'MZ514';
  END IF;
  SELECT code.*
  INTO current_code
  FROM public.merch_marking_codes AS code
  WHERE code.id = p_code_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'marking code not found'
      USING ERRCODE = 'MZ511';
  END IF;
  IF current_code.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marking code revision conflict'
      USING ERRCODE = 'MZ512';
  END IF;
  IF current_code.pool_state <> 'quarantined' THEN
    RAISE EXCEPTION 'marking code is not quarantined'
      USING ERRCODE = 'MZ515';
  END IF;

  UPDATE public.merch_marking_codes AS code
  SET
    pool_state = 'available',
    blocked_reason = NULL,
    quarantined_at = NULL,
    quarantined_by = NULL,
    revision = code.revision + 1,
    updated_at = clock_timestamp()
  WHERE code.id = p_code_id
    AND code.revision = p_expected_revision
  RETURNING code.* INTO changed_code;

  INSERT INTO public.merch_marking_events (
    marking_code_id,
    event_type,
    actor_type,
    actor_id,
    source,
    details_redacted,
    occurred_at
  )
  VALUES (
    changed_code.id,
    'marking_code_released',
    'admin',
    p_actor_id,
    'admin',
    jsonb_build_object(
      'fromState', current_code.pool_state,
      'toState', changed_code.pool_state,
      'reason', p_reason,
      'destroyedPrintedCopies', true,
      'fingerprint', changed_code.fingerprint,
      'revision', changed_code.revision
    ),
    changed_code.updated_at
  );

  RETURN QUERY SELECT
    changed_code.id,
    changed_code.pool_state,
    changed_code.revision,
    changed_code.updated_at;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.scrub_expired_code_imports(
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  batch_record record;
  scrubbed_batches integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid import scrub limit'
      USING ERRCODE = 'MZ516';
  END IF;

  FOR batch_record IN
    SELECT batch.id
    FROM public.merch_marking_import_batches AS batch
    WHERE batch.status = 'preview'
      AND batch.expires_at <= clock_timestamp()
    ORDER BY batch.expires_at, batch.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.merch_marking_import_rows
    SET
      validation_status = CASE
        WHEN validation_status = 'valid' THEN 'scrubbed'
        ELSE validation_status
      END,
      error_codes = CASE
        WHEN validation_status = 'valid'
          THEN array_append(error_codes, 'preview_expired')
        ELSE error_codes
      END,
      code_ciphertext = NULL,
      code_nonce = NULL,
      code_auth_tag = NULL,
      encryption_key_version = NULL,
      code_hmac = NULL,
      hmac_key_version = NULL,
      dedup_hmacs = '[]'::jsonb,
      scrubbed_at = coalesce(scrubbed_at, clock_timestamp())
    WHERE batch_id = batch_record.id;

    UPDATE public.merch_marking_import_batches
    SET
      status = 'expired',
      error_summary = error_summary
        || jsonb_build_object('expired', true, 'scrubbedAt', clock_timestamp())
    WHERE id = batch_record.id;
    scrubbed_batches := scrubbed_batches + 1;
  END LOOP;

  RETURN scrubbed_batches;
END
$function$;

CREATE VIEW getomerch_marking.code_pool_safe
WITH (security_barrier = true)
AS
SELECT
  code.id,
  code.trade_item_id,
  code.gtin_snapshot,
  code.fingerprint,
  code.acquisition_mode,
  code.import_batch_id,
  code.pool_state,
  code.crpt_state,
  code.crpt_status_raw,
  code.crpt_checked_at,
  code.blocked_reason,
  code.label_exposed_at,
  code.quarantined_at,
  code.revision,
  code.created_at,
  code.updated_at
FROM public.merch_marking_codes AS code;

CREATE VIEW getomerch_marking.import_batches_safe
WITH (security_barrier = true)
AS
SELECT
  batch.id,
  batch.source,
  batch.filename,
  batch.content_type,
  batch.file_sha256,
  batch.file_size_bytes,
  batch.expected_gtin,
  batch.trade_item_id,
  batch.acquisition_mode,
  batch.status,
  batch.rows_total,
  batch.rows_valid,
  batch.rows_duplicate,
  batch.rows_rejected,
  batch.rows_applied,
  batch.rows_race_duplicate,
  batch.created_by,
  batch.created_at,
  batch.expires_at,
  batch.applied_by,
  batch.applied_at,
  batch.error_summary
FROM public.merch_marking_import_batches AS batch;

CREATE VIEW getomerch_marking.import_rows_safe
WITH (security_barrier = true)
AS
SELECT
  row_data.id,
  row_data.batch_id,
  row_data.row_number,
  row_data.gtin,
  row_data.fingerprint,
  row_data.validation_status,
  row_data.error_codes,
  row_data.applied_code_id,
  row_data.created_at,
  row_data.scrubbed_at
FROM public.merch_marking_import_rows AS row_data;

REVOKE ALL ON
  public.merch_marking_import_batches,
  public.merch_marking_import_rows,
  public.merch_marking_codes,
  public.merch_marking_code_hmacs
FROM getomerch_app;

GRANT SELECT ON
  public.merch_marking_import_batches,
  public.merch_marking_import_rows,
  public.merch_marking_codes,
  public.merch_marking_code_hmacs
TO getomerch_backup;

REVOKE ALL ON
  getomerch_marking.code_pool_safe,
  getomerch_marking.import_batches_safe,
  getomerch_marking.import_rows_safe
FROM PUBLIC;

GRANT SELECT ON
  getomerch_marking.code_pool_safe,
  getomerch_marking.import_batches_safe,
  getomerch_marking.import_rows_safe
TO getomerch_app, getomerch_backup;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA getomerch_marking FROM PUBLIC;
GRANT EXECUTE ON FUNCTION getomerch_marking.is_valid_hmac_set(jsonb)
TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.create_code_import_preview(
  text, text, text, text, bigint, text, text, jsonb, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.apply_code_import(uuid, text)
TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.quarantine_code(
  uuid, bigint, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.release_quarantined_code(
  uuid, bigint, text, boolean, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.scrub_expired_code_imports(integer)
TO getomerch_app;

COMMENT ON TABLE public.merch_marking_codes IS
  'Encrypted marking-code pool. Full codes never appear in ordinary read APIs.';
COMMENT ON TABLE public.merch_marking_code_hmacs IS
  'All active HMAC-version aliases used for duplicate detection across rotations.';
COMMENT ON TABLE public.merch_marking_import_rows IS
  'Encrypted staging scrubbed immediately after apply or after preview expiry.';
COMMENT ON VIEW getomerch_marking.code_pool_safe IS
  'Redacted pool projection without ciphertext, nonce, auth tag, HMAC or serial.';
