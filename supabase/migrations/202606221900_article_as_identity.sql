-- Сдвиг идентичности готового товара на артикул.
-- Идентичность = sku (UNIQUE) + ozon_sku (новый UNIQUE по маркетплейсу).
-- Составной finished-combo перестаёт быть «несущим» уникальным ключом —
-- делаем его обычным (для скорости поиска в findOrCreateProduct).
-- version/fit/fabric остаются как ОПИСАТЕЛЬНЫЕ поля (не входят в идентичность).
-- Защита от дублей: UNIQUE(sku) + UNIQUE(ozon_sku) + buildSku (дописывает вариант).
-- Заготовки (blanks) сохраняют строгую уникальность по атрибутам — у них нет артикула.

-- настоящая идентичность по маркетплейсу
create unique index if not exists merch_products_ozon_sku_key
  on public.merch_products (ozon_sku) where ozon_sku is not null;
drop index if exists public.merch_products_ozon_sku_idx;  -- заменён уникальным

-- finished-combo: UNIQUE -> обычный индекс
drop index if exists public.idx_merch_products_finished_combo;
create index if not exists idx_merch_products_finished_combo
  on public.merch_products (category_id, fabric_id, color_id, size_id, design_id, decoration_type_id)
  where is_blank = false;
