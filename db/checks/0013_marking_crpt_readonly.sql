WITH actual AS (
  SELECT
    to_regclass('public.merch_marking_crpt_queries') IS NOT NULL AS table_exists,
    to_regclass('getomerch_marking.crpt_query_safe') IS NOT NULL AS view_exists,
    to_regprocedure('getomerch_marking.create_crpt_read_query(text,uuid,text,text,uuid)')
      IS NOT NULL AS create_function_exists,
    to_regprocedure('getomerch_marking.claim_crpt_read_query(uuid,text)')
      IS NOT NULL AS claim_function_exists,
    to_regprocedure('getomerch_marking.record_crpt_read_success(uuid,text,text,jsonb,boolean,boolean)')
      IS NOT NULL AS success_function_exists,
    to_regprocedure('getomerch_marking.record_crpt_read_failure(uuid,text,text)')
      IS NOT NULL AS failure_function_exists,
    to_regprocedure('getomerch_jobs.append_marking_job_event(uuid,text,text,jsonb)')
      IS NOT NULL AS event_function_exists,
    has_table_privilege(
      'getomerch_app', 'public.merch_marking_crpt_queries',
      'SELECT,INSERT,UPDATE,DELETE'
    ) AS app_base_access,
    has_table_privilege(
      'getomerch_app', 'getomerch_marking.crpt_query_safe', 'SELECT'
    ) AS app_safe_read,
    has_function_privilege(
      'getomerch_app',
      'getomerch_marking.claim_crpt_read_query(uuid,text)', 'EXECUTE'
    ) AS app_claim_execute,
    EXISTS (
      SELECT 1
      FROM pg_constraint AS job_constraint
      WHERE job_constraint.conrelid = 'getomerch_jobs.jobs'::regclass
        AND job_constraint.conname = 'jobs_type_check'
        AND pg_get_constraintdef(job_constraint.oid)
          LIKE '%marking_crpt_code_status_sync%'
    ) AS code_job_registered
)
SELECT 'marking_stage9_objects' AS check_name,
  table_exists AND view_exists AND create_function_exists
    AND claim_function_exists AND success_function_exists AND failure_function_exists
    AND event_function_exists AS ok,
  concat('table=', table_exists, ',view=', view_exists,
    ',create=', create_function_exists, ',claim=', claim_function_exists,
    ',success=', success_function_exists, ',failure=', failure_function_exists,
    ',event=', event_function_exists) AS actual,
  'all=true' AS expected
FROM actual
UNION ALL
SELECT 'marking_stage9_acl',
  NOT app_base_access AND app_safe_read AND app_claim_execute,
  concat('base=', app_base_access, ',safe=', app_safe_read, ',claim=', app_claim_execute),
  'base=false,safe=true,claim=true'
FROM actual
UNION ALL
SELECT 'marking_stage9_job_contract', code_job_registered,
  code_job_registered::text, 'true'
FROM actual
ORDER BY check_name;
