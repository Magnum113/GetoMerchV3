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
  table_count = 20 as ok,
  table_count::text as actual,
  '20' as expected
from actual
union all
select 'working_columns', column_count = 178, column_count::text, '178'
from actual
union all
select 'working_defaults', default_count = 60, default_count::text, '60'
from actual
union all
select 'working_not_null', not_null_count = 90, not_null_count::text, '90'
from actual
union all
select 'working_constraints', constraint_count = 82, constraint_count::text, '82'
from actual
union all
select 'primary_keys', primary_key_count = 20, primary_key_count::text, '20'
from actual
union all
select 'foreign_keys', foreign_key_count = 32, foreign_key_count::text, '32'
from actual
union all
select
  'unique_constraints',
  unique_constraint_count = 14,
  unique_constraint_count::text,
  '14'
from actual
union all
select
  'check_constraints',
  check_constraint_count = 16,
  check_constraint_count::text,
  '16'
from actual
union all
select 'working_indexes', index_count = 65, index_count::text, '65'
from actual
union all
select 'partial_indexes', partial_index_count = 5, partial_index_count::text, '5'
from actual
union all
select 'unique_indexes', unique_index_count = 38, unique_index_count::text, '38'
from actual
union all
select 'working_triggers', trigger_count = 1, trigger_count::text, '1'
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
