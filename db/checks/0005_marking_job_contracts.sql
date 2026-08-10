with job_type_constraint as (
  select pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'getomerch_jobs'
    and r.relname = 'jobs'
    and c.conname = 'jobs_type_check'
),
expected(type) as (
  values
    ('ozon_orders_sync'),
    ('ozon_finance_sync'),
    ('ozon_prices_sync'),
    ('ozon_import_preview'),
    ('ozon_import_apply'),
    ('marking_prepare_assignment'),
    ('marking_ozon_validate'),
    ('marking_ozon_submit'),
    ('marking_ozon_poll'),
    ('marking_crpt_auth_refresh'),
    ('marking_crpt_application_submit'),
    ('marking_crpt_introduction_submit'),
    ('marking_crpt_document_poll'),
    ('marking_withdrawal_submit'),
    ('marking_return_to_circulation_submit'),
    ('marking_returns_sync'),
    ('marking_reconcile'),
    ('marking_suz_order_submit'),
    ('marking_suz_order_poll')
),
missing as (
  select expected.type
  from expected
  cross join job_type_constraint
  where position(quote_literal(expected.type) in job_type_constraint.definition) = 0
)
select
  'marking_job_type_constraint_exists' as check_name,
  exists(select 1 from job_type_constraint) as ok,
  exists(select 1 from job_type_constraint)::text as actual,
  'true' as expected
union all
select
  'marking_job_types_registered',
  not exists(select 1 from missing),
  coalesce((select string_agg(type, ', ' order by type) from missing), 'none'),
  'none'
union all
select
  'marking_jobs_view_exists',
  to_regclass('getomerch_jobs.marking_jobs') is not null,
  coalesce(to_regclass('getomerch_jobs.marking_jobs')::text, 'missing'),
  'getomerch_jobs.marking_jobs';
