// Доменные типы для KOMUI migration API. Соответствуют контракту backend
// (см. /api/komui/* прокси). На клиенте используются только эти типы —
// сырые ответы fetch нигде не торчат.
//
// Схема актуальна с Komui migration API — отличается от первичного
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
  // Кол-во групп-кандидатов в новые карточки (появилось в API v2).
  newProductGroups?: number;
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
  sku?: string | number;
  // Размер, распарсенный backend'ом из offer_id/name (API v2).
  size?: string;
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
  // Предполагаемый новый товар для несматченного оффера (API v2).
  inferredProduct?: {
    designKey?: string;
    slug?: string;
    name?: string;
  } | null;
  plannedActions: PlannedAction[];
  // Поле появилось после обновления backend ozonImport.ts — содержит реальный
  // diff между текущим storefront и тем что прилетело из Ozon.
  diff?: ItemDiff;
  errors?: string[];
};

// Группа несматченных offer-ов одного дизайна — кандидат в новую карточку.
export type NewProductGroup = {
  designKey?: string;
  slug?: string;
  ozonVariant?: string;
  productType?: string;
  productTypeSlug?: string;
  category?: string;
  categorySlug?: string;
  decorationType?: string;
  decorationSlug?: string;
  colorName?: string;
  colorSlug?: string;
  colorHex?: string;
  itemIds: string[];
  offerIds: string[];
  sizes: string[];
  suggestedName?: string;
  primaryImageUrl?: string;
  imageUrls?: string[];
  minOzonPrice?: number;
  maxOzonPrice?: number;
};

// Backend отдаёт warnings объектами; исторические строки тоже терпим.
export type PreviewWarning =
  | string
  | { code?: string; message?: string; count?: number };

export function previewWarningText(w: PreviewWarning): string {
  if (typeof w === "string") return w;
  return w.message ?? w.code ?? JSON.stringify(w);
}

export function hasPreviewWarning(
  warnings: PreviewWarning[] | undefined,
  code: string,
): boolean {
  return (warnings ?? []).some(
    (w) => typeof w === "object" && w !== null && w.code === code,
  );
}

export type PreviewMode = {
  serverPostgres?: boolean;
  supabaseRequested?: boolean;
  supabaseWriteEnabled?: boolean;
  ozonImportMode?: string;
  updatePrices?: boolean;
  syncSizes?: "add" | "off" | (string & {});
};

export type PreviewResponse = {
  previewId: string;
  createdAt?: string;
  importType?: string;
  mode?: PreviewMode | string;
  summary: PreviewSummary;
  items: PreviewItem[];
  newProductGroups?: NewProductGroup[];
  canImport: boolean;
  warnings: PreviewWarning[];
};

export type LinkOffersResponse = {
  productId: string;
  linkedOzon?: {
    itemIds?: string[];
    offerIds?: string[];
    skus?: string[];
    productIds?: string[];
  };
  applied?: number;
  syncedAt?: string;
};

export type CreateProductFromGroupResponse = {
  product: {
    id: string;
    designKey?: string;
    slug?: string;
    name?: string;
    sizes?: string[];
    salePrice?: number;
    primaryImageUrl?: string;
    isActive?: boolean;
  };
  linkedOzon?: {
    itemIds?: string[];
    offerIds?: string[];
    skus?: string[];
    productIds?: string[];
  };
};

export type ImportStartResponse = {
  jobId: string;
  status: JobStatus;
};

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | (string & {});

