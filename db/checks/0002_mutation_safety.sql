with actual as (
  select
    to_regnamespace('getomerch_audit') is not null as schema_exists,
    to_regclass('getomerch_audit.operation_requests') is not null as requests_exists,
    to_regclass('getomerch_audit.audit_log') is not null as audit_exists,
    (
      select count(*)
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'getomerch_audit' and c.contype in ('p', 'c')
    ) as constraint_count,
    (
      select count(*)
      from pg_index i
      join pg_class r on r.oid = i.indrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'getomerch_audit'
    ) as index_count,
    has_schema_privilege('getomerch_app', 'getomerch_audit', 'USAGE') as app_schema_usage,
    has_table_privilege('getomerch_app', 'getomerch_audit.operation_requests', 'SELECT,INSERT,UPDATE') as app_request_access,
    not has_table_privilege('getomerch_app', 'getomerch_audit.operation_requests', 'DELETE') as app_request_no_delete,
    has_table_privilege('getomerch_app', 'getomerch_audit.audit_log', 'SELECT,INSERT') as app_audit_access,
    not has_table_privilege('getomerch_app', 'getomerch_audit.audit_log', 'UPDATE,DELETE') as app_audit_append_only
)
select
  'mutation_audit_schema' as check_name,
  schema_exists as ok,
  schema_exists::text as actual,
  'true' as expected
from actual
union all
select 'mutation_request_table', requests_exists, requests_exists::text, 'true' from actual
union all
select 'mutation_audit_table', audit_exists, audit_exists::text, 'true' from actual
union all
select 'mutation_constraints', constraint_count = 7, constraint_count::text, '7' from actual
union all
select 'mutation_indexes', index_count = 7, index_count::text, '7' from actual
union all
select 'mutation_app_schema_usage', app_schema_usage, app_schema_usage::text, 'true' from actual
union all
select 'mutation_app_request_access', app_request_access, app_request_access::text, 'true' from actual
union all
select 'mutation_app_request_no_delete', app_request_no_delete, app_request_no_delete::text, 'true' from actual
union all
select 'mutation_app_audit_access', app_audit_access, app_audit_access::text, 'true' from actual
union all
select 'mutation_app_audit_append_only', app_audit_append_only, app_audit_append_only::text, 'true' from actual
order by check_name;
