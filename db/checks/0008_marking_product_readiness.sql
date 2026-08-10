with actual as (
  select
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind = 'r'
        and relation.relname in (
          'merch_marking_product_profile_channels',
          'merch_marking_profile_backfill_runs',
          'merch_marking_profile_backfill_items'
        )
    ) as table_count,
    (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'merch_marking_product_profiles'
        and column_name in (
          'marking_requirement',
          'marking_requirement_source',
          'marking_requirement_observed_at',
          'operational_status',
          'operational_status_reason',
          'operational_changed_at',
          'operational_changed_by',
          'revision'
        )
    ) as profile_column_count,
    (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'merch_marking_trade_items'
        and column_name in (
          'declared_product_type',
          'declared_fabric',
          'declared_color',
          'declared_size_int',
          'declared_size_ru',
          'declared_composition'
        )
    ) as trade_attribute_count,
    (
      select count(*)
      from unnest(array[
        'getomerch_marking.upsert_product_profile_draft(uuid,bigint,text,text,timestamp with time zone,text,text,text,text,text,text,text,text,text)',
        'getomerch_marking.verify_trade_item_and_profile(uuid,bigint,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
        'getomerch_marking.attach_product_profile_evidence(uuid,bigint,text,text,text,jsonb,text,jsonb,text,text,text)',
        'getomerch_marking.set_product_profile_operational_status(uuid,bigint,text,text,text,text)',
        'getomerch_marking.create_profile_backfill_preview(text,jsonb,jsonb,text)',
        'getomerch_marking.apply_profile_backfill(uuid,text)'
      ]) function_name
      where to_regprocedure(function_name) is not null
    ) as function_count,
    (
      select count(*)
      from public.merch_marking_product_profiles
      where archived_at is null
        and operational_status = 'enabled'
        and marking_requirement = 'unknown'
    ) as enabled_unknown_count,
    (
      select count(*)
      from public.merch_marking_profile_backfill_items item
      join public.merch_marking_product_profiles profile
        on profile.id = item.applied_profile_id
      where item.apply_status = 'applied'
        and (
          profile.operational_status <> 'draft'
          or profile.trade_item_id is not null
          or profile.verification_status <> 'draft'
        )
    ) as unsafe_backfill_count,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_product_profile_channels',
      'INSERT,UPDATE,DELETE'
    ) as app_channel_write,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_profile_backfill_runs',
      'INSERT,UPDATE,DELETE'
    ) as app_backfill_write,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.upsert_product_profile_draft(uuid,bigint,text,text,timestamp with time zone,text,text,text,text,text,text,text,text,text)',
      'EXECUTE'
    ) as app_upsert_execute,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.apply_profile_backfill(uuid,text)',
      'EXECUTE'
    ) as app_backfill_execute
)
select 'marking_stage4_tables' as check_name,
  table_count = 3 as ok, table_count::text as actual, '3' as expected
from actual
union all
select 'marking_stage4_profile_columns',
  profile_column_count = 8, profile_column_count::text, '8'
from actual
union all
select 'marking_stage4_trade_attributes',
  trade_attribute_count = 6, trade_attribute_count::text, '6'
from actual
union all
select 'marking_stage4_functions',
  function_count = 6, function_count::text, '6'
from actual
union all
select 'marking_stage4_no_enabled_unknown',
  enabled_unknown_count = 0, enabled_unknown_count::text, '0'
from actual
union all
select 'marking_stage4_safe_backfill',
  unsafe_backfill_count = 0, unsafe_backfill_count::text, '0'
from actual
union all
select 'marking_stage4_app_no_direct_write',
  not app_channel_write and not app_backfill_write,
  concat('channel=', app_channel_write, ',backfill=', app_backfill_write),
  'channel=false,backfill=false'
from actual
union all
select 'marking_stage4_app_commands',
  app_upsert_execute and app_backfill_execute,
  concat('upsert=', app_upsert_execute, ',backfill=', app_backfill_execute),
  'upsert=true,backfill=true'
from actual
order by check_name;
