-- Разделение артикула var17 на var17 (Сатору Годжо) и var19 (Сатору Honored)
-- В Ozon под одним offer_id отображались 2 разных дизайна. Белые футболки переехали в var19.

insert into public.merch_designs (name, type, description)
values ('Сатору Honored', 'print', 'Отделён от var17 (Сатору Годжо) — белые футболки')
on conflict do nothing;

update public.merch_products p
set
  sku = replace(p.sku, 'var17-Print-White-', 'var19-Print-White-'),
  design_id = (select id from public.merch_designs where name = 'Сатору Honored' limit 1)
where p.sku in (
  'var17-Print-White-S',
  'var17-Print-White-M',
  'var17-Print-White-L',
  'var17-Print-White-XL',
  'var17-Print-White-XXL'
);
