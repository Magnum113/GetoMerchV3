-- Legacy offer_id aliases for products that were renamed in Ozon.
-- Used by the sync route to keep historical orders matched to the renamed product.

alter table public.merch_products add column if not exists legacy_skus text[] not null default '{}';
create index if not exists merch_products_legacy_skus_gin on public.merch_products using gin (legacy_skus);

update public.merch_products p
set legacy_skus = array_append(coalesce(p.legacy_skus, '{}'), replace(p.sku, 'var19-Print-White-', 'var17-Print-White-'))
where p.sku like 'var19-Print-White-%'
  and not ('var17-Print-White-' || split_part(p.sku, 'var19-Print-White-', 2) = any(coalesce(p.legacy_skus, '{}')));
