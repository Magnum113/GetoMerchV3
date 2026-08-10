with actual as (
  select
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind = 'r'
        and relation.relname in (
          'merch_marking_units',
          'merch_marking_code_bindings',
          'merch_marking_assignments'
        )
    ) as table_count,
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'getomerch_marking'
        and relation.relkind = 'v'
        and relation.relname in ('assignment_safe', 'jit_candidate_safe')
    ) as view_count,
    (
      select count(*)
      from unnest(array[
        'getomerch_marking.prepare_jit_assignment(uuid,uuid,text)',
        'getomerch_marking.lock_jit_assignment_for_apply(uuid,bigint,text)',
        'getomerch_marking.complete_jit_application(uuid,bigint,uuid,text)',
        'getomerch_marking.cancel_jit_assignment(uuid,bigint,text,text)',
        'getomerch_marking.reconcile_jit_assignments_for_item(uuid,text,text)'
      ]) function_name
      where to_regprocedure(function_name) is not null
    ) as function_count,
    (
      select count(*)
      from pg_trigger trigger_info
      join pg_class relation on relation.oid = trigger_info.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname in (
          'merch_fulfillment_orders',
          'merch_fulfillment_order_items'
        )
        and trigger_info.tgname in (
          'merch_fulfillment_orders_reconcile_marking',
          'merch_fulfillment_items_reconcile_marking'
        )
        and not trigger_info.tgisinternal
    ) as trigger_count,
    (
      select count(*)
      from public.merch_marking_assignments assignment
      join public.merch_marking_code_bindings binding
        on binding.id = assignment.code_binding_id
      join public.merch_marking_units unit
        on unit.id = assignment.marking_unit_id
      join public.merch_marking_product_profiles profile
        on profile.id = assignment.product_profile_id
      join public.merch_marking_codes code
        on code.id = binding.marking_code_id
      where binding.marking_unit_id <> assignment.marking_unit_id
         or unit.product_profile_id <> assignment.product_profile_id
         or code.trade_item_id <> profile.trade_item_id
         or code.gtin_snapshot <> assignment.gtin_snapshot
    ) as inconsistent_assignment_count,
    (
      select count(*)
      from public.merch_marking_assignments assignment
      where assignment.status = 'active'
        and assignment.unit_ordinal > (
          select item.quantity
          from public.merch_fulfillment_order_items item
          where item.id = assignment.fulfillment_item_id
        )
    ) as excess_active_slot_count,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_units',
      'SELECT,INSERT,UPDATE,DELETE'
    ) as app_unit_base_access,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_code_bindings',
      'SELECT,INSERT,UPDATE,DELETE'
    ) as app_binding_base_access,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_assignments',
      'SELECT,INSERT,UPDATE,DELETE'
    ) as app_assignment_base_access,
    has_table_privilege(
      'getomerch_app',
      'getomerch_marking.assignment_safe',
      'SELECT'
    ) as app_assignment_view_access,
    has_table_privilege(
      'getomerch_app',
      'getomerch_marking.jit_candidate_safe',
      'SELECT'
    ) as app_candidate_view_access,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.prepare_jit_assignment(uuid,uuid,text)',
      'EXECUTE'
    ) as app_prepare_execute,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.complete_jit_application(uuid,bigint,uuid,text)',
      'EXECUTE'
    ) as app_complete_execute
)
select 'marking_stage6_tables' as check_name,
  table_count = 3 as ok, table_count::text as actual, '3' as expected
from actual
union all
select 'marking_stage6_safe_views',
  view_count = 2, view_count::text, '2'
from actual
union all
select 'marking_stage6_functions',
  function_count = 5, function_count::text, '5'
from actual
union all
select 'marking_stage6_reconciliation_triggers',
  trigger_count = 2, trigger_count::text, '2'
from actual
union all
select 'marking_stage6_assignment_integrity',
  inconsistent_assignment_count = 0,
  inconsistent_assignment_count::text,
  '0'
from actual
union all
select 'marking_stage6_active_slots_within_quantity',
  excess_active_slot_count = 0,
  excess_active_slot_count::text,
  '0'
from actual
union all
select 'marking_stage6_app_no_base_access',
  not app_unit_base_access
    and not app_binding_base_access
    and not app_assignment_base_access,
  concat(
    'unit=', app_unit_base_access,
    ',binding=', app_binding_base_access,
    ',assignment=', app_assignment_base_access
  ),
  'unit=false,binding=false,assignment=false'
from actual
union all
select 'marking_stage6_app_safe_read',
  app_assignment_view_access and app_candidate_view_access,
  concat(
    'assignment=', app_assignment_view_access,
    ',candidate=', app_candidate_view_access
  ),
  'assignment=true,candidate=true'
from actual
union all
select 'marking_stage6_app_commands',
  app_prepare_execute and app_complete_execute,
  concat('prepare=', app_prepare_execute, ',complete=', app_complete_execute),
  'prepare=true,complete=true'
from actual
order by check_name;
