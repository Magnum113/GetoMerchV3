DO $check$
BEGIN
  IF has_function_privilege(
    'getomerch_app',
    'getomerch_marking.reconcile_introduction_submission(uuid,text,text,jsonb,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'web application must not execute CRPT introduction reconciliation';
  END IF;
  IF NOT has_function_privilege(
    'getomerch_marking_worker',
    'getomerch_marking.reconcile_introduction_submission(uuid,text,text,jsonb,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'isolated marking worker cannot execute CRPT introduction reconciliation';
  END IF;
  IF NOT has_schema_privilege(
    'getomerch_marking_worker', 'getomerch_marking', 'USAGE'
  ) THEN
    RAISE EXCEPTION 'isolated marking worker cannot access the marking schema';
  END IF;
END
$check$;
