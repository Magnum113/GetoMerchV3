-- Correct the Stage 10 material projection: offer_id belongs to the generic
-- fulfillment item, not to the serialized marking assignment.

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
    link.gtin_snapshot, item.offer_id, trade_item.tnved_code,
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

