-- Stage 9 extension: outbound-only macOS signing agent broker. Payloads and
-- signatures are encrypted by the application before they reach PostgreSQL.

CREATE TABLE public.merch_marking_signing_agents (
    agent_id text PRIMARY KEY,
    display_name text NOT NULL,
    state text DEFAULT 'offline'::text NOT NULL,
    reader_detected boolean DEFAULT false NOT NULL,
    signer_reachable boolean DEFAULT false NOT NULL,
    pin_state text DEFAULT 'unknown'::text NOT NULL,
    certificate_thumbprint text,
    certificate_valid_to timestamp with time zone,
    software_version text NOT NULL,
    last_error_code text,
    last_error_message text,
    last_request_id uuid,
    last_seen_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_signing_agents_id_check
      CHECK (agent_id ~ '^[A-Za-z0-9._-]{1,80}$'),
    CONSTRAINT merch_marking_signing_agents_name_check
      CHECK (length(display_name) BETWEEN 1 AND 120),
    CONSTRAINT merch_marking_signing_agents_state_check
      CHECK (state = ANY (ARRAY[
        'ready'::text, 'degraded'::text, 'token_missing'::text,
        'signer_unavailable'::text, 'pin_required'::text, 'offline'::text
      ])),
    CONSTRAINT merch_marking_signing_agents_pin_check
      CHECK (pin_state = ANY (ARRAY[
        'unknown'::text, 'ready'::text, 'required'::text, 'blocked'::text
      ])),
    CONSTRAINT merch_marking_signing_agents_certificate_check
      CHECK (
        (certificate_thumbprint IS NULL AND certificate_valid_to IS NULL)
        OR (
          certificate_thumbprint ~ '^[0-9A-F]{40,128}$'
          AND certificate_valid_to IS NOT NULL
        )
      ),
    CONSTRAINT merch_marking_signing_agents_version_check
      CHECK (software_version ~ '^[A-Za-z0-9._+-]{1,40}$'),
    CONSTRAINT merch_marking_signing_agents_error_check
      CHECK (
        (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_:-]{2,120}$')
        AND (last_error_message IS NULL OR length(last_error_message) BETWEEN 1 AND 500)
      )
);

CREATE TABLE public.merch_marking_agent_nonces (
    agent_id text NOT NULL
      REFERENCES public.merch_marking_signing_agents(agent_id) ON DELETE CASCADE,
    nonce text NOT NULL,
    request_id uuid NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (agent_id, nonce),
    CONSTRAINT merch_marking_agent_nonces_value_check
      CHECK (nonce ~ '^[0-9a-f]{32}$')
);

