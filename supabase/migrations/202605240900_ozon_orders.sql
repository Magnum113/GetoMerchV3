-- Ozon orders sync + fulfillment from local warehouse

create table if not exists public.merch_ozon_orders (
  id uuid primary key default gen_random_uuid(),
  posting_number text not null unique,
  order_id bigint,
  order_number text,
  status text not null,
  substatus text,
  ozon_created_at timestamptz,
  in_process_at timestamptz,
  shipment_date timestamptz,
  delivery_method text,
  warehouse_name text,
  customer_name text,
  total_price numeric(12, 2),
  raw jsonb,
  synced_at timestamptz not null default now(),
  shipped_at timestamptz,
  shipped_from_warehouse_id uuid references public.merch_warehouses(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists merch_ozon_orders_status_idx on public.merch_ozon_orders (status);
create index if not exists merch_ozon_orders_shipped_idx on public.merch_ozon_orders (shipped_at);
create index if not exists merch_ozon_orders_created_idx on public.merch_ozon_orders (ozon_created_at desc);

create table if not exists public.merch_ozon_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.merch_ozon_orders(id) on delete cascade,
  offer_id text not null,
  ozon_sku text,
  name text,
  quantity integer not null,
  price numeric(12, 2),
  product_id uuid references public.merch_products(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists merch_ozon_order_items_order_idx on public.merch_ozon_order_items (order_id);
create index if not exists merch_ozon_order_items_offer_idx on public.merch_ozon_order_items (offer_id);
create index if not exists merch_ozon_order_items_product_idx on public.merch_ozon_order_items (product_id);

alter table public.merch_ozon_orders enable row level security;
alter table public.merch_ozon_order_items enable row level security;

drop policy if exists "ozon_orders_all" on public.merch_ozon_orders;
create policy "ozon_orders_all" on public.merch_ozon_orders for all using (true) with check (true);

drop policy if exists "ozon_order_items_all" on public.merch_ozon_order_items;
create policy "ozon_order_items_all" on public.merch_ozon_order_items for all using (true) with check (true);
