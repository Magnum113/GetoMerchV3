DO $check$
BEGIN
  IF to_regprocedure(
    'getomerch_marking.upsert_trade_item_conformity_document(uuid,bigint,text,text,date,date,text,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'conformity document mutation is missing';
  END IF;
  IF to_regprocedure(
    'getomerch_marking.reconcile_introduction_submission(uuid,text,text,jsonb,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'introduction reconciliation is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'merch_marking_trade_item_documents'
      AND column_name = 'verified_by'
  ) THEN
    RAISE EXCEPTION 'conformity verification actor column is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'getomerch_marking'
      AND routine.proname = 'get_introduction_document_material'
      AND pg_get_function_result(routine.oid) LIKE '%conformity_documents jsonb%'
  ) THEN
    RAISE EXCEPTION 'introduction material does not expose conformity documents';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'getomerch_marking'
      AND routine.proname = 'protect_marking_document'
      AND pg_get_functiondef(routine.oid) LIKE '%crpt_submit_outcome_unknown%'
  ) THEN
    RAISE EXCEPTION 'ambiguous introduction reconciliation transition is missing';
  END IF;
END
$check$;
