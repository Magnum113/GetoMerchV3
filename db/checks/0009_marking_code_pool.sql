with actual as (
  select
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind = 'r'
        and relation.relname in (
          'merch_marking_import_batches',
          'merch_marking_import_rows',
          'merch_marking_codes',
          'merch_marking_code_hmacs'
        )
    ) as table_count,
    (
      select count(*)
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'getomerch_marking'
        and relation.relkind = 'v'
        and relation.relname in (
          'code_pool_safe',
          'import_batches_safe',
          'import_rows_safe'
        )
    ) as view_count,
    (
      select count(*)
      from unnest(array[
        'getomerch_marking.is_valid_hmac_set(jsonb)',
        'getomerch_marking.create_code_import_preview(text,text,text,text,bigint,text,text,jsonb,text)',
        'getomerch_marking.apply_code_import(uuid,text)',
        'getomerch_marking.quarantine_code(uuid,bigint,text,text)',
        'getomerch_marking.release_quarantined_code(uuid,bigint,text,boolean,text)',
        'getomerch_marking.scrub_expired_code_imports(integer)'
      ]) function_name
      where to_regprocedure(function_name) is not null
    ) as function_count,
    (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'merch_marking_import_batches',
          'merch_marking_import_rows',
          'merch_marking_codes',
          'merch_marking_code_hmacs'
        )
        and column_name ~ '(plaintext|full_code|raw_code|crypto_tail)'
    ) as plaintext_column_count,
    (
      select count(*)
      from public.merch_marking_import_rows row_data
      join public.merch_marking_import_batches batch
        on batch.id = row_data.batch_id
      where batch.status in ('applied', 'expired')
        and (
          row_data.code_ciphertext is not null
          or row_data.code_nonce is not null
          or row_data.code_auth_tag is not null
          or row_data.code_hmac is not null
          or row_data.dedup_hmacs <> '[]'::jsonb
        )
    ) as stale_staging_count,
    (
      select count(*)
      from public.merch_marking_codes code
      where not exists (
        select 1
        from public.merch_marking_code_hmacs alias
        where alias.marking_code_id = code.id
          and alias.hmac_key_version = code.hmac_key_version
          and alias.code_hmac = code.code_hmac
      )
    ) as missing_primary_alias_count,
    (
      select count(*)
      from public.merch_marking_codes
      where acquisition_mode = 'supplier_marked_import'
        and pool_state = 'available'
    ) as unsafe_supplier_pool_count,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_codes',
      'SELECT,INSERT,UPDATE,DELETE'
    ) as app_code_base_access,
    has_table_privilege(
      'getomerch_app',
      'public.merch_marking_import_rows',
      'SELECT,INSERT,UPDATE,DELETE'
    ) as app_row_base_access,
    has_table_privilege(
      'getomerch_app',
      'getomerch_marking.code_pool_safe',
      'SELECT'
    ) as app_pool_view_access,
    has_table_privilege(
      'getomerch_app',
      'getomerch_marking.import_batches_safe',
      'SELECT'
    ) as app_import_view_access,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.create_code_import_preview(text,text,text,text,bigint,text,text,jsonb,text)',
      'EXECUTE'
    ) as app_preview_execute,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.apply_code_import(uuid,text)',
      'EXECUTE'
    ) as app_apply_execute
)
select 'marking_stage5_tables' as check_name,
  table_count = 4 as ok, table_count::text as actual, '4' as expected
from actual
union all
select 'marking_stage5_safe_views',
  view_count = 3, view_count::text, '3'
from actual
union all
select 'marking_stage5_functions',
  function_count = 6, function_count::text, '6'
from actual
union all
select 'marking_stage5_no_plaintext_columns',
  plaintext_column_count = 0, plaintext_column_count::text, '0'
from actual
union all
select 'marking_stage5_staging_scrubbed',
  stale_staging_count = 0, stale_staging_count::text, '0'
from actual
union all
select 'marking_stage5_hmac_alias_coverage',
  missing_primary_alias_count = 0, missing_primary_alias_count::text, '0'
from actual
union all
select 'marking_stage5_supplier_pool_isolation',
  unsafe_supplier_pool_count = 0, unsafe_supplier_pool_count::text, '0'
from actual
union all
select 'marking_stage5_app_no_base_access',
  not app_code_base_access and not app_row_base_access,
  concat('codes=', app_code_base_access, ',rows=', app_row_base_access),
  'codes=false,rows=false'
from actual
union all
select 'marking_stage5_app_safe_read',
  app_pool_view_access and app_import_view_access,
  concat('pool=', app_pool_view_access, ',imports=', app_import_view_access),
  'pool=true,imports=true'
from actual
union all
select 'marking_stage5_app_commands',
  app_preview_execute and app_apply_execute,
  concat('preview=', app_preview_execute, ',apply=', app_apply_execute),
  'preview=true,apply=true'
from actual
order by check_name;
