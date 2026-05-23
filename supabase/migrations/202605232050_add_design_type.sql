alter table public.merch_designs
  add column if not exists type text default 'print';

alter table public.merch_designs
  drop constraint if exists merch_designs_type_check;

alter table public.merch_designs
  add constraint merch_designs_type_check
  check (type in ('print', 'embroidery'));

insert into public.merch_designs (name, description, image_url, type)
select
  'Gravity (вышивка)',
  'Импортировано из Ozon',
  'https://cdn1.ozone.ru/s3/multimedia-1-1/7676186005.jpg',
  'embroidery'
where not exists (
  select 1 from public.merch_designs where name = 'Gravity (вышивка)'
);

update public.merch_products p
set design_id = d_emb.id
from public.merch_designs d_print
cross join public.merch_designs d_emb
join public.merch_decoration_types dt on dt.slug = 'embroidery'
where d_print.name in ('Gravity', 'Gravity (принт)')
  and d_emb.name = 'Gravity (вышивка)'
  and p.design_id = d_print.id
  and p.decoration_type_id = dt.id;

update public.merch_designs
set
  name = 'Gravity (принт)',
  image_url = 'https://cdn1.ozone.ru/s3/multimedia-1-3/7676186007.jpg'
where name = 'Gravity';

update public.merch_designs
set type = 'embroidery'
where lower(name) like '%вышив%'
  or lower(name) like '%emb%';

update public.merch_designs
set type = 'print'
where type is null
  or lower(name) like '%принт%'
  or lower(name) like '%print%'
  or name in ('Gravity (принт)', 'Сатору Годжо (варёнка)', 'Сатору Годжо (обычная)');

alter table public.merch_designs
  alter column type set not null;
