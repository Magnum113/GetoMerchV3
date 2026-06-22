create table if not exists public.merch_storefront_products (
  id uuid primary key default gen_random_uuid(),
  design_key text not null unique,
  ozon_variant text not null,
  name text not null,
  slug text not null unique,
  description text,
  ozon_description text,
  category text not null,
  category_slug text not null,
  product_type text not null,
  product_type_slug text not null,
  decoration_type text not null,
  decoration_slug text not null,
  color_name text,
  color_slug text,
  color_hex text,
  franchise_type text not null default 'anime',
  title_name text,
  title_slug text,
  anime_title text,
  anime_slug text,
  character_name text,
  character_slug text,
  collection_name text,
  collection_slug text,
  design_name text,
  design_slug text,
  tags text[] not null default '{}',
  sizes text[] not null default '{}',
  price_min numeric(12,2),
  price_max numeric(12,2),
  currency text not null default 'RUB',
  primary_image_url text,
  main_image_path text,
  image_urls text[] not null default '{}',
  ozon_product_ids bigint[] not null default '{}',
  ozon_skus bigint[] not null default '{}',
  ozon_offer_ids text[] not null default '{}',
  offers jsonb not null default '[]'::jsonb,
  ozon_attributes jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists merch_storefront_products_active_sort_idx
  on public.merch_storefront_products (is_active, sort_order);

create index if not exists merch_storefront_products_catalog_filters_idx
  on public.merch_storefront_products (
    category_slug,
    product_type_slug,
    decoration_slug,
    color_slug,
    title_slug,
    anime_slug
  );

create index if not exists merch_storefront_products_tags_gin_idx
  on public.merch_storefront_products using gin (tags);

create index if not exists merch_storefront_products_sizes_gin_idx
  on public.merch_storefront_products using gin (sizes);

create index if not exists merch_storefront_products_offers_gin_idx
  on public.merch_storefront_products using gin (offers);

create index if not exists merch_storefront_products_source_payload_gin_idx
  on public.merch_storefront_products using gin (source_payload);

alter table public.merch_storefront_products enable row level security;

drop policy if exists "Public storefront products are readable" on public.merch_storefront_products;
create policy "Public storefront products are readable"
  on public.merch_storefront_products
  for select
  to anon, authenticated
  using (is_active = true);
