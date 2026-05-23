create table if not exists public.merch_print_inventory (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references public.merch_designs(id) on delete cascade,
  warehouse_id uuid not null references public.merch_warehouses(id) on delete cascade,
  quantity integer not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  unique (design_id, warehouse_id)
);

create index if not exists merch_print_inventory_design_idx on public.merch_print_inventory (design_id);
create index if not exists merch_print_inventory_warehouse_idx on public.merch_print_inventory (warehouse_id);

alter table public.merch_print_inventory enable row level security;
drop policy if exists "print_inventory_all" on public.merch_print_inventory;
create policy "print_inventory_all" on public.merch_print_inventory for all using (true) with check (true);

alter table public.merch_transactions alter column product_id drop not null;
alter table public.merch_transactions add column if not exists design_id uuid references public.merch_designs(id) on delete set null;
alter table public.merch_transactions add column if not exists source_design_id uuid references public.merch_designs(id) on delete set null;
alter table public.merch_transactions drop constraint if exists merch_transactions_subject_check;
alter table public.merch_transactions add constraint merch_transactions_subject_check
  check (product_id is not null or design_id is not null);
