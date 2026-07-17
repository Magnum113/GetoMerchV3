with actual as (
  select
    to_regnamespace('getomerch_jobs') is not null as schema_exists,
    to_regclass('getomerch_jobs.jobs') is not null as jobs_exists,
    to_regclass('getomerch_jobs.job_events') is not null as events_exists,
    (
      select count(*)
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'getomerch_jobs' and c.contype in ('p', 'u', 'f', 'c')
    ) as constraint_count,
    (
      select count(*)
      from pg_index i
      join pg_class r on r.oid = i.indrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'getomerch_jobs'
    ) as index_count,
    has_schema_privilege('getomerch_app', 'getomerch_jobs', 'USAGE') as app_schema_usage,
    has_table_privilege('getomerch_app', 'getomerch_jobs.jobs', 'SELECT,INSERT,UPDATE') as app_job_access,
    not has_table_privilege('getomerch_app', 'getomerch_jobs.jobs', 'DELETE') as app_job_no_delete,
    has_table_privilege('getomerch_app', 'getomerch_jobs.job_events', 'SELECT,INSERT') as app_event_access,
    not has_table_privilege('getomerch_app', 'getomerch_jobs.job_events', 'UPDATE,DELETE') as app_event_append_only,
    has_table_privilege('getomerch_backup', 'getomerch_jobs.jobs', 'SELECT') as backup_job_read,
    has_table_privilege('getomerch_backup', 'getomerch_jobs.job_events', 'SELECT') as backup_event_read,
    has_function_privilege(
      'getomerch_app',
      'getomerch_jobs.prune_finished_jobs(interval, integer)',
      'EXECUTE'
    ) as app_prune_execute
)
select
  'jobs_schema' as check_name,
  schema_exists as ok,
  schema_exists::text as actual,
  'true' as expected
from actual
union all
select 'jobs_table', jobs_exists, jobs_exists::text, 'true' from actual
union all
select 'job_events_table', events_exists, events_exists::text, 'true' from actual
union all
select 'jobs_constraints', constraint_count = 13, constraint_count::text, '13' from actual
union all
select 'jobs_indexes', index_count = 8, index_count::text, '8' from actual
union all
select 'jobs_app_schema_usage', app_schema_usage, app_schema_usage::text, 'true' from actual
union all
select 'jobs_app_access', app_job_access, app_job_access::text, 'true' from actual
union all
select 'jobs_app_no_delete', app_job_no_delete, app_job_no_delete::text, 'true' from actual
union all
select 'job_events_app_access', app_event_access, app_event_access::text, 'true' from actual
union all
select 'job_events_append_only', app_event_append_only, app_event_append_only::text, 'true' from actual
union all
select 'jobs_backup_read', backup_job_read, backup_job_read::text, 'true' from actual
union all
select 'job_events_backup_read', backup_event_read, backup_event_read::text, 'true' from actual
union all
select 'jobs_app_prune_execute', app_prune_execute, app_prune_execute::text, 'true' from actual
order by check_name;
