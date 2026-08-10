select
  'fulfillment_tables_exist' as check_name,
  to_regclass('public.merch_fulfillment_orders') is not null
    and to_regclass('public.merch_fulfillment_order_items') is not null
    and to_regclass('public.merch_fulfillment_events') is not null as ok,
  concat_ws(
    ',',
    to_regclass('public.merch_fulfillment_orders')::text,
    to_regclass('public.merch_fulfillment_order_items')::text,
    to_regclass('public.merch_fulfillment_events')::text
  ) as actual,
  'merch_fulfillment_orders,merch_fulfillment_order_items,merch_fulfillment_events'
    as expected
union all
select
  'ozon_item_source_keys_complete',
  not exists (
    select 1
    from public.merch_ozon_order_items
    where source_item_key is null or source_item_key = ''
  ),
  (
    select count(*)::text
    from public.merch_ozon_order_items
    where source_item_key is null or source_item_key = ''
  ),
  '0'
union all
select
  'ozon_item_source_keys_unique',
  not exists (
    select 1
    from public.merch_ozon_order_items
    group by order_id, source_item_key
    having count(*) > 1
  ),
  (
    select count(*)::text
    from (
      select 1
      from public.merch_ozon_order_items
      group by order_id, source_item_key
      having count(*) > 1
    ) duplicates
  ),
  '0'
union all
select
  'fbo_has_no_fulfillment',
  not exists (
    select 1
    from public.merch_ozon_orders
    where source = 'fbo' and fulfillment_order_id is not null
  ),
  (
    select count(*)::text
    from public.merch_ozon_orders
    where source = 'fbo' and fulfillment_order_id is not null
  ),
  '0'
union all
select
  'fulfillment_source_excludes_fbo',
  not exists (
    select 1
    from public.merch_fulfillment_orders
    where source_channel not in ('ozon_fbs', 'komui')
  ),
  (
    select count(*)::text
    from public.merch_fulfillment_orders
    where source_channel not in ('ozon_fbs', 'komui')
  ),
  '0'
union all
select
  'fulfillment_quantities_positive',
  not exists (
    select 1
    from public.merch_fulfillment_order_items
    where quantity <= 0
  ),
  (
    select count(*)::text
    from public.merch_fulfillment_order_items
    where quantity <= 0
  ),
  '0'
union all
select
  'fulfillment_events_are_objects',
  not exists (
    select 1
    from public.merch_fulfillment_events
    where jsonb_typeof(details) <> 'object'
  ),
  (
    select count(*)::text
    from public.merch_fulfillment_events
    where jsonb_typeof(details) <> 'object'
  ),
  '0'
union all
select
  'fulfillment_app_entity_access',
  has_table_privilege(
    'getomerch_app',
    'public.merch_fulfillment_orders',
    'SELECT'
  )
    and has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_orders',
      'INSERT'
    )
    and has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_orders',
      'UPDATE'
    )
    and has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_order_items',
      'SELECT'
    )
    and has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_order_items',
      'INSERT'
    )
    and has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_order_items',
      'UPDATE'
    )
    and not has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_orders',
      'DELETE'
    )
    and not has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_order_items',
      'DELETE'
    ),
  'true',
  'true'
union all
select
  'fulfillment_events_append_only',
  has_table_privilege(
    'getomerch_app',
    'public.merch_fulfillment_events',
    'SELECT'
  )
    and has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_events',
      'INSERT'
    )
    and not has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_events',
      'UPDATE'
    )
    and not has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_events',
      'DELETE'
    )
    and not has_table_privilege(
      'getomerch_app',
      'public.merch_fulfillment_events',
      'TRUNCATE'
    ),
  'true',
  'true';
