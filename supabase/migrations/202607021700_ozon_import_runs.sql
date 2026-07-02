-- История dry-run/apply импортов товаров из Ozon в основную админку.

create table if not exists public.merch_ozon_import_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'preview',
  mode text not null default 'ozon_products',
  summary jsonb not null default '{}'::jsonb,
  options jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

alter table public.merch_ozon_import_runs
  drop constraint if exists merch_ozon_import_runs_status_check;

alter table public.merch_ozon_import_runs
  add constraint merch_ozon_import_runs_status_check
  check (status in ('preview', 'applying', 'applied', 'partial', 'failed'));

create index if not exists merch_ozon_import_runs_created_idx
  on public.merch_ozon_import_runs (created_at desc);

create table if not exists public.merch_ozon_import_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.merch_ozon_import_runs(id) on delete cascade,
  offer_id text not null,
  ozon_product_id bigint,
  ozon_sku bigint,
  ozon_name text,
  status text not null,
  severity text not null,
  match_reason text not null default 'none',
  target_product_id uuid references public.merch_products(id) on delete set null,
  parsed jsonb,
  plan jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  errors text[] not null default '{}',
  warnings text[] not null default '{}',
  applied_at timestamptz,
  apply_error text,
  created_at timestamptz not null default now()
);

alter table public.merch_ozon_import_items
  drop constraint if exists merch_ozon_import_items_status_check;

alter table public.merch_ozon_import_items
  add constraint merch_ozon_import_items_status_check
  check (status in ('new_design', 'new_product', 'update', 'noop', 'conflict', 'skipped', 'applied', 'error'));

alter table public.merch_ozon_import_items
  drop constraint if exists merch_ozon_import_items_severity_check;

alter table public.merch_ozon_import_items
  add constraint merch_ozon_import_items_severity_check
  check (severity in ('info', 'warning', 'error'));

create unique index if not exists merch_ozon_import_items_run_offer_key
  on public.merch_ozon_import_items (run_id, offer_id);

create index if not exists merch_ozon_import_items_run_idx
  on public.merch_ozon_import_items (run_id);

create index if not exists merch_ozon_import_items_status_idx
  on public.merch_ozon_import_items (status);

create index if not exists merch_ozon_import_items_offer_idx
  on public.merch_ozon_import_items (offer_id);

-- Защита от дублей при повторном импорте новых дизайнов.
create unique index if not exists merch_designs_code_type_unique
  on public.merch_designs (code, type)
  where code is not null;

alter table public.merch_ozon_import_runs enable row level security;
alter table public.merch_ozon_import_items enable row level security;

drop policy if exists "ozon_import_runs_all" on public.merch_ozon_import_runs;
create policy "ozon_import_runs_all"
  on public.merch_ozon_import_runs for all
  using (true)
  with check (true);

drop policy if exists "ozon_import_items_all" on public.merch_ozon_import_items;
create policy "ozon_import_items_all"
  on public.merch_ozon_import_items for all
  using (true)
  with check (true);
