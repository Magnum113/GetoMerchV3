WITH actual AS (
  SELECT
    to_regclass('public.merch_marking_documents') IS NOT NULL AS documents_table,
    to_regclass('public.merch_marking_document_codes') IS NOT NULL AS codes_table,
    to_regclass('public.merch_marking_document_confirmations') IS NOT NULL
      AS confirmations_table,
    to_regclass('getomerch_marking.document_safe') IS NOT NULL AS documents_view,
    to_regclass('getomerch_marking.document_code_safe') IS NOT NULL AS codes_view,
    to_regprocedure(
      'getomerch_marking.prepare_introduction_document(uuid,text,uuid,boolean)'
    ) IS NOT NULL AS prepare_function,
    to_regprocedure(
      'getomerch_marking.store_introduction_payload(uuid,text,bytea,bytea,bytea,integer,text)'
    ) IS NOT NULL AS payload_function,
    to_regprocedure(
      'getomerch_marking.store_introduction_signature(uuid,text,bytea,bytea,bytea,integer,text,text)'
    ) IS NOT NULL AS signature_function,
    to_regprocedure(
      'getomerch_marking.record_introduction_submitted(uuid,text,jsonb,text)'
    ) IS NOT NULL AS submit_function,
    to_regprocedure(
      'getomerch_marking.record_introduction_submit_started(uuid,text)'
    ) IS NOT NULL AS submit_started_function,
    to_regprocedure(
      'getomerch_marking.record_introduction_poll(uuid,text,jsonb,text,text)'
    ) IS NOT NULL AS poll_function,
    to_regprocedure(
      'getomerch_marking.confirm_introduction_circulation(uuid,text,text)'
    ) IS NOT NULL AS confirmation_function,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_documents',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_documents_access,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_document_confirmations',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_confirmations_access,
    has_table_privilege(
      'getomerch_app', 'getomerch_marking.document_safe', 'SELECT'
    ) AS app_safe_read,
    pg_get_viewdef('getomerch_marking.document_safe'::regclass, true)
      !~ '(payload_ciphertext|signature_ciphertext)' AS safe_document_projection,
    pg_get_viewdef('getomerch_marking.document_code_safe'::regclass, true)
      !~ 'code_ciphertext' AS safe_code_projection,
    EXISTS (
      SELECT 1
      FROM pg_constraint AS purpose_constraint
      WHERE purpose_constraint.conrelid =
          'public.merch_marking_signature_requests'::regclass
        AND purpose_constraint.conname =
          'merch_marking_signature_requests_purpose_check'
        AND pg_get_constraintdef(purpose_constraint.oid)
          LIKE '%crpt_document_detached_cades_bes%'
    ) AS detached_purpose_registered
)
SELECT 'marking_stage10_objects' AS check_name,
  documents_table AND codes_table AND confirmations_table
    AND documents_view AND codes_view AND prepare_function
    AND payload_function AND signature_function AND submit_function
    AND submit_started_function
    AND poll_function AND confirmation_function AS ok,
  concat('documents=', documents_table, ',codes=', codes_table,
    ',confirmations=', confirmations_table, ',document_view=', documents_view,
    ',code_view=', codes_view, ',prepare=', prepare_function,
    ',payload=', payload_function, ',signature=', signature_function,
    ',submit=', submit_function, ',submit_started=', submit_started_function,
    ',poll=', poll_function,
    ',confirm=', confirmation_function) AS actual,
  'all=true' AS expected
FROM actual
UNION ALL
SELECT 'marking_stage10_acl',
  NOT app_documents_access AND NOT app_confirmations_access AND app_safe_read,
  concat('documents=', app_documents_access,
    ',confirmations=', app_confirmations_access, ',safe=', app_safe_read),
  'documents=false,confirmations=false,safe=true'
FROM actual
UNION ALL
SELECT 'marking_stage10_safe_views',
  safe_document_projection AND safe_code_projection,
  concat('document=', safe_document_projection, ',code=', safe_code_projection),
  'document=true,code=true'
FROM actual
UNION ALL
SELECT 'marking_stage10_signer_contract', detached_purpose_registered,
  detached_purpose_registered::text, 'true'
FROM actual
ORDER BY check_name;
