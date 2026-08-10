with actual as (
  select
    (
      select count(*)
      from unnest(array[
        'getomerch_marking.get_jit_label_material(uuid,bigint,text)',
        'getomerch_marking.record_jit_label_render(uuid,bigint,uuid,text,text,text)'
      ]) function_name
      where to_regprocedure(function_name) is not null
    ) as function_count,
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'getomerch_marking'
        and relation.relkind = 'v'
        and relation.relname in (
          'assignment_action_safe',
          'jit_candidate_action_safe'
        )
    ) as view_count,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.get_jit_label_material(uuid,bigint,text)',
      'EXECUTE'
    ) as app_material_execute,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.record_jit_label_render(uuid,bigint,uuid,text,text,text)',
      'EXECUTE'
    ) as app_render_execute,
    has_table_privilege(
      'getomerch_app',
      'getomerch_marking.assignment_action_safe',
      'SELECT'
    ) as app_action_view_select,
    has_table_privilege(
      'getomerch_app',
      'getomerch_marking.jit_candidate_action_safe',
      'SELECT'
    ) as app_candidate_action_view_select,
    (
      select count(*)
      from information_schema.columns
      where table_schema = 'getomerch_marking'
        and table_name in (
          'assignment_action_safe',
          'jit_candidate_action_safe'
        )
        and column_name in (
          'code_ciphertext',
          'code_nonce',
          'code_auth_tag',
          'code_hmac',
          'serial'
        )
    ) as secret_column_count
)
select 'marking_stage7_functions' as check_name,
  function_count = 2 as ok, function_count::text as actual, '2' as expected
from actual
union all
select 'marking_stage7_action_view',
  view_count = 2, view_count::text, '2'
from actual
union all
select 'marking_stage7_app_commands',
  app_material_execute and app_render_execute,
  concat(
    'material=', app_material_execute,
    ',render=', app_render_execute
  ),
  'material=true,render=true'
from actual
union all
select 'marking_stage7_app_safe_read',
  app_action_view_select and app_candidate_action_view_select,
  concat(
    'assignment=', app_action_view_select,
    ',candidate=', app_candidate_action_view_select
  ),
  'assignment=true,candidate=true'
from actual
union all
select 'marking_stage7_view_no_secrets',
  secret_column_count = 0,
  secret_column_count::text,
  '0'
from actual
order by check_name;
