WITH feature AS (
  SELECT feature_key, enabled, revision
  FROM public.merch_admin_feature_flags
  WHERE feature_key = 'chestny_znak'
)
SELECT
  'admin_feature_flag_seed' AS check_name,
  count(*) = 1 AND min(revision) >= 1 AS ok,
  count(*)::text AS actual,
  '1' AS expected
FROM feature
UNION ALL
SELECT
  'admin_feature_flag_app_read',
  has_schema_privilege('getomerch_app', 'getomerch_admin', 'USAGE')
    AND has_table_privilege(
      'getomerch_app', 'getomerch_admin.feature_flag_safe', 'SELECT'
    ),
  (
    has_schema_privilege('getomerch_app', 'getomerch_admin', 'USAGE')
    AND has_table_privilege(
      'getomerch_app', 'getomerch_admin.feature_flag_safe', 'SELECT'
    )
  )::text,
  'true'
UNION ALL
SELECT
  'admin_feature_flag_no_direct_app_dml',
  NOT has_table_privilege(
    'getomerch_app', 'public.merch_admin_feature_flags',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
  ),
  (
    NOT has_table_privilege(
      'getomerch_app', 'public.merch_admin_feature_flags',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
    )
  )::text,
  'true'
UNION ALL
SELECT
  'admin_feature_flag_mutation_function',
  has_function_privilege(
    'getomerch_app',
    'getomerch_admin.set_feature_flag(text,boolean,bigint,text)',
    'EXECUTE'
  ),
  has_function_privilege(
    'getomerch_app',
    'getomerch_admin.set_feature_flag(text,boolean,bigint,text)',
    'EXECUTE'
  )::text,
  'true';
