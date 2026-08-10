export const CORE_JOB_TYPES = [
  "ozon_orders_sync",
  "ozon_finance_sync",
  "ozon_prices_sync",
  "ozon_import_preview",
  "ozon_import_apply",
] as const;

export const MARKING_JOB_TYPES = [
  "marking_prepare_assignment",
  "marking_ozon_validate",
  "marking_ozon_submit",
  "marking_ozon_poll",
  "marking_crpt_auth_refresh",
  "marking_crpt_code_status_sync",
  "marking_crpt_application_submit",
  "marking_crpt_introduction_submit",
  "marking_crpt_document_poll",
  "marking_withdrawal_submit",
  "marking_return_to_circulation_submit",
  "marking_returns_sync",
  "marking_reconcile",
  "marking_suz_order_submit",
  "marking_suz_order_poll",
] as const;

export const JOB_TYPES = [...CORE_JOB_TYPES, ...MARKING_JOB_TYPES] as const;

export type CoreJobType = (typeof CORE_JOB_TYPES)[number];
export type MarkingJobType = (typeof MARKING_JOB_TYPES)[number];
export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type BackgroundJob = {
  id: string;
  type: JobType;
  status: JobStatus;
  dedupeKey: string;
  payload: Record<string, unknown>;
  result: unknown;
  progress: Record<string, unknown>;
  actor: string;
  requestId: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  lockedBy: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobEvent = {
  id: number;
  level: "info" | "warning" | "error";
  event: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type JobWithEvents = BackgroundJob & { events: JobEvent[] };

export type EnqueueJobInput = {
  type: JobType;
  dedupeKey: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  actor: string;
  requestId: string;
  maxAttempts?: number;
};
