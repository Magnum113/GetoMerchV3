alter table public.merch_ozon_order_items
  add column if not exists shipped_from_warehouse_id uuid references public.merch_warehouses(id) on delete set null;
