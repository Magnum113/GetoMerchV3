WITH actual AS (
  SELECT
    to_regclass('public.merch_marking_signing_agents') IS NOT NULL AS agents_table,
    to_regclass('public.merch_marking_agent_nonces') IS NOT NULL AS nonces_table,
    to_regclass('public.merch_marking_signature_requests') IS NOT NULL AS requests_table,
    to_regclass('getomerch_marking.signing_agent_safe') IS NOT NULL AS agents_view,
    to_regclass('getomerch_marking.signature_request_safe') IS NOT NULL AS requests_view,
    to_regprocedure(
      'getomerch_marking.create_remote_signature_request(text,text,bytea,bytea,bytea,integer,text,uuid,timestamp with time zone)'
    ) IS NOT NULL AS create_function,
    to_regprocedure(
      'getomerch_marking.accept_signing_agent_envelope(text,text,uuid,timestamp with time zone,text,text,boolean,boolean,text,text,timestamp with time zone,text,text,text)'
    ) IS NOT NULL AS envelope_function,
    to_regprocedure(
      'getomerch_marking.claim_remote_signature_request(text,integer)'
    ) IS NOT NULL AS claim_function,
    to_regprocedure(
      'getomerch_marking.complete_remote_signature_request(text,uuid,bytea,bytea,bytea,integer,text,text,text,text,timestamp with time zone,timestamp with time zone,text)'
    ) IS NOT NULL AS complete_function,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_signature_requests',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_base_access,
    has_table_privilege(
      'getomerch_app', 'getomerch_marking.signature_request_safe', 'SELECT'
    ) AS app_safe_read,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.create_remote_signature_request(text,text,bytea,bytea,bytea,integer,text,uuid,timestamp with time zone)',
      'EXECUTE'
    ) AS app_worker_create,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.claim_remote_signature_request(text,integer)',
      'EXECUTE'
    ) AS app_agent_claim
)
SELECT 'marking_stage9_remote_signer_objects' AS check_name,
  agents_table AND nonces_table AND requests_table AND agents_view
    AND requests_view AND create_function AND envelope_function AND claim_function
    AND complete_function AS ok,
  concat('agents=', agents_table, ',nonces=', nonces_table,
    ',requests=', requests_table, ',agent_view=', agents_view,
    ',request_view=', requests_view, ',create=', create_function,
    ',envelope=', envelope_function, ',claim=', claim_function,
    ',complete=', complete_function) AS actual,
  'all=true' AS expected
FROM actual
UNION ALL
SELECT 'marking_stage9_remote_signer_acl',
  NOT app_base_access AND app_safe_read AND NOT app_worker_create AND app_agent_claim,
  concat('base=', app_base_access, ',safe=', app_safe_read,
    ',worker_create=', app_worker_create, ',agent_claim=', app_agent_claim),
  'base=false,safe=true,worker_create=false,agent_claim=true'
FROM actual
ORDER BY check_name;
