export const JOB_TYPES = [
  "ozon_orders_sync",
  "ozon_finance_sync",
  "ozon_prices_sync",
  "ozon_import_preview",
  "ozon_import_apply",
] as const;

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
