import type {
  MarkingAssignmentStatus,
  MarkingBindingStatus,
  MarkingFulfillmentMode,
  MarkingCodeAcquisitionMode,
  MarkingCodeCrptState,
  MarkingCodePoolState,
  MarkingLabelState,
  MarkingProfileChannel,
  MarkingProfileOperationalStatus,
  MarkingProcessStatus,
  MarkingProductionMode,
  MarkingRequirement,
  MarkingUnitState,
  MarkingVerificationStatus,
} from "@/lib/marking/domain/states";

export type CursorPage<T> = {
  items: T[];
  page: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};

export type MarkingReadinessStatus =
  | "ready"
  | "blocked"
  | "not_required"
  | "archived";

export type MarkingReadinessItem = {
  profileId: string | null;
  productId: string;
  sku: string | null;
  offerId: string | null;
  ozonSku: string | null;
  externalProductId: string | null;
  channel: MarkingProfileChannel | null;
  category: string | null;
  fabric: string | null;
  color: string | null;
  size: string | null;
  design: string | null;
  requiresMarking: boolean | null;
  markingRequirement: MarkingRequirement;
  markingRequirementSource: string | null;
  markingRequirementObservedAt: string | null;
  productionMode: MarkingProductionMode | null;
  fulfillmentMarkingMode: MarkingFulfillmentMode | null;
  profileVerificationStatus: MarkingVerificationStatus | null;
  operationalStatus: MarkingProfileOperationalStatus | null;
  operationalStatusReason: string | null;
  revision: number | null;
  tradeItemId: string | null;
  gtin: string | null;
  productGroup: string | null;
  nationalCatalogCardId: string | null;
  nationalCatalogStatus: string | null;
  tradeItemVerificationStatus: MarkingVerificationStatus | null;
  verifiedEvidenceCount: number;
  conflictCount: number;
  readinessStatus: MarkingReadinessStatus;
  blockerReasons: string[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
};

export type MarkingProcessListItem = {
  id: string;
  processType: string;
  status: MarkingProcessStatus;
  source: string;
  sourceKey: string;
  priority: number;
  currentStep: string;
  nextAction: string | null;
  deadlineAt: string | null;
  manualReviewReason: string | null;
  lastErrorCode: string | null;
  owner: string | null;
  version: number;
  fulfillmentOrderId: string | null;
  fulfillmentItemId: string | null;
  postingNumber: string | null;
  offerId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type MarkingEventListItem = {
  id: string;
  processId: string | null;
  productProfileId: string | null;
  markingCodeId: string | null;
  eventType: string;
  actorType: string;
  actorId: string | null;
  source: string;
  details: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
};

export type MarkingEvidenceListItem = {
  id: string;
  processId: string | null;
  productProfileId: string | null;
  evidenceType: string;
  source: string;
  externalReference: string | null;
  scope: Record<string, unknown>;
  observedAt: string;
  details: Record<string, unknown>;
  verificationStatus: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
};

export type MarkingProcessDetail = {
  process: MarkingProcessListItem;
  events: MarkingEventListItem[];
  evidence: MarkingEvidenceListItem[];
};

export type MarkingConflictSeverity = "warning" | "blocking";

export type MarkingConflictItem = {
  conflictKey: string;
  conflictType:
    | "catalog_attribute_mismatch"
    | "sku_multiple_gtin"
    | "shared_gtin_incompatible_attributes"
    | "ozon_requirement_mismatch"
    | "document_reference_warning";
  severity: MarkingConflictSeverity;
  productId: string | null;
  profileId: string | null;
  sku: string | null;
  gtin: string | null;
  field: string | null;
  localValue: string | null;
  externalValue: string | null;
  message: string;
  observedAt: string;
};

export type MarkingProfileBackfillRun = {
  id: string;
  status: "preview" | "applied" | "failed";
  source: string;
  summary: {
    total: number;
    createDraft?: number;
    skip?: number;
    conflict?: number;
    applied?: number;
    skipped?: number;
    failed?: number;
    conflicts?: number;
  };
  createdBy: string;
  createdAt: string;
  appliedBy: string | null;
  appliedAt: string | null;
};

export type MarkingProfileBackfillItem = {
  id: string;
  productId: string;
  sku: string | null;
  action: "create_draft" | "skip" | "conflict";
  channel: MarkingProfileChannel;
  offerId: string | null;
  externalSku: string | null;
  proposedRequirement: MarkingRequirement;
  exactGtin: string | null;
  errors: string[];
  warnings: string[];
  applyStatus: "pending" | "applied" | "skipped" | "failed";
  appliedProfileId: string | null;
};

export type MarkingProfileBackfillDetail = {
  run: MarkingProfileBackfillRun;
  items: MarkingProfileBackfillItem[];
};

export type MarkingCodePoolItem = {
  id: string;
  tradeItemId: string;
  gtin: string;
  fingerprint: string;
  productSkus: string[];
  acquisitionMode: MarkingCodeAcquisitionMode;
  importBatchId: string | null;
  poolState: MarkingCodePoolState;
  crptState: MarkingCodeCrptState;
  crptStatusRaw: string | null;
  crptCheckedAt: string | null;
  blockedReason: string | null;
  labelExposedAt: string | null;
  quarantinedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type MarkingCodePoolSummary = {
  total: number;
  available: number;
  reserved: number;
  bound: number;
  quarantined: number;
  invalid: number;
  terminal: number;
};

export type MarkingCrptReadQuery = {
  id: string;
  queryType: "code_status" | "document_status";
  markingCodeId: string | null;
  fingerprint: string | null;
  gtin: string | null;
  externalDocumentId: string | null;
  productGroup: string;
  status: "queued" | "running" | "succeeded" | "failed" | "manual_review";
  normalizedStatus: string | null;
  rawStatus: string | null;
  result: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  ownerMatches: boolean | null;
  gtinMatches: boolean | null;
  requestedBy: string;
  requestId: string;
  attemptCount: number;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarkingCrptWorkspace = {
  runtime: {
    enabled: boolean;
    readEnabled: boolean;
    signerEnabled: boolean;
    writeEnabled: boolean;
    introductionEnabled: boolean;
    withdrawalEnabled: boolean;
    returnsEnabled: boolean;
    contour: "sandbox" | "production";
    innConfigured: boolean;
    signerTransport: "unix" | "remote";
  };
  signingAgents: Array<{
    agentId: string;
    displayName: string;
    state: "ready" | "degraded" | "token_missing" | "signer_unavailable" | "pin_required" | "offline";
    readerDetected: boolean;
    signerReachable: boolean;
    pinState: "unknown" | "ready" | "required" | "blocked";
    certificateThumbprint: string | null;
    certificateValidTo: string | null;
    softwareVersion: string;
    errorCode: string | null;
    errorMessage: string | null;
    lastSeenAt: string;
  }>;
  signatureSummary: {
    pending: number;
    leased: number;
    failed24h: number;
    signed24h: number;
  };
  signatureRequests: Array<{
    id: string;
    purpose: "crpt_auth_attached_cades_bes" | "crpt_document_detached_cades_bes";
    payloadSha256: string;
    status: "pending" | "leased" | "signed" | "consumed" | "failed" | "expired" | "cancelled";
    requestedBy: string;
    leaseAgentId: string | null;
    attemptCount: number;
    certificateThumbprint: string | null;
    certificateValidTo: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    expiresAt: string;
    signedAt: string | null;
    consumedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  authorization: {
    status: "not_started" | "queued" | "running" | "active" | "expired" | "failed" | "cancelled";
    tokenExpiresAt: string | null;
    certificateThumbprint: string | null;
    certificateValidTo: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: string | null;
  };
  queries: MarkingCrptReadQuery[];
  documents: Array<{
    id: string;
    documentType: "introduction" | "withdrawal_remote_sale" | "return_to_circulation";
    operationMode: "own_production" | "distance_sale" | "remote_sale_return";
    status: "draft" | "payload_built" | "signed" | "submitting" | "processing" | "accepted" | "rejected" | "requires_manual_review" | "superseded";
    revision: number;
    externalDocumentId: string | null;
    payloadHash: string | null;
    signatureHash: string | null;
    certificateThumbprint: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    handoverId: string | null;
    returnCaseId: string | null;
    postingNumber: string | null;
    handoverAt: string | null;
    withdrawalDeadlineAt: string | null;
    circulationState: "pending" | "confirmed" | "requires_manual_review" | null;
    circulationErrorCode: string | null;
    circulationErrorMessage: string | null;
    circulationConfirmedAt: string | null;
    withdrawalState: "pending" | "confirmed" | "requires_manual_review" | null;
    withdrawalErrorCode: string | null;
    withdrawalErrorMessage: string | null;
    withdrawalConfirmedAt: string | null;
    returnState: "pending" | "confirmed" | "requires_manual_review" | null;
    returnErrorCode: string | null;
    returnErrorMessage: string | null;
    returnConfirmedAt: string | null;
    attemptCount: number;
    createdAt: string;
    updatedAt: string;
    acceptedAt: string | null;
    codes: Array<{
      assignmentId: string;
      markingCodeId: string;
      markingUnitId: string;
      gtin: string;
      fingerprint: string;
      postingNumber: string;
      offerId: string | null;
      unitOrdinal: number;
      result: string;
      operationKind: "introduction" | "withdrawal" | "return_to_circulation";
      crptState: string;
      errorCode: string | null;
      errorMessage: string | null;
    }>;
  }>;
};

export type MarkingReturnCase = import("@/lib/marking/repositories/returns").MarkingReturnCase;

export type MarkingCodeImportBatch = {
  id: string;
  source: string;
  filename: string | null;
  contentType: string | null;
  fileSha256: string;
  fileSizeBytes: number;
  expectedGtin: string;
  tradeItemId: string;
  acquisitionMode: Exclude<MarkingCodeAcquisitionMode, "supplier_marked_import">;
  status: "preview" | "applied" | "failed" | "expired";
  rowsTotal: number;
  rowsValid: number;
  rowsDuplicate: number;
  rowsRejected: number;
  rowsApplied: number;
  rowsRaceDuplicate: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  appliedBy: string | null;
  appliedAt: string | null;
  summary: Record<string, unknown>;
};

export type MarkingCodeImportRow = {
  id: string;
  rowNumber: number;
  gtin: string | null;
  fingerprint: string | null;
  validationStatus:
    | "valid"
    | "duplicate_file"
    | "duplicate_pool"
    | "gtin_mismatch"
    | "rejected"
    | "applied"
    | "scrubbed";
  errorCodes: string[];
  appliedCodeId: string | null;
  createdAt: string;
  scrubbedAt: string | null;
};

export type MarkingCodeImportDetail = {
  batch: MarkingCodeImportBatch;
  rows: MarkingCodeImportRow[];
  rowsTruncated: boolean;
};

export type MarkingJitCandidate = {
  fulfillmentItemId: string;
  fulfillmentOrderId: string;
  sourceChannel: MarkingProfileChannel;
  postingNumber: string | null;
  sourceStatus: string;
  offerId: string | null;
  productId: string;
  sku: string | null;
  quantity: number;
  exemplarFlowAvailable: boolean | null;
  productProfileId: string | null;
  operationalStatus: MarkingProfileOperationalStatus | null;
  profileVerificationStatus: MarkingVerificationStatus | null;
  productionMode: MarkingProductionMode | null;
  fulfillmentMarkingMode: MarkingFulfillmentMode | null;
  tradeItemId: string | null;
  gtin: string | null;
  warehouseId: string;
  warehouseName: string;
  warehouseType: "own" | "workshop";
  blankProductId: string | null;
  blankQuantity: number;
  decorationSlug: string;
  decorationMadeAt: "own" | "workshop";
  decorationQuantity: number;
  availableCodeCount: number;
  activeAssignmentCount: number;
  unassignedQuantity: number;
  canPrepare: boolean;
  prepareBlocker: string | null;
  updatedAt: string;
};

export type MarkingAssignmentListItem = {
  id: string;
  fulfillmentItemId: string;
  fulfillmentOrderId: string;
  sourceChannel: MarkingProfileChannel;
  postingNumber: string | null;
  sourceStatus: string;
  offerId: string | null;
  productId: string;
  sku: string | null;
  itemQuantity: number;
  unitOrdinal: number;
  productProfileId: string;
  gtin: string;
  assignmentStatus: MarkingAssignmentStatus;
  assignmentRevision: number;
  assignedBy: string;
  assignedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  completedAt: string | null;
  markingUnitId: string;
  internalSerial: string;
  unitState: MarkingUnitState;
  custodyState: string;
  warehouseId: string;
  warehouseName: string | null;
  codeBindingId: string;
  bindingStatus: MarkingBindingStatus;
  labelState: MarkingLabelState;
  templateVersion: string | null;
  renderCount: number;
  printConfirmedCount: number;
  markingCodeId: string;
  codeFingerprint: string;
  codePoolState: MarkingCodePoolState;
  crptState: MarkingCodeCrptState;
  processId: string | null;
  processStatus: MarkingProcessStatus | null;
  currentStep: string | null;
  nextAction: string | null;
  lastErrorCode: string | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  ozonState:
    | "not_started"
    | "prepared"
    | "validating"
    | "validation_rejected"
    | "validated"
    | "submitting"
    | "polling"
    | "accepted"
    | "rejected"
    | "manual_review"
    | "superseded";
  canRenderLabel: boolean;
  canReprintLabel: boolean;
  canConfirmApplied: boolean;
  canCancel: boolean;
  canValidateOzon: boolean;
  canSubmitOzon: boolean;
  shippingBlocker: string;
  createdAt: string;
  updatedAt: string;
};

export type MarkingOzonBatchListItem = {
  id: string;
  fulfillmentOrderId: string;
  postingNumber: string;
  requestRevision: number;
  operationKind: "initial_set" | "correction";
  status: string;
  attemptCount: number;
  unitCount: number;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
};
