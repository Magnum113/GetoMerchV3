-- Добавляем в каталог 12 товаров, которые есть в Ozon, но не было в merch_products.
-- 9 из них — «коллизионные» варианты (отличаются version/fit/fabric от существующих)
-- и стали возможны только после variant_aware_uniqueness.
-- FK (категория/ткань/цвет/дизайн/нанесение) клонируем у товара-«соседа» по sku,
-- размер берём из merch_sizes по имени. Идемпотентно (where not exists).

with src(new_sku, ozon_sku, ver, fit, fab, size_name, template) as (
  values
    ('var16-v2-Print-GreyW-S',  4804394600::bigint, 'V02', null::text, null::text, 'S',   'var16-Print-GreyW-M'),
    ('var16-v2-Print-GreyW-M',  4799474628,         'V02', null,       null,       'M',   'var16-Print-GreyW-M'),
    ('var16-v2-Print-GreyW-L',  4804399361,         'V02', null,       null,       'L',   'var16-Print-GreyW-M'),
    ('var16-v2-Print-GreyW-XL', 4804402770,         'V02', null,       null,       'XL',  'var16-Print-GreyW-M'),
    ('var16-v2-Print-GreyW-XXL',4804409520,         'V02', null,       null,       'XXL', 'var16-Print-GreyW-M'),
    ('var18-Hoodie-Emb-Black-S',3134088915,         'V01', 'CRP',      'NF',       'S',   'var18-Hoodie2-Emb-Black-S'),
    ('var18-Hoodie-Emb-Black-M',3134088448,         'V01', 'CRP',      'NF',       'M',   'var18-Hoodie2-Emb-Black-S'),
    ('var18-Hoodie-Emb-Black-L',3134088781,         'V01', 'CRP',      'NF',       'L',   'var18-Hoodie2-Emb-Black-S'),
    ('var8-Hoodie-Emb-White-S', 3134088911,         'V01', 'REG',      'FLC',      'S',   'var8-Hoodie-Emb-Real-White-S'),
    ('var16-Print-WBeige-M',    4823033517,         'V01', null,       null,       'M',   'var16-Print-WBeige-S'),
    ('var16-Print-WBeige-L',    4823129177,         'V01', null,       null,       'L',   'var16-Print-WBeige-S'),
    ('var16-Print-WBeige-XL',   4823130195,         'V01', null,       null,       'XL',  'var16-Print-WBeige-S')
)
insert into public.merch_products
  (category_id, fabric_id, color_id, size_id, design_id, decoration_type_id,
   is_blank, sku, ozon_sku, design_version, hoodie_fit, hoodie_fabric, cost_price)
select t.category_id, t.fabric_id, t.color_id, s.id, t.design_id, t.decoration_type_id,
       false, src.new_sku, src.ozon_sku, src.ver, src.fit, src.fab, t.cost_price
from src
join public.merch_products t on t.sku = src.template
join public.merch_sizes s on s.name = src.size_name
where not exists (select 1 from public.merch_products x where x.sku = src.new_sku);

-- Пересопоставляем висящие позиции заказов (product_id IS NULL), которые теперь
-- нашли свой товар (например историю продаж укороченного худи var18-Hoodie).
update public.merch_ozon_order_items oi
set product_id = p.id
from public.merch_products p
where oi.product_id is null
  and (oi.offer_id = p.sku or oi.offer_id = any(p.legacy_skus));
