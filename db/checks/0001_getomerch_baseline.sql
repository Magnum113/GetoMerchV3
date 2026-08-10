with expected_tables(table_name) as (
  values
    ('merch_warehouses'),
    ('merch_product_categories'),
    ('merch_fabric_types'),
    ('merch_colors'),
    ('merch_sizes'),
    ('merch_designs'),
    ('merch_decoration_types'),
    ('merch_products'),
    ('merch_inventory'),
    ('merch_print_inventory'),
    ('merch_transactions'),
    ('merch_workshop_orders'),
    ('merch_workshop_order_items'),
    ('merch_ozon_orders'),
    ('merch_ozon_order_items'),
    ('merch_fulfillment_orders'),
    ('merch_fulfillment_order_items'),
    ('merch_fulfillment_events'),
    ('merch_marking_trade_items'),
    ('merch_marking_trade_item_documents'),
    ('merch_marking_product_profiles'),
    ('merch_marking_locations'),
    ('merch_marking_processes'),
    ('merch_marking_evidence'),
    ('merch_marking_events'),
    ('merch_marking_product_profile_channels'),
    ('merch_marking_profile_backfill_runs'),
    ('merch_marking_profile_backfill_items'),
    ('merch_marking_import_batches'),
    ('merch_marking_import_rows'),
    ('merch_marking_codes'),
    ('merch_marking_code_hmacs'),
    ('merch_marking_units'),
    ('merch_marking_code_bindings'),
    ('merch_marking_assignments'),
    ('merch_marking_ozon_submission_batches'),
    ('merch_marking_ozon_submissions'),
    ('merch_marking_crpt_queries'),
    ('merch_ozon_finance_operations'),
    ('merch_expense_categories'),
    ('merch_expenses'),
    ('merch_ozon_import_runs'),
    ('merch_ozon_import_items')
),
actual as (
  select
    (
      select count(*)
      from expected_tables expected
      join pg_class relation on relation.relname = expected.table_name
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relkind = 'r'
    ) as table_count,
    (
      select count(*)
      from information_schema.columns column_info
      join expected_tables expected
        on expected.table_name = column_info.table_name
      where column_info.table_schema = 'public'
    ) as column_count,
    (
      select count(*)
      from information_schema.columns column_info
      join expected_tables expected
        on expected.table_name = column_info.table_name
      where column_info.table_schema = 'public'
        and column_info.column_default is not null
    ) as default_count,
    (
      select count(*)
      from information_schema.columns column_info
      join expected_tables expected
        on expected.table_name = column_info.table_name
      where column_info.table_schema = 'public'
        and column_info.is_nullable = 'NO'
    ) as not_null_count,
    (
      select count(*)
      from pg_constraint constraint_info
      join pg_class relation on relation.oid = constraint_info.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public'
    ) as constraint_count,
    (
      select count(*)
      from pg_constraint constraint_info
      join pg_class relation on relation.oid = constraint_info.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and constraint_info.contype = 'p'
    ) as primary_key_count,
    (
      select count(*)
      from pg_constraint constraint_info
      join pg_class relation on relation.oid = constraint_info.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and constraint_info.contype = 'f'
    ) as foreign_key_count,
    (
      select count(*)
      from pg_constraint constraint_info
      join pg_class relation on relation.oid = constraint_info.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and constraint_info.contype = 'u'
    ) as unique_constraint_count,
    (
      select count(*)
      from pg_constraint constraint_info
      join pg_class relation on relation.oid = constraint_info.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and constraint_info.contype = 'c'
    ) as check_constraint_count,
    (
      select count(*)
      from pg_index index_info
      join pg_class relation on relation.oid = index_info.indrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public'
    ) as index_count,
    (
      select count(*)
      from pg_index index_info
      join pg_class relation on relation.oid = index_info.indrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and index_info.indpred is not null
    ) as partial_index_count,
    (
      select count(*)
      from pg_index index_info
      join pg_class relation on relation.oid = index_info.indrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and index_info.indisunique
    ) as unique_index_count,
    (
      select count(*)
      from pg_trigger trigger_info
      join pg_class relation on relation.oid = trigger_info.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and not trigger_info.tgisinternal
    ) as trigger_count,
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public' and relation.relrowsecurity
    ) as rls_table_count,
    (
      select count(*)
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join expected_tables expected on expected.table_name = relation.relname
      where namespace.nspname = 'public'
    ) as policy_count,
    (
      select count(*)
      from pg_namespace
      where nspname in ('auth', 'storage', 'realtime', 'vault', 'net')
    ) as supabase_schema_count,
    case
      when to_regprocedure('public.update_inventory_timestamp()') is null then 0
      else 1
    end as inventory_function_count,
    case
      when to_regclass('getomerch_meta.schema_migrations') is null then 0
      else 1
    end as ledger_count
)
select
  'working_tables' as check_name,
  table_count = 43 as ok,
  table_count::text as actual,
  '43' as expected
from actual
union all
select 'working_columns', column_count = 563, column_count::text, '563'
from actual
union all
select 'working_defaults', default_count = 193, default_count::text, '193'
from actual
union all
select 'working_not_null', not_null_count = 322, not_null_count::text, '322'
from actual
union all
select 'working_constraints', constraint_count = 388, constraint_count::text, '388'
from actual
union all
select 'primary_keys', primary_key_count = 43, primary_key_count::text, '43'
from actual
union all
select 'foreign_keys', foreign_key_count = 84, foreign_key_count::text, '84'
from actual
union all
select
  'unique_constraints',
  unique_constraint_count = 31,
  unique_constraint_count::text,
  '31'
from actual
union all
select
  'check_constraints',
  check_constraint_count = 227,
  check_constraint_count::text,
  '227'
from actual
union all
select 'working_indexes', index_count = 159, index_count::text, '159'
from actual
union all
select 'partial_indexes', partial_index_count = 38, partial_index_count::text, '38'
from actual
union all
select 'unique_indexes', unique_index_count = 93, unique_index_count::text, '93'
from actual
union all
select 'working_triggers', trigger_count = 6, trigger_count::text, '6'
from actual
union all
select
  'inventory_timestamp_function',
  inventory_function_count = 1,
  inventory_function_count::text,
  '1'
from actual
union all
select 'migration_ledger', ledger_count = 1, ledger_count::text, '1'
from actual
union all
select 'rls_tables_removed', rls_table_count = 0, rls_table_count::text, '0'
from actual
union all
select 'policies_removed', policy_count = 0, policy_count::text, '0'
from actual
union all
select
  'supabase_schemas_removed',
  supabase_schema_count = 0,
  supabase_schema_count::text,
  '0'
from actual
order by check_name;
