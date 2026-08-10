export const MARKING_PROCESS_STATUSES = [
  "open",
  "waiting_user",
  "waiting_external",
  "ready",
  "completed",
  "manual_review",
  "failed",
  "cancelled",
] as const;

export type MarkingProcessStatus = (typeof MARKING_PROCESS_STATUSES)[number];

export const MARKING_PRODUCTION_MODES = [
  "own_production",
  "pre_marked_minor_customization",
  "remarking_after_customization",
] as const;

export type MarkingProductionMode = (typeof MARKING_PRODUCTION_MODES)[number];

export const MARKING_FULFILLMENT_MODES = [
  "jit_after_order",
  "prebuilt_stock",
  "pre_marked_minor_customization",
] as const;

export type MarkingFulfillmentMode = (typeof MARKING_FULFILLMENT_MODES)[number];

export const MARKING_VERIFICATION_STATUSES = [
  "draft",
  "pending",
  "verified",
  "blocked",
  "conflict",
] as const;

export type MarkingVerificationStatus =
  (typeof MARKING_VERIFICATION_STATUSES)[number];

export const MARKING_EVIDENCE_VERIFICATION_STATUSES = [
  "unverified",
  "pending",
  "verified",
  "rejected",
  "expired",
] as const;

export type MarkingEvidenceVerificationStatus =
  (typeof MARKING_EVIDENCE_VERIFICATION_STATUSES)[number];

export const MARKING_REQUIREMENTS = [
  "unknown",
  "required",
  "not_required",
] as const;

export type MarkingRequirement = (typeof MARKING_REQUIREMENTS)[number];

export const MARKING_PROFILE_OPERATIONAL_STATUSES = [
  "draft",
  "enabled",
  "paused",
] as const;

export type MarkingProfileOperationalStatus =
  (typeof MARKING_PROFILE_OPERATIONAL_STATUSES)[number];

export const MARKING_PROFILE_CHANNELS = ["ozon_fbs", "komui"] as const;

export type MarkingProfileChannel = (typeof MARKING_PROFILE_CHANNELS)[number];

export const MARKING_CODE_POOL_STATES = [
  "pending_utilisation",
  "available",
  "reserved",
  "bound",
  "invalid",
  "quarantined",
  "retired",
  "replaced",
] as const;

export type MarkingCodePoolState = (typeof MARKING_CODE_POOL_STATES)[number];

export const MARKING_CODE_CRPT_STATES = [
  "unknown",
  "emitted",
  "applied",
  "introduced",
  "in_circulation",
  "withdrawn",
  "invalid",
] as const;

export type MarkingCodeCrptState = (typeof MARKING_CODE_CRPT_STATES)[number];

export const MARKING_CODE_ACQUISITION_MODES = [
  "own_suz_emission",
  "supplier_marked_import",
  "remarking",
] as const;

export type MarkingCodeAcquisitionMode =
  (typeof MARKING_CODE_ACQUISITION_MODES)[number];

export const MARKING_UNIT_STATES = [
  "preparing",
  "marking_pending",
  "ready",
  "reserved",
  "shipped",
  "returned",
  "quarantined",
  "cancelled",
  "retired",
  "destroyed",
] as const;

export type MarkingUnitState = (typeof MARKING_UNIT_STATES)[number];

export const MARKING_BINDING_STATUSES = [
  "planned",
  "active",
  "removed",
  "replaced",
  "cancelled",
] as const;

export type MarkingBindingStatus = (typeof MARKING_BINDING_STATUSES)[number];

export const MARKING_LABEL_STATES = [
  "not_rendered",
  "label_rendered",
  "printed",
  "applied",
  "damaged",
  "lost",
  "destroyed",
  "unknown",
] as const;

export type MarkingLabelState = (typeof MARKING_LABEL_STATES)[number];

export const MARKING_ASSIGNMENT_STATUSES = [
  "active",
  "released",
  "quarantined",
  "completed",
  "cancelled",
] as const;

export type MarkingAssignmentStatus =
  (typeof MARKING_ASSIGNMENT_STATUSES)[number];
