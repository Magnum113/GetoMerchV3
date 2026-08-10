export type MarkingDomainErrorCode =
  | "invalid_gtin"
  | "invalid_process_status"
  | "invalid_process_transition"
  | "invalid_product_profile"
  | "invalid_product_evidence"
  | "invalid_profile_backfill"
  | "invalid_code_import"
  | "invalid_code_state"
  | "invalid_assignment"
  | "invalid_label"
  | "invalid_ozon_submission"
  | "invalid_crpt_query"
  | "invalid_crpt_document"
  | "invalid_return"
  | "invalid_suz_order"
  | "suz_order_not_found"
  | "suz_order_revision_conflict"
  | "suz_write_disabled"
  | "crpt_read_disabled"
  | "crpt_write_disabled"
  | "crpt_withdrawal_disabled"
  | "ozon_submission_not_ready"
  | "assignment_not_found"
  | "assignment_revision_conflict"
  | "assignment_access_denied"
  | "return_not_found"
  | "return_revision_conflict"
  | "return_not_ready"
  | "code_not_found"
  | "code_revision_conflict"
  | "profile_not_found"
  | "profile_revision_conflict"
  | "invalid_idempotency_scope"
  | "process_not_found"
  | "process_version_conflict";

export class MarkingDomainError extends Error {
  readonly code: MarkingDomainErrorCode;

  constructor(code: MarkingDomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MarkingDomainError";
    this.code = code;
  }
}
