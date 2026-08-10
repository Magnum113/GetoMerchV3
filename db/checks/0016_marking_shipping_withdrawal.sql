WITH actual AS (
  SELECT
    (
      SELECT count(*) FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
        AND relation.relname IN (
          'merch_marking_shipping_gate_evaluations',
          'merch_marking_handovers',
          'merch_marking_handover_units',
          'merch_marking_withdrawal_confirmations'
        )
    ) AS table_count,
    (
      SELECT count(*) FROM unnest(ARRAY[
        'getomerch_marking.evaluate_shipping_gate(uuid,text,text,uuid)',
        'getomerch_marking.record_shipping_handover(uuid,uuid,text,uuid,text)',
        'getomerch_marking.prepare_withdrawal_document(uuid,text,uuid,boolean)',
        'getomerch_marking.get_withdrawal_document_material(uuid,text)',
        'getomerch_marking.record_withdrawal_poll(uuid,text,jsonb,text,text,text)',
        'getomerch_marking.record_withdrawal_manual_review(uuid,text,text,text)'
      ]) AS function_name
      WHERE to_regprocedure(function_name) IS NOT NULL
    ) AS function_count,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_handovers',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_handover_base_access,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_shipping_gate_evaluations',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_gate_base_access,
    has_table_privilege(
      'getomerch_app', 'getomerch_marking.shipping_handover_safe', 'SELECT'
    ) AS app_safe_read,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.record_shipping_handover(uuid,uuid,text,uuid,text)',
      'EXECUTE'
    ) AS app_handover_execute,
    pg_get_viewdef('getomerch_marking.shipping_handover_safe'::regclass, true)
      !~ '(code_ciphertext|payload_ciphertext|signature_ciphertext|code_hmac)'
      AS safe_projection,
    pg_get_functiondef(
      'getomerch_marking.reconcile_jit_order_trigger()'::regprocedure
    ) !~ '(delivering|delivered|driver_pickup|sent_by_seller)'
      AS no_status_handover
)
SELECT 'marking_stage11_objects' AS check_name,
  table_count = 4 AND function_count = 6 AS ok,
  concat('tables=', table_count, ',functions=', function_count) AS actual,
  'tables=4,functions=6' AS expected
FROM actual
UNION ALL
SELECT 'marking_stage11_acl',
  NOT app_handover_base_access AND NOT app_gate_base_access
    AND app_safe_read AND app_handover_execute,
  concat('handover=', app_handover_base_access,
    ',gate=', app_gate_base_access, ',safe=', app_safe_read,
    ',execute=', app_handover_execute),
  'handover=false,gate=false,safe=true,execute=true'
FROM actual
UNION ALL
SELECT 'marking_stage11_safe_projection', safe_projection,
  safe_projection::text, 'true'
FROM actual
UNION ALL
SELECT 'marking_stage11_explicit_handover', no_status_handover,
  no_status_handover::text, 'true'
FROM actual
ORDER BY check_name;
