export type WarehouseType = "own" | "workshop";
export type DecorationLocation = "own" | "workshop";

export type WorkshopOrderStatus =
  | "pending"
  | "sent"
  | "in_progress"
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
  product_id: string;
  from_warehouse_id: string | null;
  to_warehouse_id: string | null;
  quantity: number;
  source_product_id: string | null;
  workshop_order_id: string | null;
  notes: string | null;
  occurred_at: string;
  created_at: string;
  product?: Product;
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
  blank_product_id: string;
  design_id: string;
  decoration_type_id: string;
  result_product_id: string | null;
  quantity: number;
  notes: string | null;
  blank_product?: Product;
  design?: Design;
  decoration_type?: DecorationType;
  result_product?: Product | null;
}

export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  receive: "Приёмка",
  transfer: "Перемещение",
  sale: "Продажа",
  production: "Производство",
  adjustment: "Корректировка",
  writeoff: "Списание",
};

export const WORKSHOP_STATUS_LABELS: Record<WorkshopOrderStatus, string> = {
  pending: "Черновик",
  sent: "Отправлено в цех",
  in_progress: "В работе",
  ready: "Готово",
  received: "Получено",
  cancelled: "Отменено",
};

export const WORKSHOP_STATUS_COLORS: Record<WorkshopOrderStatus, string> = {
  pending: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  sent: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  in_progress: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  received: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};
