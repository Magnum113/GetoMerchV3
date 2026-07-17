with recursive
expected_tables(table_name) as (
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
all_rows(table_name, payload) as materialized (
  select 'merch_warehouses', to_jsonb(t) from public.merch_warehouses t
  union all select 'merch_product_categories', to_jsonb(t) from public.merch_product_categories t
  union all select 'merch_fabric_types', to_jsonb(t) from public.merch_fabric_types t
  union all select 'merch_colors', to_jsonb(t) from public.merch_colors t
  union all select 'merch_sizes', to_jsonb(t) from public.merch_sizes t
  union all select 'merch_designs', to_jsonb(t) from public.merch_designs t
  union all select 'merch_decoration_types', to_jsonb(t) from public.merch_decoration_types t
  union all select 'merch_products', to_jsonb(t) from public.merch_products t
  union all select 'merch_inventory', to_jsonb(t) from public.merch_inventory t
  union all select 'merch_print_inventory', to_jsonb(t) from public.merch_print_inventory t
  union all select 'merch_transactions', to_jsonb(t) from public.merch_transactions t
  union all select 'merch_workshop_orders', to_jsonb(t) from public.merch_workshop_orders t
  union all select 'merch_workshop_order_items', to_jsonb(t) from public.merch_workshop_order_items t
  union all select 'merch_ozon_orders', to_jsonb(t) from public.merch_ozon_orders t
  union all select 'merch_ozon_order_items', to_jsonb(t) from public.merch_ozon_order_items t
  union all select 'merch_ozon_finance_operations', to_jsonb(t) from public.merch_ozon_finance_operations t
  union all select 'merch_expense_categories', to_jsonb(t) from public.merch_expense_categories t
  union all select 'merch_expenses', to_jsonb(t) from public.merch_expenses t
  union all select 'merch_ozon_import_runs', to_jsonb(t) from public.merch_ozon_import_runs t
  union all select 'merch_ozon_import_items', to_jsonb(t) from public.merch_ozon_import_items t
),
not_null_columns as (
  select c.table_name, c.column_name
  from information_schema.columns c
  join expected_tables e using (table_name)
  where c.table_schema = 'public'
    and c.is_nullable = 'NO'
),
not_null_checks as (
  select
    'not_null:' || c.table_name || '.' || c.column_name as check_name,
    count(*) filter (
      where r.payload is not null
        and coalesce(r.payload -> c.column_name, 'null'::jsonb) = 'null'::jsonb
    )::bigint as actual,
    0::bigint as expected
  from not_null_columns c
  left join all_rows r using (table_name)
  group by c.table_name, c.column_name
),
foreign_keys as (
  select
    con.conname,
    child.relname as child_table,
    parent.relname as parent_table,
    cardinality(con.conkey) as child_key_count,
    cardinality(con.confkey) as parent_key_count,
    child_attribute.attname as child_column,
    parent_attribute.attname as parent_column
  from pg_constraint con
  join pg_class child on child.oid = con.conrelid
  join pg_namespace child_namespace on child_namespace.oid = child.relnamespace
  join pg_class parent on parent.oid = con.confrelid
  join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
  left join pg_attribute child_attribute
    on child_attribute.attrelid = con.conrelid
   and child_attribute.attnum = con.conkey[1]
  left join pg_attribute parent_attribute
    on parent_attribute.attrelid = con.confrelid
   and parent_attribute.attnum = con.confkey[1]
  where con.contype = 'f'
    and child_namespace.nspname = 'public'
    and parent_namespace.nspname = 'public'
    and child.relname in (select table_name from expected_tables)
),
foreign_key_shape_checks as (
  select
    'foreign_key_shape:' || conname as check_name,
    case when child_key_count = 1 and parent_key_count = 1 then 0 else 1 end::bigint as actual,
    0::bigint as expected
  from foreign_keys
),
foreign_key_checks as (
  select
    'orphan:' || fk.conname as check_name,
    count(*) filter (
      where child.payload is not null
        and coalesce(child.payload -> fk.child_column, 'null'::jsonb) <> 'null'::jsonb
        and not exists (
          select 1
          from all_rows parent
          where parent.table_name = fk.parent_table
            and parent.payload -> fk.parent_column = child.payload -> fk.child_column
        )
    )::bigint as actual,
    0::bigint as expected
  from foreign_keys fk
  left join all_rows child on child.table_name = fk.child_table
  where fk.child_key_count = 1
    and fk.parent_key_count = 1
  group by fk.conname
),
static_checks(check_name, actual, expected) as (
  select 'working_table_count', count(*)::bigint, 20::bigint
  from pg_tables
  where schemaname = 'public' and tablename in (select table_name from expected_tables)
  union all
  select 'unexpected_merch_table_count', count(*)::bigint, 0::bigint
  from pg_tables
  where schemaname = 'public'
    and tablename like 'merch_%'
    and tablename not in (select table_name from expected_tables)
  union all
  select 'public_sequence_count', count(*)::bigint, 0::bigint
  from information_schema.sequences
  where sequence_schema = 'public'
  union all
  select 'unvalidated_constraint_count', count(*)::bigint, 0::bigint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace namespace on namespace.oid = rel.relnamespace
  where namespace.nspname = 'public'
    and rel.relname in (select table_name from expected_tables)
    and not con.convalidated
  union all
  select 'negative_product_inventory', count(*)::bigint, 0::bigint
  from public.merch_inventory where quantity < 0
  union all
  select 'negative_print_inventory', count(*)::bigint, 0::bigint
  from public.merch_print_inventory where quantity < 0
  union all
  select 'duplicate_product_sku', count(*)::bigint, 0::bigint
  from (
    select sku from public.merch_products
    where sku is not null group by sku having count(*) > 1
  ) duplicate
  union all
  select 'duplicate_product_ozon_sku', count(*)::bigint, 0::bigint
  from (
    select ozon_sku from public.merch_products
    where ozon_sku is not null group by ozon_sku having count(*) > 1
  ) duplicate
  union all
  select 'duplicate_posting_number', count(*)::bigint, 0::bigint
  from (
    select posting_number from public.merch_ozon_orders
    group by posting_number having count(*) > 1
  ) duplicate
  union all
  select 'duplicate_finance_operation', count(*)::bigint, 0::bigint
  from (
    select operation_id from public.merch_ozon_finance_operations
    group by operation_id having count(*) > 1
  ) duplicate
  union all
  select 'nonpositive_ozon_item_quantity', count(*)::bigint, 0::bigint
  from public.merch_ozon_order_items where quantity <= 0
  union all
  select 'nonpositive_workshop_item_quantity', count(*)::bigint, 0::bigint
  from public.merch_workshop_order_items where quantity <= 0
)
select check_name, actual = expected as ok, actual::text, expected::text
from (
  select * from static_checks
  union all select * from not_null_checks
  union all select * from foreign_key_shape_checks
  union all select * from foreign_key_checks
) checks
order by check_name;
