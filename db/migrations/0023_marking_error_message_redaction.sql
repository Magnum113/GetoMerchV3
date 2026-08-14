-- True API validation messages may contain the AI 01 + AI 21 identification
-- part of a marking code without the crypto tail. Remove that identifier from
-- stored safe/error projections; legal document status and evidence remain
-- unchanged.

UPDATE public.merch_marking_documents
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_document_codes
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_document_confirmations
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_crpt_queries
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_ozon_submissions
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_withdrawal_confirmations
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_return_confirmations
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_code_orders
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_code_order_items
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_signature_requests
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE public.merch_marking_signing_agents
SET last_error_message = regexp_replace(
  last_error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE last_error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';

UPDATE getomerch_jobs.jobs
SET error_message = regexp_replace(
  error_message,
  '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}',
  '[REDACTED]',
  'gi'
)
WHERE error_message ~ '(\(01\)|01)[0-9]{14}(\(21\)|21)[^[:space:],;]{1,40}';
