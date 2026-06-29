// Доменные типы для KOMUI migration API. Соответствуют контракту backend
// (см. /api/komui/* прокси). На клиенте используются только эти типы —
// сырые ответы fetch нигде не торчат.
//
// Схема актуальна с migration API на stage.komui.ru — отличается от первичного
// спека, который писался до того, как backend был реально собран.

export type ImportTargets = {
  serverPostgres: boolean;
  supabase: boolean;
};

export type PreviewSummary = {
  totalOzonItems: number;
  matchedStorefront: number;
  matchedMerchProducts: number;
  actionableServerPostgres: number;
  actionableSupabase: number;
  noop: number;
  unmatched: number;
};

// Статусы, которые backend сейчас отдаёт. Список расширяемый — рендер
// устойчив к новым значениям благодаря fallback в statusLabel/statusClass.
export type ItemStatus =
  | "matched"
  | "unmatched"
  | "conflict"
  | "noop"
  | "skipped"
  | (string & {}); // catch-all, чтобы новые статусы не ломали типизацию

export type ItemSeverity = "info" | "warning" | "error";

export type MatchReason =
  | "ozon_offer_id"
  | "ozon_product_id"
  | "ozon_sku"
  | "normalized_offer_id"
  | "legacy_sku"
  | "manual"
  | "none"
  | (string & {});

export type PlannedAction = {
  action: string;
  target: "serverPostgres" | "supabase";
  table?: string;
  reason?: string;
};

export type DiffField = {
  field: string;
  current: unknown;
  next: unknown;
  changed: boolean;
};

export type ItemDiff = {
  changed: boolean;
  changedFields: string[];
  fields: DiffField[];
  operation: "noop" | "update" | "create" | "delete" | (string & {});
  table?: string;
  target?: string;
};

export type PreviewItem = {
  itemId: string;
  status: ItemStatus;
  severity: ItemSeverity;
  offerId: string;
  normalizedOfferId?: string;
  productId: string | number;
  price?: number;
  oldPrice?: number;
  minPrice?: number;
  matchReason: MatchReason;
  targetProduct?: {
    id: string;
    name?: string;
    slug?: string;
    designKey?: string | null;
  } | null;
  targetMerchProduct?: {
    id: string;
    sku?: string;
  } | null;
  plannedActions: PlannedAction[];
  // Поле появилось после обновления backend ozonImport.ts — содержит реальный
  // diff между текущим storefront и тем что прилетело из Ozon.
  diff?: ItemDiff;
  errors?: string[];
};

export type PreviewResponse = {
  previewId: string;
  createdAt?: string;
  importType?: string;
  mode?: string;
  summary: PreviewSummary;
  items: PreviewItem[];
  canImport: boolean;
  warnings: string[];
};

export type ImportStartResponse = {
  jobId: string;
  status: "queued";
};

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial";

export type JobEvent = {
  time: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type JobSummary = {
  insertedServer?: number;
  updatedServer?: number;
  insertedSupabase?: number;
  updatedSupabase?: number;
  skipped?: number;
  errors?: number;
};

export type JobResponse = {
  jobId: string;
  status: JobStatus;
  progress: { current: number; total: number };
  summary: JobSummary;
  events: JobEvent[];
  errors: string[];
};

const KNOWN_STATUS_LABELS: Record<string, string> = {
  matched: "Сопоставлено",
  unmatched: "Не сопоставлен",
  conflict: "Конфликт",
  noop: "Без изменений",
  skipped: "Пропущено",
};

export function statusLabel(status: ItemStatus): string {
  return KNOWN_STATUS_LABELS[status] ?? status;
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "В очереди",
  running: "Выполняется",
  succeeded: "Успешно",
  failed: "Ошибка",
  partial: "Частично",
};

// =============================================================================
// Runtime / traffic switch — управление режимом komui.ru: новый сервер vs legacy
// Vercel/Supabase. Backend KOMUI отвечает за фактическое переключение nginx,
// мы только показываем статус и шлём команду.
// =============================================================================

export type RuntimeMode = "server" | "legacy" | "staging" | (string & {});

export type RuntimeState =
  | "idle"
  | "prepared"
  | "applied"
  | "failed"
  | "rejected"
  | (string & {});

export type TrafficSwitch = {
  enabled?: boolean;
  target?: RuntimeMode;
  currentMode?: RuntimeMode;
  state?: RuntimeState;
  legacyOriginConfigured?: boolean;
  productionVhostEnabled?: boolean;
  message?: string;
  updatedAt?: string;
  lastRequestId?: string;
  nginxTest?: string;
  constraints?: string[];
};

export type RuntimeStatus = {
  runtimeMode: RuntimeMode;
  legacyFallbackConfigured?: boolean;
  trafficSwitchEnabled?: boolean;
  service?: string;
  trafficSwitch: TrafficSwitch;
};

export type RuntimeSwitchResponse = {
  requestId?: string;
  status: "applied" | "prepared" | "pending" | "failed" | "rejected" | (string & {});
  mode?: RuntimeMode;
  message?: string;
  productionVhostEnabled?: boolean;
  nginxTest?: string;
  trafficSwitch?: TrafficSwitch;
  error?: { message?: string; code?: string } | string;
};

export const RUNTIME_MODE_LABELS: Record<string, string> = {
  server: "Новый сервер",
  legacy: "Legacy Vercel/Supabase",
  staging: "Staging",
};

export const RUNTIME_STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  prepared: "Подготовлено",
  applied: "Применено",
  failed: "Ошибка",
  rejected: "Отклонено",
};

export function runtimeModeLabel(m?: RuntimeMode): string {
  if (!m) return "—";
  return RUNTIME_MODE_LABELS[m] ?? m;
}

export function runtimeStateLabel(s?: RuntimeState): string {
  if (!s) return "—";
  return RUNTIME_STATE_LABELS[s] ?? s;
}
