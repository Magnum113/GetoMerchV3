alter table public.merch_storefront_products
  add column if not exists badges text[] not null default '{}',
  add column if not exists sales_6m_units integer not null default 0,
  add column if not exists sales_6m_revenue numeric(12,2) not null default 0,
  add column if not exists sales_6m_rank integer,
  add column if not exists sales_6m_period_start date,
  add column if not exists sales_6m_period_end date,
  add column if not exists sales_6m_updated_at timestamptz;

create index if not exists merch_storefront_products_badges_gin_idx
  on public.merch_storefront_products using gin (badges);