CREATE TABLE public.merch_marking_signature_requests (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    purpose text NOT NULL,
    payload_sha256 text NOT NULL,
    payload_ciphertext bytea NOT NULL,
    payload_nonce bytea NOT NULL,
    payload_auth_tag bytea NOT NULL,
    encryption_key_version integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by text NOT NULL,
    request_id uuid NOT NULL,
    lease_agent_id text
      REFERENCES public.merch_marking_signing_agents(agent_id) ON DELETE RESTRICT,
    leased_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    signature_ciphertext bytea,
    signature_nonce bytea,
    signature_auth_tag bytea,
    signature_key_version integer,
    certificate_thumbprint text,
    certificate_subject text,
    certificate_inn text,
    certificate_ogrn text,
    certificate_valid_from timestamp with time zone,
    certificate_valid_to timestamp with time zone,
    certificate_algorithm text,
    error_code text,
    error_message text,
    expires_at timestamp with time zone NOT NULL,
    signed_at timestamp with time zone,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_marking_signature_requests_purpose_check
      CHECK (purpose = 'crpt_auth_attached_cades_bes'),
    CONSTRAINT merch_marking_signature_requests_digest_check
      CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_marking_signature_requests_payload_check
      CHECK (
        octet_length(payload_ciphertext) BETWEEN 1 AND 262144
        AND octet_length(payload_nonce) = 12
        AND octet_length(payload_auth_tag) = 16
        AND encryption_key_version BETWEEN 1 AND 1000000
      ),
    CONSTRAINT merch_marking_signature_requests_status_check
      CHECK (status = ANY (ARRAY[
        'pending'::text, 'leased'::text, 'signed'::text,
        'consumed'::text, 'failed'::text, 'expired'::text,
        'cancelled'::text
      ])),
    CONSTRAINT merch_marking_signature_requests_actor_check
      CHECK (length(requested_by) BETWEEN 1 AND 200),
    CONSTRAINT merch_marking_signature_requests_lease_check
      CHECK (
        (status = 'leased' AND lease_agent_id IS NOT NULL
          AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL
          AND lease_expires_at > leased_at)
        OR
        (status <> 'leased' AND lease_expires_at IS NULL)
      ),
    CONSTRAINT merch_marking_signature_requests_attempt_check
      CHECK (attempt_count BETWEEN 0 AND 20),
    CONSTRAINT merch_marking_signature_requests_result_check
      CHECK (
        (
          status = ANY (ARRAY['signed'::text, 'consumed'::text])
          AND signature_ciphertext IS NOT NULL
          AND octet_length(signature_ciphertext) BETWEEN 64 AND 262144
          AND octet_length(signature_nonce) = 12
          AND octet_length(signature_auth_tag) = 16
          AND signature_key_version BETWEEN 1 AND 1000000
          AND certificate_thumbprint ~ '^[0-9A-F]{40,128}$'
          AND length(certificate_subject) BETWEEN 1 AND 500
          AND certificate_inn ~ '^\d{10}(\d{2})?$'
          AND (certificate_ogrn IS NULL OR certificate_ogrn ~ '^\d{13}(\d{2})?$')
          AND certificate_valid_from IS NOT NULL
          AND certificate_valid_to IS NOT NULL
          AND certificate_valid_to > certificate_valid_from
          AND length(certificate_algorithm) BETWEEN 1 AND 200
          AND signed_at IS NOT NULL
          AND error_code IS NULL AND error_message IS NULL
        )
        OR
        (
          status <> ALL (ARRAY['signed'::text, 'consumed'::text])
          AND signature_ciphertext IS NULL AND signature_nonce IS NULL
          AND signature_auth_tag IS NULL AND signature_key_version IS NULL
          AND certificate_thumbprint IS NULL AND certificate_subject IS NULL
          AND certificate_inn IS NULL AND certificate_ogrn IS NULL
          AND certificate_valid_from IS NULL AND certificate_valid_to IS NULL
          AND certificate_algorithm IS NULL
          AND signed_at IS NULL
        )
      ),
    CONSTRAINT merch_marking_signature_requests_error_check
      CHECK (
        (status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL)
        OR
        (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)
      ),
    CONSTRAINT merch_marking_signature_requests_error_value_check
      CHECK (
        (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_:-]{2,120}$')
        AND (error_message IS NULL OR length(error_message) BETWEEN 1 AND 500)
      ),
    CONSTRAINT merch_marking_signature_requests_expiry_check
      CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
    CONSTRAINT merch_marking_signature_requests_consumed_check
      CHECK (
        (status = 'consumed' AND consumed_at IS NOT NULL)
        OR (status <> 'consumed' AND consumed_at IS NULL)
      )
);

CREATE INDEX merch_marking_signing_agents_seen
  ON public.merch_marking_signing_agents (last_seen_at DESC, agent_id);
CREATE INDEX merch_marking_agent_nonces_expiry
  ON public.merch_marking_agent_nonces (created_at, agent_id);
CREATE INDEX merch_marking_signature_requests_queue
  ON public.merch_marking_signature_requests (created_at, id)
  WHERE status = 'pending';
CREATE INDEX merch_marking_signature_requests_lease
  ON public.merch_marking_signature_requests (lease_expires_at, id)
  WHERE status = 'leased';
CREATE INDEX merch_marking_signature_requests_history
  ON public.merch_marking_signature_requests (created_at DESC, id DESC);
CREATE UNIQUE INDEX merch_marking_signature_requests_active_digest
  ON public.merch_marking_signature_requests (purpose, payload_sha256, requested_by)
  WHERE status = ANY (ARRAY['pending'::text, 'leased'::text, 'signed'::text]);

