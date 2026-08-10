WITH actual AS (
  SELECT
    (
      SELECT count(*) FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
        AND relation.relname IN (
          'merch_marking_return_cases',
          'merch_marking_return_case_events',
          'merch_marking_return_confirmations'
        )
    ) AS table_count,
    (
      SELECT count(*) FROM unnest(ARRAY[
        'getomerch_marking.upsert_ozon_return_case(text,text,text,text,text,integer,text,text,text,text,jsonb,timestamp with time zone,text)',
        'getomerch_marking.confirm_return_direction(uuid,bigint,text,boolean,text,uuid)',
        'getomerch_marking.prepare_return_document(uuid,text,uuid,boolean)',
        'getomerch_marking.get_return_document_material(uuid,text)',
        'getomerch_marking.record_return_poll(uuid,text,jsonb,text,text,text)',
        'getomerch_marking.record_seller_return_receipt(uuid,bigint,text,uuid,uuid,text,uuid)',
        'getomerch_marking.confirm_return_fbo_transfer(uuid,bigint,text,text,text,uuid)',
        'getomerch_marking.get_seller_receipt_context(uuid)'
      ]) AS function_name
      WHERE to_regprocedure(function_name) IS NOT NULL
    ) AS function_count,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_return_cases',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_base_access,
    has_table_privilege(
      'getomerch_app', 'getomerch_marking.return_case_safe', 'SELECT'
    ) AS app_safe_read,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.confirm_return_direction(uuid,bigint,text,boolean,text,uuid)',
      'EXECUTE'
    ) AS app_direction_execute,
    pg_get_viewdef('getomerch_marking.return_case_safe'::regclass, true)
      !~ '(code_ciphertext|payload_ciphertext|signature_ciphertext|code_hmac)'
      AS safe_projection,
    pg_get_functiondef(
      'getomerch_marking.confirm_return_fbo_transfer(uuid,bigint,text,text,text,uuid)'::regprocedure
    ) ~ 'custody_state = ''ozon_fbo'''
      AS explicit_fbo_custody,
    pg_get_functiondef(
      'getomerch_marking.confirm_return_fbo_transfer(uuid,bigint,text,text,text,uuid)'::regprocedure
    ) !~ '(merch_inventory|merch_transactions)'
      AS fbo_has_no_stock_write
)
SELECT 'marking_stage12_objects' AS check_name,
  table_count = 3 AND function_count = 8 AS ok,
  concat('tables=', table_count, ',functions=', function_count) AS actual,
  'tables=3,functions=8' AS expected
FROM actual
UNION ALL
SELECT 'marking_stage12_acl',
  NOT app_base_access AND app_safe_read AND app_direction_execute,
  concat('base=', app_base_access, ',safe=', app_safe_read,
    ',execute=', app_direction_execute),
  'base=false,safe=true,execute=true'
FROM actual
UNION ALL
SELECT 'marking_stage12_safe_projection', safe_projection,
  safe_projection::text, 'true'
FROM actual
UNION ALL
SELECT 'marking_stage12_fbo_custody',
  explicit_fbo_custody AND fbo_has_no_stock_write,
  concat('custody=', explicit_fbo_custody, ',no_stock=', fbo_has_no_stock_write),
  'custody=true,no_stock=true'
FROM actual
ORDER BY check_name;