export type JobEvent = {
  time: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type JobSummary = {
  appliedServerPostgres?: number;
  insertedServer?: number;
  updatedServer?: number;
  supabasePatched?: number;
  supabaseSkipped?: number;
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

export const JOB_STATUS_LABELS: Record<string, string> = {
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

// =============================================================================
// Storefront products — редактор товаров сайта komui.ru (server PostgreSQL,
// не Supabase). См. /Users/kadimagomedov/Documents/KomuiMerch/docs/
//   admin-storefront-products-api.md.
// =============================================================================

export type StorefrontOffer = {
  size?: string;
  sku?: string;
  price?: number;
  oldPrice?: number;
  visible?: boolean;
  [k: string]: unknown;
};

export type StorefrontProduct = {
  id: string;
  designKey?: string;
  name: string;
  slug?: string;
  description?: string | null;
  shortDescription?: string | null;
  category?: string;
  productType?: string;
  decorationType?: string;
  colorName?: string;
  collectionName?: string;
  sizes: string[];
  salePrice: number;
  priceMax?: number;
  regularPrice?: number | null;
  currency?: string;
  primaryImageUrl?: string;
  mainImagePath?: string | null;
  imageUrls: string[];
  offers?: StorefrontOffer[];
  isActive: boolean;
  sortOrder?: number;
  badges?: string[];
  updatedAt?: string;
};

export type StorefrontListResponse = {
  products: StorefrontProduct[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
};

export type StorefrontProductResponse = {
  product: StorefrontProduct;
  changedFields?: string[];
};

export type StorefrontPatch = {
  name?: string;
  description?: string | null;
  shortDescription?: string | null;
  salePrice?: number;
  regularPrice?: number | null;
  sizes?: string[];
  imageUrls?: string[];
  mainImagePath?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  syncOfferPrices?: boolean;
};

export type StorefrontActiveFilter = "all" | "active" | "inactive";

export const STOREFRONT_ACTIVE_LABELS: Record<StorefrontActiveFilter, string> = {
  all: "Все",
  active: "Активные",
  inactive: "Скрытые",
};

// =============================================================================
// Storefront orders — обработка заказов с komui.ru.
// См. /Users/kadimagomedov/Documents/KomuiMerch/docs/admin-storefront-orders-api.md
// =============================================================================

export type PaymentStatus =
  | "created"
  | "pending_payment"
  | "authorized"
  | "paid"
  | "payment_failed"
  | "payment_review"
  | "canceled"
  | "partially_refunded"
  | "refunded"
  | (string & {});

export type FulfillmentStatus =
  | "new"
  | "processing"
  | "shipped"
  | "delivered"
  | "canceled"
  | "returned"
  | (string & {});

export type CdekStatus =
  | "pending"
  | "creating"
  | "accepted"
  | "created"
  | "invalid"
  | "failed"
  | "deleted"
  | "unknown"
  | (string & {});

export type OrderCustomer = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  marketingConsent?: boolean;
};

export type OrderDelivery = {
  provider?: string;
  pointCode?: string;
  city?: string;
  address?: string;
  hours?: string;
  eta?: string;
};

export type OrderAmounts = {
  subtotal?: number; // копейки
  discount?: number;
  delivery?: number;
  total?: number;
  currency?: string;
};

export type OrderCdek = {
  status?: CdekStatus;
  uuid?: string;
  number?: string;
  errorMessage?: string | null;
};

export type OrderLatestPayment = {
  providerStatus?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type StorefrontOrderSummary = {
  id: string;
  orderNumber: string;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  fulfillmentNote?: string | null;
  customer?: OrderCustomer;
  delivery?: OrderDelivery;
  amounts?: OrderAmounts;
  promoCode?: string | null;
  source?: string;
  itemCount?: number;
  lineCount?: number;
  latestPayment?: OrderLatestPayment | null;
  cdek?: OrderCdek | null;
  paidAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type StorefrontOrderItem = {
  id?: string;
  productId?: string;
  name?: string;
  slug?: string;
  size?: string;
  quantity?: number;
  unitPrice?: number; // копейки
  totalPrice?: number;
  imageUrl?: string;
};

export type PaymentAttempt = {
  id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type PaymentEvent = {
  id?: string;
  type?: string;
  receivedAt?: string;
  status?: string;
  amount?: number;
  raw?: unknown;
};

export type CdekShipment = {
  id?: string;
  status?: CdekStatus;
  uuid?: string | null;
  number?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type CdekEvent = {
  id?: string;
  type?: string;
  receivedAt?: string;
  status?: string;
  raw?: unknown;
};

export type StorefrontOrderListResponse = {
  orders: StorefrontOrderSummary[];
  pagination: { limit: number; offset: number; total: number };
  statuses?: {
    payment: PaymentStatus[];
    fulfillment: FulfillmentStatus[];
  };
};

export type StorefrontOrderDetailResponse = {
  order: StorefrontOrderSummary;
  items?: StorefrontOrderItem[];
  paymentAttempts?: PaymentAttempt[];
  paymentEvents?: PaymentEvent[];
  cdekShipment?: CdekShipment | null;
  cdekEvents?: CdekEvent[];
};

export type MarkShippedResponse = {
  order: StorefrontOrderSummary;
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  created: "Создан",
  pending_payment: "Ожидает оплаты",
  authorized: "Авторизован",
  paid: "Оплачен",
  payment_failed: "Не оплачен",
  payment_review: "На проверке",
  canceled: "Отменён",
  partially_refunded: "Возврат частичный",
  refunded: "Возвращён",
};

export const FULFILLMENT_STATUS_LABELS: Record<string, string> = {
  new: "Новый",
  processing: "В работе",
  shipped: "Отправлен",
  delivered: "Доставлен",
  canceled: "Отменён",
  returned: "Возвращён",
};

export const CDEK_STATUS_LABELS: Record<string, string> = {
  pending: "Ждёт",
  creating: "Создаётся",
  accepted: "Принят СДЭК",
  created: "Накладная",
  invalid: "Ошибка данных",
  failed: "Не создан",
  deleted: "Удалён",
  unknown: "—",
};

export const FULFILLMENT_STATUSES: FulfillmentStatus[] = [
  "new",
  "processing",
  "shipped",
  "delivered",
  "canceled",
  "returned",
];

export const PAYMENT_STATUSES: PaymentStatus[] = [
  "created",
  "pending_payment",
  "authorized",
  "paid",
  "payment_failed",
  "payment_review",
  "canceled",
  "partially_refunded",
  "refunded",
];

export function paymentStatusLabel(s?: string): string {
  if (!s) return "—";
  return PAYMENT_STATUS_LABELS[s] ?? s;
}

export function fulfillmentStatusLabel(s?: string): string {
  if (!s) return "—";
  return FULFILLMENT_STATUS_LABELS[s] ?? s;
}

export function cdekStatusLabel(s?: string): string {
  if (!s) return "—";
  return CDEK_STATUS_LABELS[s] ?? s;
}

export function canMarkShipped(o: StorefrontOrderSummary): boolean {
  if (o.paymentStatus !== "paid" && o.paymentStatus !== "authorized") return false;
  if (o.fulfillmentStatus === "shipped" || o.fulfillmentStatus === "delivered")
    return false;
  return true;
}

// Сумма приходит в копейках — делим для UI.
export function moneyFromKopecks(v: number | undefined | null): number | null {
  if (v == null) return null;
  return v / 100;
}
