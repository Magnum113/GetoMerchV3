-- Keep remote CRPT reconciliation inside the isolated marking worker. The web
-- application may enqueue the request but cannot attach a remote document to a
-- local introduction without the worker's signer-backed verification.

REVOKE EXECUTE ON FUNCTION getomerch_marking.reconcile_introduction_submission(
  uuid,text,text,jsonb,text,text,text
) FROM getomerch_app;

GRANT USAGE ON SCHEMA getomerch_marking TO getomerch_marking_worker;

GRANT EXECUTE ON FUNCTION getomerch_marking.reconcile_introduction_submission(
  uuid,text,text,jsonb,text,text,text
) TO getomerch_marking_worker;

COMMENT ON FUNCTION getomerch_marking.reconcile_introduction_submission(
  uuid,text,text,jsonb,text,text,text
) IS 'Worker-only attachment of a remotely verified CRPT document to one ambiguous introduction submission.';
