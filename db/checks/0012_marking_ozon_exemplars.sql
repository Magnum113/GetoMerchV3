with actual as (
  select
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind = 'r'
        and relation.relname in (
          'merch_marking_ozon_submission_batches',
          'merch_marking_ozon_submissions'
        )
    ) as table_count,
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'getomerch_marking'
        and relation.relkind = 'v'
        and relation.relname in (
          'ozon_submission_batch_safe', 'ozon_submission_safe',
          'assignment_action_safe'
        )
    ) as view_count,
    (
      select count(*)
      from unnest(array[
        'getomerch_marking.prepare_ozon_submission_batch(uuid,text,boolean)',
        'getomerch_marking.record_ozon_exemplar_mapping(uuid,jsonb,integer,jsonb,text)',
        'getomerch_marking.get_ozon_submission_material(uuid,text,text)',
        'getomerch_marking.record_ozon_validation(uuid,jsonb,jsonb)',
        'getomerch_marking.record_ozon_set_queued_for_poll(uuid,text,jsonb)',
        'getomerch_marking.record_ozon_poll(uuid,text,jsonb,jsonb)',
        'getomerch_marking.record_ozon_batch_failure(uuid,text,text,text)'
      ]) function_name
      where to_regprocedure(function_name) is not null
    ) as function_count,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_ozon_submission_batches',
      'SELECT,INSERT,UPDATE,DELETE'
    ) as app_batch_base_access,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_ozon_submissions',
      'SELECT,INSERT,UPDATE,DELETE'
    ) as app_submission_base_access,
    has_table_privilege(
      'getomerch_app',
      'getomerch_marking.ozon_submission_batch_safe',
      'SELECT'
    ) as app_safe_read,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.get_ozon_submission_material(uuid,text,text)',
      'EXECUTE'
    ) as app_material_execute
)
select 'marking_stage8_tables' as check_name,
  table_count = 2 as ok, table_count::text as actual, '2' as expected
from actual
union all
select 'marking_stage8_views', view_count = 3, view_count::text, '3'
from actual
union all
select 'marking_stage8_functions', function_count = 7,
  function_count::text, '7'
from actual
union all
select 'marking_stage8_app_no_base_access',
  not app_batch_base_access and not app_submission_base_access,
  concat('batch=', app_batch_base_access, ',submission=', app_submission_base_access),
  'batch=false,submission=false'
from actual
union all
select 'marking_stage8_app_safe_commands',
  app_safe_read and app_material_execute,
  concat('read=', app_safe_read, ',material=', app_material_execute),
  'read=true,material=true'
from actual
order by check_name;
