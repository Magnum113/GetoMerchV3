with expected_tables(table_name) as (
  values
    ('merch_marking_trade_items'),
    ('merch_marking_trade_item_documents'),
    ('merch_marking_product_profiles'),
    ('merch_marking_locations'),
    ('merch_marking_processes'),
    ('merch_marking_evidence'),
    ('merch_marking_events')
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
      from pg_trigger trigger_info
      join pg_class relation on relation.oid = trigger_info.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname in (
          'merch_marking_trade_items',
          'merch_marking_product_profiles',
          'merch_marking_evidence'
        )
        and not trigger_info.tgisinternal
    ) as readiness_trigger_count,
    to_regprocedure(
      'getomerch_marking.create_process(text,uuid,uuid,text,text,integer,text,text,timestamp with time zone,text,text)'
    ) is not null as create_function_exists,
    to_regprocedure(
      'getomerch_marking.transition_process(uuid,bigint,text,text,text,timestamp with time zone,text,text,text,text,text,text)'
    ) is not null as transition_function_exists,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.create_process(text,uuid,uuid,text,text,integer,text,text,timestamp with time zone,text,text)',
      'EXECUTE'
    ) as app_create_execute,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.transition_process(uuid,bigint,text,text,text,timestamp with time zone,text,text,text,text,text,text)',
      'EXECUTE'
    ) as app_transition_execute
)
select
  'marking_core_tables' as check_name,
  table_count = 7 as ok,
  table_count::text as actual,
  '7' as expected
from actual
union all
select
  'marking_readiness_triggers',
  readiness_trigger_count = 3,
  readiness_trigger_count::text,
  '3'
from actual
union all
select
  'marking_create_function',
  create_function_exists,
  create_function_exists::text,
  'true'
from actual
union all
select
  'marking_transition_function',
  transition_function_exists,
  transition_function_exists::text,
  'true'
from actual
union all
select
  'marking_app_function_access',
  app_create_execute and app_transition_execute,
  (app_create_execute and app_transition_execute)::text,
  'true'
from actual
union all
select
  'marking_app_read_only_tables',
  (
    select bool_and(
      has_table_privilege('getomerch_app', format('public.%I', table_name), 'SELECT')
      and not has_table_privilege(
        'getomerch_app',
        format('public.%I', table_name),
        'INSERT,UPDATE,DELETE,TRUNCATE'
      )
    )
    from expected_tables
  ),
  'true',
  'true'
union all
select
  'marking_backup_read',
  (
    select bool_and(
      has_table_privilege('getomerch_backup', format('public.%I', table_name), 'SELECT')
    )
    from expected_tables
  ),
  'true',
  'true'
union all
select
  'marking_gtin_check_digit',
  getomerch_marking.is_valid_gtin14('04628837736075')
    and not getomerch_marking.is_valid_gtin14('04628837736074')
    and not getomerch_marking.is_valid_gtin14('00000000000000'),
  'true',
  'true'
union all
select
  'marking_events_append_only',
  not has_table_privilege(
    'getomerch_app',
    'public.merch_marking_events',
    'INSERT,UPDATE,DELETE,TRUNCATE'
  ),
  'true',
  'true'
union all
select
  'marking_document_event_integrity',
  not exists (
    select 1
    from public.merch_marking_events event
    left join public.merch_marking_documents document
      on document.id = event.document_id
    where event.document_id is not null and document.id is null
  ),
  'true',
  'true'
union all
select
  'marking_verified_profiles_ready',
  not exists (
    select 1
    from public.merch_marking_product_profiles profile
    left join public.merch_marking_trade_items trade_item
      on trade_item.id = profile.trade_item_id
    where profile.archived_at is null
      and profile.requires_marking
      and profile.verification_status = 'verified'
      and (
        trade_item.id is null
        or trade_item.archived_at is not null
        or trade_item.verification_status <> 'verified'
        or not exists (
          select 1
          from public.merch_marking_evidence evidence
          where evidence.product_profile_id = profile.id
            and evidence.evidence_type = 'product_profile_mapping'
            and evidence.verification_status = 'verified'
        )
      )
  ),
  'true',
  'true'
order by check_name;
