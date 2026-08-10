WITH actual AS (
  SELECT
    (
      SELECT count(*) FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
        AND relation.relname IN (
          'merch_marking_code_orders', 'merch_marking_code_order_items'
        )
    ) AS table_count,
    (
      SELECT count(*) FROM unnest(ARRAY[
        'getomerch_marking.update_suz_pool_policy(uuid,bigint,boolean,integer,integer,integer,integer,integer,text)',
        'getomerch_marking.create_suz_order_draft(uuid,integer,text,text,text,jsonb,text)',
        'getomerch_marking.approve_suz_order(uuid,bigint,text)',
        'getomerch_marking.cancel_suz_order(uuid,bigint,text,text)',
        'getomerch_marking.get_suz_order_material(uuid)',
        'getomerch_marking.record_suz_submit_started(uuid,text,text,text,text)',
        'getomerch_marking.record_suz_submitted(uuid,uuid,uuid,integer,jsonb)',
        'getomerch_marking.record_suz_order_status(uuid,text,text,integer,jsonb)',
        'getomerch_marking.attach_suz_code_block(uuid,uuid,uuid,integer,integer,integer,integer,text)',
        'getomerch_marking.confirm_suz_utilisation(uuid,uuid,text,integer,integer,integer,jsonb)',
        'getomerch_marking.record_suz_order_manual_review(uuid,text,text,text)'
      ]) AS function_name
      WHERE to_regprocedure(function_name) IS NOT NULL
    ) AS function_count,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_code_orders',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_order_base_access,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_code_order_items',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_item_base_access,
    has_table_privilege(
      'getomerch_app', 'getomerch_marking.suz_pool_forecast_safe', 'SELECT'
    ) AS app_forecast_read,
    has_table_privilege(
      'getomerch_app', 'getomerch_marking.suz_code_order_safe', 'SELECT'
    ) AS app_order_read,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.approve_suz_order(uuid,bigint,text)', 'EXECUTE'
    ) AS app_approve_execute,
    pg_get_viewdef('getomerch_marking.suz_code_order_safe'::regclass, true)
      !~ '(code_ciphertext|code_nonce|code_auth_tag|code_hmac|signature_hash)'
      AS safe_projection,
    pg_get_constraintdef(
      (SELECT oid FROM pg_constraint
       WHERE conname = 'merch_marking_codes_pool_state_check')
    ) ~ 'pending_utilisation' AS pending_state_present,
    pg_get_constraintdef(
      (SELECT oid FROM pg_constraint
       WHERE conname = 'merch_marking_signature_requests_purpose_check')
    ) ~ 'crpt_suz_order_detached_cades_bes' AS signer_purpose_present,
    position('upper(p_state) = ''SUCCESS''' in pg_get_functiondef(
      'getomerch_marking.confirm_suz_utilisation(uuid,uuid,text,integer,integer,integer,jsonb)'::regprocedure
    )) > 0
    AND position('p_code = 0' in pg_get_functiondef(
      'getomerch_marking.confirm_suz_utilisation(uuid,uuid,text,integer,integer,integer,jsonb)'::regprocedure
    )) > 0 AS utilisation_gate_present,
    pg_get_viewdef(
      'getomerch_marking.suz_pool_forecast_safe'::regclass, true
    ) ~ 'product_group = ''clothes''::text' AS forecast_group_scoped,
    pg_get_functiondef(
      'getomerch_marking.create_suz_order_draft(uuid,integer,text,text,text,jsonb,text)'::regprocedure
    ) ~ 'product_group <> ''clothes''' AS draft_group_scoped
)
SELECT 'marking_stage13_objects' AS check_name,
  table_count = 2 AND function_count = 11 AS ok,
  concat('tables=', table_count, ',functions=', function_count) AS actual,
  'tables=2,functions=11' AS expected
FROM actual
UNION ALL
SELECT 'marking_stage13_acl',
  NOT app_order_base_access AND NOT app_item_base_access
    AND app_forecast_read AND app_order_read AND app_approve_execute,
  concat('order_base=', app_order_base_access, ',item_base=', app_item_base_access,
    ',forecast=', app_forecast_read, ',orders=', app_order_read,
    ',approve=', app_approve_execute),
  'order_base=false,item_base=false,forecast=true,orders=true,approve=true'
FROM actual
UNION ALL
SELECT 'marking_stage13_safe_projection', safe_projection,
  safe_projection::text, 'true'
FROM actual
UNION ALL
SELECT 'marking_stage13_state_gates',
  pending_state_present AND signer_purpose_present AND utilisation_gate_present,
  concat('pending=', pending_state_present, ',signer=', signer_purpose_present,
    ',utilisation=', utilisation_gate_present),
  'pending=true,signer=true,utilisation=true'
FROM actual
UNION ALL
SELECT 'marking_stage13_product_group_scope',
  forecast_group_scoped AND draft_group_scoped,
  concat('forecast=', forecast_group_scoped, ',draft=', draft_group_scoped),
  'forecast=true,draft=true'
FROM actual
ORDER BY check_name;
