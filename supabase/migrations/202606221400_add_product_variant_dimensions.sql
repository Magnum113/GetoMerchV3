-- Измерения варианта, которые кодирует новый шаблон артикула, но которых
-- не было в модели каталога:
--   design_version  — версия макета (V01, V02 …) для всех изделий;
--   hoodie_fit      — посадка худи (REG/CRP), NULL для не-худи;
--   hoodie_fabric   — ткань худи (FLC с начёсом / NF без), NULL для не-худи.
--
-- ФАЗА 1: добавляем как метаданные. Уникальный индекс finished-combo и
-- findOrCreateProduct здесь НЕ трогаем — это отдельная фаза, нужная только
-- когда в каталоге появятся два варианта одного комбо (V01+V02, REG+CRP и т.п.).
-- Бэкфилл — из sku-mapping.csv (см. sku_mapping/backfill-variant-dims.mjs).

alter table public.merch_products
  add column if not exists design_version text,
  add column if not exists hoodie_fit text,
  add column if not exists hoodie_fabric text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'merch_products_hoodie_fit_chk') then
    alter table public.merch_products
      add constraint merch_products_hoodie_fit_chk
      check (hoodie_fit is null or hoodie_fit in ('REG', 'CRP'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'merch_products_hoodie_fabric_chk') then
    alter table public.merch_products
      add constraint merch_products_hoodie_fabric_chk
      check (hoodie_fabric is null or hoodie_fabric in ('FLC', 'NF'));
  end if;
end $$;

comment on column public.merch_products.design_version is
  'Версия макета (V01, V02 …). Кодируется сегментом Vxx в артикуле. NULL у авто-SKU вне Ozon.';
comment on column public.merch_products.hoodie_fit is
  'Посадка худи: REG / CRP. NULL для не-худи.';
comment on column public.merch_products.hoodie_fabric is
  'Ткань худи: FLC (с начёсом) / NF (без начёса). NULL для не-худи.';
