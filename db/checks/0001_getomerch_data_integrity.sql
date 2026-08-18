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
    ('merch_marking_signing_agents'),
    ('merch_marking_agent_nonces'),
    ('merch_marking_signature_requests'),
    ('merch_marking_documents'),
    ('merch_marking_document_codes'),
    ('merch_marking_document_confirmations'),
    ('merch_marking_shipping_gate_evaluations'),
    ('merch_marking_handovers'),
    ('merch_marking_handover_units'),
    ('merch_marking_withdrawal_confirmations'),
    ('merch_marking_return_cases'),
    ('merch_marking_return_case_events'),
    ('merch_marking_return_confirmations'),
    ('merch_marking_code_orders'),
    ('merch_marking_code_order_items'),
    ('merch_ozon_finance_operations'),
    ('merch_expense_categories'),
    ('merch_expenses'),
    ('merch_ozon_import_runs'),
    ('merch_ozon_import_items'),
    ('merch_admin_feature_flags')
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
  union all select 'merch_fulfillment_orders', to_jsonb(t) from public.merch_fulfillment_orders t
  union all select 'merch_fulfillment_order_items', to_jsonb(t) from public.merch_fulfillment_order_items t
  union all select 'merch_fulfillment_events', to_jsonb(t) from public.merch_fulfillment_events t
  union all select 'merch_marking_trade_items', to_jsonb(t) from public.merch_marking_trade_items t
  union all select 'merch_marking_trade_item_documents', to_jsonb(t) from public.merch_marking_trade_item_documents t
  union all select 'merch_marking_product_profiles', to_jsonb(t) from public.merch_marking_product_profiles t
  union all select 'merch_marking_locations', to_jsonb(t) from public.merch_marking_locations t
  union all select 'merch_marking_processes', to_jsonb(t) from public.merch_marking_processes t
  union all select 'merch_marking_evidence', to_jsonb(t) from public.merch_marking_evidence t
  union all select 'merch_marking_events', to_jsonb(t) from public.merch_marking_events t
  union all select 'merch_marking_product_profile_channels', to_jsonb(t) from public.merch_marking_product_profile_channels t
  union all select 'merch_marking_profile_backfill_runs', to_jsonb(t) from public.merch_marking_profile_backfill_runs t
  union all select 'merch_marking_profile_backfill_items', to_jsonb(t) from public.merch_marking_profile_backfill_items t
  union all select 'merch_marking_import_batches', to_jsonb(t) from public.merch_marking_import_batches t
  union all select 'merch_marking_import_rows', to_jsonb(t) from public.merch_marking_import_rows t
  union all select 'merch_marking_codes', to_jsonb(t) from public.merch_marking_codes t
  union all select 'merch_marking_code_hmacs', to_jsonb(t) from public.merch_marking_code_hmacs t
  union all select 'merch_marking_units', to_jsonb(t) from public.merch_marking_units t
  union all select 'merch_marking_code_bindings', to_jsonb(t) from public.merch_marking_code_bindings t
  union all select 'merch_marking_assignments', to_jsonb(t) from public.merch_marking_assignments t
  union all select 'merch_marking_ozon_submission_batches', to_jsonb(t) from public.merch_marking_ozon_submission_batches t
  union all select 'merch_marking_ozon_submissions', to_jsonb(t) from public.merch_marking_ozon_submissions t
  union all select 'merch_marking_crpt_queries', to_jsonb(t) from public.merch_marking_crpt_queries t
  union all select 'merch_marking_signing_agents', to_jsonb(t) from public.merch_marking_signing_agents t
  union all select 'merch_marking_agent_nonces', to_jsonb(t) from public.merch_marking_agent_nonces t
  union all select 'merch_marking_signature_requests', to_jsonb(t) from public.merch_marking_signature_requests t
  union all select 'merch_marking_documents', to_jsonb(t) from public.merch_marking_documents t
  union all select 'merch_marking_document_codes', to_jsonb(t) from public.merch_marking_document_codes t
  union all select 'merch_marking_document_confirmations', to_jsonb(t) from public.merch_marking_document_confirmations t
  union all select 'merch_marking_shipping_gate_evaluations', to_jsonb(t) from public.merch_marking_shipping_gate_evaluations t
  union all select 'merch_marking_handovers', to_jsonb(t) from public.merch_marking_handovers t
  union all select 'merch_marking_handover_units', to_jsonb(t) from public.merch_marking_handover_units t
  union all select 'merch_marking_withdrawal_confirmations', to_jsonb(t) from public.merch_marking_withdrawal_confirmations t
  union all select 'merch_marking_return_cases', to_jsonb(t) from public.merch_marking_return_cases t
  union all select 'merch_marking_return_case_events', to_jsonb(t) from public.merch_marking_return_case_events t
  union all select 'merch_marking_return_confirmations', to_jsonb(t) from public.merch_marking_return_confirmations t
  union all select 'merch_marking_code_orders', to_jsonb(t) from public.merch_marking_code_orders t
  union all select 'merch_marking_code_order_items', to_jsonb(t) from public.merch_marking_code_order_items t
  union all select 'merch_ozon_finance_operations', to_jsonb(t) from public.merch_ozon_finance_operations t
  union all select 'merch_expense_categories', to_jsonb(t) from public.merch_expense_categories t
  union all select 'merch_expenses', to_jsonb(t) from public.merch_expenses t
  union all select 'merch_ozon_import_runs', to_jsonb(t) from public.merch_ozon_import_runs t
  union all select 'merch_ozon_import_items', to_jsonb(t) from public.merch_ozon_import_items t
  union all select 'merch_admin_feature_flags', to_jsonb(t) from public.merch_admin_feature_flags t
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
    case
      when child_key_count = 1 and parent_key_count = 1 then 0
      when conname = 'merch_fulfillment_events_item_order_fkey'
        and child_key_count = 2
        and parent_key_count = 2
      then 0
      when conname = 'merch_marking_processes_item_order_fkey'
        and child_key_count = 2
        and parent_key_count = 2
      then 0
      when conname in (
        'merch_marking_assignments_unit_profile_fkey',
        'merch_marking_assignments_binding_unit_fkey'
      )
        and child_key_count = 2
        and parent_key_count = 2
      then 0
      else 1
    end::bigint as actual,
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
  select 'working_table_count', count(*)::bigint,
    (select count(*)::bigint from expected_tables)
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
