DO $check$
DECLARE
  exposed_count bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM public.merch_marking_documents
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_document_codes
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_crpt_queries
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_document_confirmations
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_ozon_submissions
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_withdrawal_confirmations
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_return_confirmations
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_code_orders
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_code_order_items
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_signature_requests
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM public.merch_marking_signing_agents
      WHERE last_error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
    + (SELECT count(*) FROM getomerch_jobs.jobs
      WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}')
  INTO exposed_count;

  IF exposed_count <> 0 THEN
    RAISE EXCEPTION 'marking identification codes remain exposed in error messages: %',
      exposed_count;
  END IF;
END
$check$;
