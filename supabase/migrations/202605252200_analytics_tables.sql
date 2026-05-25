-- Analytics: Ozon finance operations + custom expenses
-- 1) merch_ozon_finance_operations — mirror of /v3/finance/transaction/list
-- 2) merch_expense_categories — user-defined categories for manual expenses
-- 3) merch_expenses — manual expenses outside Ozon

create table if not exists public.merch_expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.merch_expenses (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.merch_expense_categories(id) on delete set null,
  amount numeric(12, 2) not null check (amount > 0),
  occurred_at date not null default current_date,
  description text,
  created_at timestamptz not null default now()
);

create index if not exists merch_expenses_occurred_idx on public.merch_expenses (occurred_at desc);
create index if not exists merch_expenses_category_idx on public.merch_expenses (category_id);

create table if not exists public.merch_ozon_finance_operations (
  id uuid primary key default gen_random_uuid(),
  operation_id bigint not null unique,
  operation_type text not null,
  operation_type_name text,
  operation_date timestamptz not null,
  posting_number text,
  accruals_for_sale numeric(12, 2),
  sale_commission numeric(12, 2),
  amount numeric(12, 2) not null,
  services jsonb,
  items jsonb,
  raw jsonb,
  synced_at timestamptz not null default now()
);

create index if not exists merch_ozon_finance_ops_date_idx on public.merch_ozon_finance_operations (operation_date desc);
create index if not exists merch_ozon_finance_ops_type_idx on public.merch_ozon_finance_operations (operation_type);
create index if not exists merch_ozon_finance_ops_posting_idx on public.merch_ozon_finance_operations (posting_number);

alter table public.merch_expense_categories enable row level security;
alter table public.merch_expenses enable row level security;
alter table public.merch_ozon_finance_operations enable row level security;

drop policy if exists "expense_categories_all" on public.merch_expense_categories;
create policy "expense_categories_all" on public.merch_expense_categories for all using (true) with check (true);

drop policy if exists "expenses_all" on public.merch_expenses;
create policy "expenses_all" on public.merch_expenses for all using (true) with check (true);

drop policy if exists "ozon_finance_ops_all" on public.merch_ozon_finance_operations;
create policy "ozon_finance_ops_all" on public.merch_ozon_finance_operations for all using (true) with check (true);
