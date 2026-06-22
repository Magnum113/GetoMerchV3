-- Код дизайна D### как структурное поле (раньше жил только строкой в артикуле).
-- Даёт группировку и отчётность по дизайн-коду. НЕ уникальный: один D### может
-- сидеть на нескольких строках merch_designs (напр. D008 = Gravity принт + вышивка).
-- Бэкфилл только однозначных: если у дизайна товары с одним D### — ставим его;
-- если их несколько (напр. «Itachi Swoosh» = D002 и D013) — оставляем NULL.

alter table public.merch_designs add column if not exists code text;
comment on column public.merch_designs.code is
  'Код дизайна D### из шаблона артикула. NULL у дизайнов без листинга или с неоднозначным кодом (несколько D### на один дизайн).';
create index if not exists merch_designs_code_idx on public.merch_designs (code) where code is not null;

update public.merch_designs d
set code = sub.code
from (
  select design_id, min(code) as code, count(*) as ncodes
  from (
    select distinct design_id, (regexp_match(sku, '^(D[0-9]+)-'))[1] as code
    from public.merch_products
    where design_id is not null and sku ~ '^D[0-9]+-'
  ) x
  group by design_id
) sub
where d.id = sub.design_id and sub.ncodes = 1;
