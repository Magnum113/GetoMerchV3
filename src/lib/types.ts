export type WarehouseType = "own" | "workshop";
export type DecorationLocation = "own" | "workshop";
export type DesignType = "print" | "embroidery";

export type WorkshopOrderStatus =
  | "sent"
  | "ready"
  | "received"
  | "cancelled";

export type TransactionType =
  | "receive"
  | "transfer"
  | "sale"
  | "production"
  | "adjustment"
  | "writeoff";

export interface Warehouse {
  id: string;
  name: string;
  type: WarehouseType;
  address: string | null;
  contact: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProductCategory {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface FabricType {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface Color {
  id: string;
  name: string;
  hex_code: string | null;
  created_at: string;
}

export interface Size {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface Design {
  id: string;
  name: string;
  type: DesignType;
  code: string | null;
  description: string | null;
  image_url: string | null;
  created_at: string;
}

export interface DecorationType {
  id: string;
  name: string;
  slug: string;
  made_at: DecorationLocation;
  created_at: string;
}

export interface Product {
  id: string;
  category_id: string;
  fabric_id: string;
  color_id: string;
  size_id: string;
  design_id: string | null;
  decoration_type_id: string | null;
  sku: string | null;
  ozon_sku: number | null;
  legacy_skus?: string[];
  design_version: string | null;
  hoodie_fit: string | null;
  hoodie_fabric: string | null;
  is_blank: boolean;
  cost_price: number | null;
  sale_price: number | null;
  created_at: string;
  // expanded relations (when joined)
  category?: ProductCategory;
  fabric?: FabricType;
  color?: Color;
  size?: Size;
  design?: Design | null;
  decoration_type?: DecorationType | null;
}

export interface Inventory {
  id: string;
  product_id: string;
  warehouse_id: string;
  quantity: number;
  updated_at: string;
  product?: Product;
  warehouse?: Warehouse;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  product_id: string | null;
  design_id: string | null;
  source_design_id: string | null;
  from_warehouse_id: string | null;
  to_warehouse_id: string | null;
  quantity: number;
  source_product_id: string | null;
  workshop_order_id: string | null;
  notes: string | null;
  occurred_at: string;
  created_at: string;
  product?: Product | null;
  design?: Design | null;
  source_design?: Design | null;
  from_warehouse?: Warehouse | null;
  to_warehouse?: Warehouse | null;
}

export interface WorkshopOrder {
  id: string;
  order_number: string | null;
  workshop_id: string;
  status: WorkshopOrderStatus;
  notes: string | null;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  received_at: string | null;
  workshop?: Warehouse;
  items?: WorkshopOrderItem[];
}

export interface WorkshopOrderItem {
  id: string;
  order_id: string;
  blank_product_id: string | null;
  design_id: string;
  decoration_type_id: string;
  result_product_id: string | null;
  quantity: number;
  notes: string | null;
  design_version: string | null;
  hoodie_fit: string | null;
  hoodie_fabric: string | null;
  blank_product?: Product | null;
  design?: Design;
  decoration_type?: DecorationType;
  result_product?: Product | null;
}

export interface PrintInventory {
  id: string;
  design_id: string;
  warehouse_id: string;
  quantity: number;
  updated_at: string;
  design?: Design;
  warehouse?: Warehouse;
}

export interface InventoryMatrixCell {
  hasProduct: boolean;
  byWh: Record<string, number>;
}

export interface InventoryMatrixRow {
  key: string;
  isBlank: boolean;
  label: string;
  subLabel: string;
  hex: string | null;
  designLabel: string | null;
  cells: Record<string, InventoryMatrixCell>;
}

export interface InventoryMatrix {
  blankRows: InventoryMatrixRow[];
  finishedRows: InventoryMatrixRow[];
}

export type OzonPostingSource = "fbs" | "fbo";
export type MarkingRequirement = "unknown" | "required" | "not_required";

export interface FulfillmentOrderDiagnostic {
  id: string;
  source_channel: "ozon_fbs" | "komui";
  fulfillment_scheme: "fbs" | "d2c";
  source_order_key: string;
  source_status: string;
}

export interface FulfillmentItemDiagnostic {
  id: string;
  source_item_key: string;
  quantity: number;
  marking_requirement: MarkingRequirement;
  exemplar_flow_available: boolean | null;
  source_active: boolean;
}

export interface OzonOrder {
  id: string;
  posting_number: string;
  order_id: number | null;
  order_number: string | null;
  status: string;
  substatus: string | null;
  ozon_created_at: string | null;
  in_process_at: string | null;
  shipment_date: string | null;
  delivery_method: string | null;
  warehouse_name: string | null;
  customer_name: string | null;
  total_price: number | null;
  source: OzonPostingSource | null;
  synced_at: string;
  shipped_at: string | null;
  shipped_from_warehouse_id: string | null;
  workshop_order_id: string | null;
  fulfillment_order_id?: string | null;
  notes: string | null;
  created_at: string;
  items?: OzonOrderItem[];
  workshop_order?: WorkshopOrder | null;
  fulfillment?: FulfillmentOrderDiagnostic | null;
  marking_shipping?: {
    mode: "observe" | "enforce";
    allowed: boolean;
    requiredUnits: number;
    readyUnits: number;
    blockers: string[];
  } | null;
}

export interface OzonOrderItem {
  id: string;
  order_id: string;
  offer_id: string;
  ozon_sku: string | null;
  ozon_product_id?: string | null;
  source_item_key?: string | null;
  name: string | null;
  quantity: number;
  price: number | null;
  product_id: string | null;
  marking_requirement?: MarkingRequirement;
  exemplar_flow_available?: boolean | null;
  source_active?: boolean;
  fulfillment_item_id?: string | null;
  product?: Product | null;
  fulfillment?: FulfillmentItemDiagnostic | null;
  marking?: {
    assignments: MarkingAssignmentListItem[];
    candidates: MarkingJitCandidate[];
  };
}

export interface OzonFinanceService {
  name: string;
  price: number;
}

export interface OzonFinanceItemSnapshot {
  name?: string;
  sku?: number | string;
  [key: string]: unknown;
}

export interface OzonFinanceOperation {
  id: string;
  operation_id: number;
  operation_type: string;
  operation_type_name: string | null;
  operation_date: string;
  posting_number: string | null;
  accruals_for_sale: number | null;
  sale_commission: number | null;
  amount: number;
  services: OzonFinanceService[] | null;
  items: OzonFinanceItemSnapshot[] | null;
  synced_at: string;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  archived: boolean;
  created_at: string;
}

export interface Expense {
  id: string;
  category_id: string | null;
  amount: number;
  occurred_at: string;
  description: string | null;
  created_at: string;
  category?: ExpenseCategory | null;
}

export const OZON_STATUS_LABELS: Record<string, string> = {
  acceptance_in_progress: "Идёт приёмка",
  awaiting_approve: "Ждёт подтверждения",
  awaiting_packaging: "Ждёт упаковки",
  awaiting_deliver: "Ждёт отгрузки",
  awaiting_registration: "Ждёт регистрации",
  arbitration: "Арбитраж",
  client_arbitration: "Клиентский арбитраж",
  delivering: "Доставляется",
  driver_pickup: "Передан водителю",
  delivered: "Доставлен",
  cancelled: "Отменён",
  not_accepted: "Не принят",
  sent_by_seller: "Отправлен продавцом",
};

export const OZON_STATUS_COLORS: Record<string, string> = {
  awaiting_packaging: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  awaiting_deliver: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  delivering: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  delivered: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  receive: "Приёмка",
  transfer: "Перемещение",
  sale: "Продажа",
  production: "Производство",
  adjustment: "Корректировка",
  writeoff: "Списание",
};

export const WORKSHOP_STATUS_LABELS: Record<WorkshopOrderStatus, string> = {
  sent: "В работе у цеха",
  ready: "Готово",
  received: "Получено",
  cancelled: "Отменено",
};

export const WORKSHOP_STATUS_COLORS: Record<WorkshopOrderStatus, string> = {
  sent: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  received: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};
import type {
  MarkingAssignmentListItem,
  MarkingJitCandidate,
} from "@/lib/marking/read-models/types";