CREATE OR REPLACE FUNCTION getomerch_marking.create_remote_signature_request(
  p_purpose text,
  p_payload_sha256 text,
  p_payload_ciphertext bytea,
  p_payload_nonce bytea,
  p_payload_auth_tag bytea,
  p_encryption_key_version integer,
  p_requested_by text,
  p_request_id uuid,
  p_expires_at timestamp with time zone
)
RETURNS TABLE (signature_request_id uuid, request_status text, reused boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  existing_request public.merch_marking_signature_requests%ROWTYPE;
  created_id uuid;
BEGIN
  IF p_purpose <> 'crpt_auth_attached_cades_bes'
     OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR octet_length(p_payload_ciphertext) NOT BETWEEN 1 AND 262144
     OR octet_length(p_payload_nonce) <> 12
     OR octet_length(p_payload_auth_tag) <> 16
     OR p_encryption_key_version NOT BETWEEN 1 AND 1000000
     OR p_requested_by IS NULL OR length(p_requested_by) NOT BETWEEN 1 AND 200
     OR p_request_id IS NULL
     OR p_expires_at <= clock_timestamp()
     OR p_expires_at > clock_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid remote signature request' USING ERRCODE = 'MZ950';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'remote-signature:' || p_purpose || ':' || p_payload_sha256 || ':' || p_requested_by,
    0
  ));
  UPDATE public.merch_marking_signature_requests AS request
  SET status = 'expired', lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE request.purpose = p_purpose
    AND request.payload_sha256 = p_payload_sha256
    AND request.requested_by = p_requested_by
    AND request.status = ANY (ARRAY['pending'::text, 'leased'::text])
    AND request.expires_at <= clock_timestamp();

  SELECT request.* INTO existing_request
  FROM public.merch_marking_signature_requests AS request
  WHERE request.purpose = p_purpose
    AND request.payload_sha256 = p_payload_sha256
    AND request.requested_by = p_requested_by
    AND request.status = ANY (ARRAY['pending'::text, 'leased'::text, 'signed'::text])
  ORDER BY request.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT existing_request.id, existing_request.status, true;
    RETURN;
  END IF;

  INSERT INTO public.merch_marking_signature_requests (
    purpose, payload_sha256, payload_ciphertext, payload_nonce, payload_auth_tag,
    encryption_key_version, requested_by, request_id, expires_at
  ) VALUES (
    p_purpose, p_payload_sha256, p_payload_ciphertext, p_payload_nonce,
    p_payload_auth_tag, p_encryption_key_version, p_requested_by, p_request_id,
    p_expires_at
  ) RETURNING id INTO created_id;
  RETURN QUERY SELECT created_id, 'pending'::text, false;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.get_remote_signature_result(
  p_signature_request_id uuid,
  p_requested_by text
)
RETURNS TABLE (
  request_status text,
  signature_ciphertext bytea,
  signature_nonce bytea,
  signature_auth_tag bytea,
  signature_key_version integer,
  certificate_thumbprint text,
  certificate_subject text,
  certificate_inn text,
  certificate_ogrn text,
  certificate_valid_from timestamp with time zone,
  certificate_valid_to timestamp with time zone,
  certificate_algorithm text,
  error_code text,
  error_message text,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_signature_request_id IS NULL OR p_requested_by IS NULL
     OR length(p_requested_by) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid remote signature result request' USING ERRCODE = 'MZ951';
  END IF;
  UPDATE public.merch_marking_signature_requests AS request
  SET status = 'expired', lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE request.id = p_signature_request_id
    AND request.requested_by = p_requested_by
    AND request.status = ANY (ARRAY['pending'::text, 'leased'::text])
    AND request.expires_at <= clock_timestamp();
  RETURN QUERY
  SELECT request.status, request.signature_ciphertext, request.signature_nonce,
    request.signature_auth_tag, request.signature_key_version,
    request.certificate_thumbprint, request.certificate_subject,
    request.certificate_inn, request.certificate_ogrn,
    request.certificate_valid_from, request.certificate_valid_to,
    request.certificate_algorithm,
    request.error_code, request.error_message, request.expires_at
  FROM public.merch_marking_signature_requests AS request
  WHERE request.id = p_signature_request_id
    AND request.requested_by = p_requested_by;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remote signature request not found' USING ERRCODE = 'MZ952';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.consume_remote_signature_request(
  p_signature_request_id uuid,
  p_requested_by text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE public.merch_marking_signature_requests AS request
  SET status = 'consumed', consumed_at = coalesce(request.consumed_at, clock_timestamp()),
      lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE request.id = p_signature_request_id
    AND request.requested_by = p_requested_by
    AND request.status = ANY (ARRAY['signed'::text, 'consumed'::text]);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remote signature is not consumable' USING ERRCODE = 'MZ953';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.accept_signing_agent_envelope(
  p_agent_id text,
  p_nonce text,
  p_request_id uuid,
  p_issued_at timestamp with time zone,
  p_display_name text,
  p_state text,
  p_reader_detected boolean,
  p_signer_reachable boolean,
  p_pin_state text,
  p_certificate_thumbprint text,
  p_certificate_valid_to timestamp with time zone,
  p_software_version text,
  p_error_code text,
  p_error_message text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_agent_id !~ '^[A-Za-z0-9._-]{1,80}$'
     OR p_nonce !~ '^[0-9a-f]{32}$'
     OR p_request_id IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - p_issued_at))) > 90
     OR p_display_name IS NULL OR length(p_display_name) NOT BETWEEN 1 AND 120
     OR p_state <> ALL (ARRAY[
       'ready'::text, 'degraded'::text, 'token_missing'::text,
       'signer_unavailable'::text, 'pin_required'::text, 'offline'::text
     ])
     OR p_pin_state <> ALL (ARRAY[
       'unknown'::text, 'ready'::text, 'required'::text, 'blocked'::text
     ])
     OR p_software_version !~ '^[A-Za-z0-9._+-]{1,40}$'
     OR (p_certificate_thumbprint IS NULL) <> (p_certificate_valid_to IS NULL)
     OR (p_certificate_thumbprint IS NOT NULL
       AND p_certificate_thumbprint !~ '^[0-9A-F]{40,128}$')
     OR (p_error_code IS NOT NULL
       AND p_error_code !~ '^[A-Za-z0-9_:-]{2,120}$')
     OR (p_error_message IS NOT NULL
       AND length(p_error_message) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'invalid signing agent envelope' USING ERRCODE = 'MZ954';
  END IF;

  INSERT INTO public.merch_marking_signing_agents (
    agent_id, display_name, state, reader_detected, signer_reachable,
    pin_state, certificate_thumbprint, certificate_valid_to,
    software_version, last_error_code, last_error_message, last_request_id,
    last_seen_at
  ) VALUES (
    p_agent_id, p_display_name, p_state, p_reader_detected, p_signer_reachable,
    p_pin_state, p_certificate_thumbprint, p_certificate_valid_to,
    p_software_version, p_error_code, p_error_message, p_request_id,
    clock_timestamp()
  )
  ON CONFLICT (agent_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    state = EXCLUDED.state,
    reader_detected = EXCLUDED.reader_detected,
    signer_reachable = EXCLUDED.signer_reachable,
    pin_state = EXCLUDED.pin_state,
    certificate_thumbprint = EXCLUDED.certificate_thumbprint,
    certificate_valid_to = EXCLUDED.certificate_valid_to,
    software_version = EXCLUDED.software_version,
    last_error_code = EXCLUDED.last_error_code,
    last_error_message = EXCLUDED.last_error_message,
    last_request_id = EXCLUDED.last_request_id,
    last_seen_at = clock_timestamp(),
    updated_at = clock_timestamp();

  DELETE FROM public.merch_marking_agent_nonces AS nonce
  WHERE nonce.agent_id = p_agent_id
    AND nonce.created_at < clock_timestamp() - interval '10 minutes';
  INSERT INTO public.merch_marking_agent_nonces (
    agent_id, nonce, request_id, issued_at
  ) VALUES (p_agent_id, p_nonce, p_request_id, p_issued_at);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'signing agent request replayed' USING ERRCODE = 'MZ955';
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.claim_remote_signature_request(
  p_agent_id text,
  p_lease_seconds integer DEFAULT 30
)
RETURNS TABLE (
  signature_request_id uuid,
  purpose text,
  payload_sha256 text,
  payload_ciphertext bytea,
  payload_nonce bytea,
  payload_auth_tag bytea,
  encryption_key_version integer,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_id uuid;
BEGIN
  IF p_agent_id !~ '^[A-Za-z0-9._-]{1,80}$'
     OR p_lease_seconds NOT BETWEEN 10 AND 120 THEN
    RAISE EXCEPTION 'invalid signing request claim' USING ERRCODE = 'MZ956';
  END IF;
  PERFORM 1 FROM public.merch_marking_signing_agents AS agent
  WHERE agent.agent_id = p_agent_id
    AND agent.last_seen_at > clock_timestamp() - interval '2 minutes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signing agent is not active' USING ERRCODE = 'MZ957';
  END IF;

  UPDATE public.merch_marking_signature_requests AS request
  SET status = CASE WHEN request.expires_at <= clock_timestamp()
        THEN 'expired' ELSE 'pending' END,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE request.status = 'leased'
    AND request.lease_expires_at <= clock_timestamp();
  UPDATE public.merch_marking_signature_requests AS request
  SET status = 'expired', updated_at = clock_timestamp()
  WHERE request.status = 'pending' AND request.expires_at <= clock_timestamp();

  SELECT request.id INTO candidate_id
  FROM public.merch_marking_signature_requests AS request
  WHERE request.status = 'pending'
    AND request.expires_at > clock_timestamp()
    AND request.attempt_count < 20
  ORDER BY request.created_at, request.id
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
  IF candidate_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.merch_marking_signature_requests AS request
  SET status = 'leased', lease_agent_id = p_agent_id,
      leased_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      attempt_count = request.attempt_count + 1,
      updated_at = clock_timestamp()
  WHERE request.id = candidate_id
  RETURNING request.id, request.purpose, request.payload_sha256,
    request.payload_ciphertext, request.payload_nonce, request.payload_auth_tag,
    request.encryption_key_version, request.expires_at;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.complete_remote_signature_request(
  p_agent_id text,
  p_signature_request_id uuid,
  p_signature_ciphertext bytea,
  p_signature_nonce bytea,
  p_signature_auth_tag bytea,
  p_signature_key_version integer,
  p_certificate_thumbprint text,
  p_certificate_subject text,
  p_certificate_inn text,
  p_certificate_ogrn text,
  p_certificate_valid_from timestamp with time zone,
  p_certificate_valid_to timestamp with time zone,
  p_certificate_algorithm text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_agent_id !~ '^[A-Za-z0-9._-]{1,80}$'
     OR p_signature_request_id IS NULL
     OR octet_length(p_signature_ciphertext) NOT BETWEEN 64 AND 262144
     OR octet_length(p_signature_nonce) <> 12
     OR octet_length(p_signature_auth_tag) <> 16
     OR p_signature_key_version NOT BETWEEN 1 AND 1000000
     OR p_certificate_thumbprint !~ '^[0-9A-F]{40,128}$'
     OR length(p_certificate_subject) NOT BETWEEN 1 AND 500
     OR p_certificate_inn !~ '^\d{10}(\d{2})?$'
     OR (p_certificate_ogrn IS NOT NULL AND p_certificate_ogrn !~ '^\d{13}(\d{2})?$')
     OR p_certificate_valid_from IS NULL
     OR p_certificate_valid_to <= p_certificate_valid_from
     OR p_certificate_valid_to <= clock_timestamp()
     OR length(p_certificate_algorithm) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid remote signature result' USING ERRCODE = 'MZ958';
  END IF;
  UPDATE public.merch_marking_signature_requests AS request
  SET status = 'signed', signature_ciphertext = p_signature_ciphertext,
      signature_nonce = p_signature_nonce, signature_auth_tag = p_signature_auth_tag,
      signature_key_version = p_signature_key_version,
      certificate_thumbprint = p_certificate_thumbprint,
      certificate_subject = p_certificate_subject,
      certificate_inn = p_certificate_inn,
      certificate_ogrn = p_certificate_ogrn,
      certificate_valid_from = p_certificate_valid_from,
      certificate_valid_to = p_certificate_valid_to,
      certificate_algorithm = p_certificate_algorithm,
      lease_expires_at = NULL, signed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE request.id = p_signature_request_id
    AND request.status = 'leased'
    AND request.lease_agent_id = p_agent_id
    AND request.lease_expires_at > clock_timestamp()
    AND request.expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remote signature lease is not active' USING ERRCODE = 'MZ959';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION getomerch_marking.fail_remote_signature_request(
  p_agent_id text,
  p_signature_request_id uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  next_status text;
BEGIN
  IF p_agent_id !~ '^[A-Za-z0-9._-]{1,80}$'
     OR p_signature_request_id IS NULL
     OR p_error_code !~ '^[A-Za-z0-9_:-]{2,120}$'
     OR p_error_message IS NULL OR length(p_error_message) NOT BETWEEN 1 AND 500
     OR p_retryable IS NULL THEN
    RAISE EXCEPTION 'invalid remote signature failure' USING ERRCODE = 'MZ960';
  END IF;
  SELECT CASE
    WHEN p_retryable AND request.expires_at > clock_timestamp()
      AND request.attempt_count < 10 THEN 'pending'
    ELSE 'failed'
  END INTO next_status
  FROM public.merch_marking_signature_requests AS request
  WHERE request.id = p_signature_request_id
    AND request.status = 'leased'
    AND request.lease_agent_id = p_agent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remote signature lease is not active' USING ERRCODE = 'MZ961';
  END IF;
  UPDATE public.merch_marking_signature_requests AS request
  SET status = next_status, lease_expires_at = NULL,
      error_code = CASE WHEN next_status = 'failed' THEN p_error_code ELSE NULL END,
      error_message = CASE WHEN next_status = 'failed' THEN p_error_message ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE request.id = p_signature_request_id;
  RETURN next_status;
END
$function$;

CREATE VIEW getomerch_marking.signing_agent_safe
WITH (security_barrier = true)
AS
SELECT
  agent.agent_id,
  agent.display_name,
  CASE WHEN agent.last_seen_at < clock_timestamp() - interval '45 seconds'
    THEN 'offline'::text ELSE agent.state END AS state,
  agent.reader_detected,
  agent.signer_reachable,
  agent.pin_state,
  agent.certificate_thumbprint,
  agent.certificate_valid_to,
  agent.software_version,
  agent.last_error_code,
  agent.last_error_message,
  agent.last_seen_at,
  agent.created_at,
  agent.updated_at
FROM public.merch_marking_signing_agents AS agent;

CREATE VIEW getomerch_marking.signature_request_safe
WITH (security_barrier = true)
AS
SELECT
  request.id,
  request.purpose,
  request.payload_sha256,
  request.status,
  request.requested_by,
  request.request_id,
  request.lease_agent_id,
  request.attempt_count,
  request.certificate_thumbprint,
  request.certificate_valid_to,
  request.error_code,
  request.error_message,
  request.expires_at,
  request.signed_at,
  request.consumed_at,
  request.created_at,
  request.updated_at
FROM public.merch_marking_signature_requests AS request;

REVOKE ALL ON public.merch_marking_signing_agents,
  public.merch_marking_agent_nonces,
  public.merch_marking_signature_requests FROM PUBLIC, getomerch_app;
GRANT SELECT ON public.merch_marking_signing_agents,
  public.merch_marking_agent_nonces,
  public.merch_marking_signature_requests TO getomerch_backup;
REVOKE ALL ON getomerch_marking.signing_agent_safe,
  getomerch_marking.signature_request_safe FROM PUBLIC;
GRANT SELECT ON getomerch_marking.signing_agent_safe,
  getomerch_marking.signature_request_safe TO getomerch_app, getomerch_backup;

REVOKE ALL ON FUNCTION getomerch_marking.create_remote_signature_request(
  text, text, bytea, bytea, bytea, integer, text, uuid, timestamp with time zone
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.get_remote_signature_result(
  uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.consume_remote_signature_request(
  uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.accept_signing_agent_envelope(
  text, text, uuid, timestamp with time zone, text, text, boolean, boolean,
  text, text, timestamp with time zone, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.claim_remote_signature_request(
  text, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.complete_remote_signature_request(
  text, uuid, bytea, bytea, bytea, integer, text, text, text, text,
  timestamp with time zone, timestamp with time zone, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_marking.fail_remote_signature_request(
  text, uuid, text, text, boolean
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION getomerch_marking.accept_signing_agent_envelope(
  text, text, uuid, timestamp with time zone, text, text, boolean, boolean,
  text, text, timestamp with time zone, text, text, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.claim_remote_signature_request(
  text, integer
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.complete_remote_signature_request(
  text, uuid, bytea, bytea, bytea, integer, text, text, text, text,
  timestamp with time zone, timestamp with time zone, text
) TO getomerch_app;
GRANT EXECUTE ON FUNCTION getomerch_marking.fail_remote_signature_request(
  text, uuid, text, text, boolean
) TO getomerch_app;

COMMENT ON TABLE public.merch_marking_signature_requests IS
  'Encrypted outbound-only Mac signing broker. Plain payloads, signatures and PIN values are forbidden.';
COMMENT ON FUNCTION getomerch_marking.accept_signing_agent_envelope(
  text, text, uuid, timestamp with time zone, text, text, boolean, boolean,
  text, text, timestamp with time zone, text, text, text
) IS 'Records an already HMAC-verified agent request and rejects durable nonce replay.';
