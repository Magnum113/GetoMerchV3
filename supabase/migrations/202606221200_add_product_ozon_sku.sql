-- Стабильный числовой Ozon SKU на товар.
-- В отличие от offer_id (merch_products.sku), числовой Ozon SKU НЕ меняется
-- при переименовании артикула в Ozon — это долговечный идентификатор,
-- переживающий миграцию offer_id (var* → D###).
-- Бэкфилл — из Ozon API по offer_id (см. sku_mapping/backfill-ozon-sku.mjs).

alter table public.merch_products
  add column if not exists ozon_sku bigint;

comment on column public.merch_products.ozon_sku is
  'Числовой Ozon SKU. Стабилен при переименовании offer_id. Бэкфилл из Ozon API по offer_id/legacy_skus.';

create index if not exists merch_products_ozon_sku_idx
  on public.merch_products (ozon_sku)
  where ozon_sku is not null;
