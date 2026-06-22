alter table public.merch_storefront_products
  add column if not exists short_description text;
