-- ФАЗА B: делаем version/fit/fabric РАЗЛИЧАЮЩИМ измерением каталога,
-- чтобы в нём могли сосуществовать несколько вариантов одного комбо
-- (V01+V02, REG+CRP, FLC+NF) — например var16 / var16-v2, var18-Hoodie / Hoodie2.

-- 1) У всех готовых SKU версия должна быть проставлена (дефолт V01), иначе
--    NULL-версии ломали бы матчинг в findOrCreateProduct (NULL != 'V01').
update public.merch_products
set design_version = 'V01'
where is_blank = false and design_version is null;

-- 2) Перестраиваем уникальный индекс готовых, добавляя 3 измерения.
--    NULLS NOT DISTINCT — чтобы две не-худи строки с NULL fit/fabric считались
--    дубликатами (как и раньше), а различие давали только реально заданные dims.
drop index if exists public.idx_merch_products_finished_combo;
create unique index idx_merch_products_finished_combo
  on public.merch_products (
    category_id, fabric_id, color_id, size_id,
    design_id, decoration_type_id,
    design_version, hoodie_fit, hoodie_fabric
  )
  nulls not distinct
  where is_blank = false;

-- 3) Позиция заказа в цех несёт целевой вариант худи — чтобы приёмка
--    (findOrCreateProduct) однозначно выбрала нужный готовый SKU, когда у
--    дизайна есть несколько посадок/тканей.
alter table public.merch_workshop_order_items
  add column if not exists design_version text,
  add column if not exists hoodie_fit text,
  add column if not exists hoodie_fabric text;
