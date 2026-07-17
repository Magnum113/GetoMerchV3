BEGIN;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET search_path = public, pg_catalog;
CREATE TABLE public.merch_warehouses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    address text,
    contact text,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.merch_product_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.merch_fabric_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.merch_colors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    hex_code text,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.merch_sizes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.merch_designs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    image_url text,
    created_at timestamp with time zone DEFAULT now(),
    type text DEFAULT 'print'::text NOT NULL,
    code text
);
CREATE TABLE public.merch_decoration_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    made_at text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.merch_products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid NOT NULL,
    fabric_id uuid NOT NULL,
    color_id uuid NOT NULL,
    size_id uuid NOT NULL,
    design_id uuid,
    decoration_type_id uuid,
    sku text,
    is_blank boolean DEFAULT false NOT NULL,
    cost_price numeric(10,2),
    sale_price numeric(10,2),
    created_at timestamp with time zone DEFAULT now(),
    legacy_skus text[] DEFAULT '{}'::text[] NOT NULL,
    ozon_sku bigint,
    design_version text,
    hoodie_fit text,
    hoodie_fabric text
);
CREATE TABLE public.merch_inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.merch_print_inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    design_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.merch_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    product_id uuid,
    from_warehouse_id uuid,
    to_warehouse_id uuid,
    quantity integer NOT NULL,
    source_product_id uuid,
    workshop_order_id uuid,
    notes text,
    occurred_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    design_id uuid,
    source_design_id uuid
);
CREATE TABLE public.merch_workshop_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_number text,
    workshop_id uuid NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    sent_at timestamp with time zone,
    completed_at timestamp with time zone,
    received_at timestamp with time zone
);
CREATE TABLE public.merch_workshop_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    blank_product_id uuid,
    design_id uuid NOT NULL,
    decoration_type_id uuid NOT NULL,
    result_product_id uuid,
    quantity integer NOT NULL,
    notes text,
    design_version text,
    hoodie_fit text,
    hoodie_fabric text
);
CREATE TABLE public.merch_ozon_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    posting_number text NOT NULL,
    order_id bigint,
    order_number text,
    status text NOT NULL,
    substatus text,
    ozon_created_at timestamp with time zone,
    in_process_at timestamp with time zone,
    shipment_date timestamp with time zone,
    delivery_method text,
    warehouse_name text,
    customer_name text,
    total_price numeric(12,2),
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    shipped_at timestamp with time zone,
    shipped_from_warehouse_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workshop_order_id uuid,
    source text
);
CREATE TABLE public.merch_ozon_order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    offer_id text NOT NULL,
    ozon_sku text,
    name text,
    quantity integer NOT NULL,
    price numeric(12,2),
    product_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shipped_from_warehouse_id uuid
);
CREATE TABLE public.merch_ozon_finance_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id bigint NOT NULL,
    operation_type text NOT NULL,
    operation_type_name text,
    operation_date timestamp with time zone NOT NULL,
    posting_number text,
    accruals_for_sale numeric(12,2),
    sale_commission numeric(12,2),
    amount numeric(12,2) NOT NULL,
    services jsonb,
    items jsonb,
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.merch_expense_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text,
    sort_order integer DEFAULT 0 NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.merch_expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid,
    amount numeric(12,2) NOT NULL,
    occurred_at date DEFAULT CURRENT_DATE NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.merch_ozon_import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'preview'::text NOT NULL,
    mode text DEFAULT 'ozon_products'::text NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone
);
CREATE TABLE public.merch_ozon_import_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    offer_id text NOT NULL,
    ozon_product_id bigint,
    ozon_sku bigint,
    ozon_name text,
    status text NOT NULL,
    severity text NOT NULL,
    match_reason text DEFAULT 'none'::text NOT NULL,
    target_product_id uuid,
    parsed jsonb,
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    errors text[] DEFAULT '{}'::text[] NOT NULL,
    warnings text[] DEFAULT '{}'::text[] NOT NULL,
    applied_at timestamp with time zone,
    apply_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE OR REPLACE FUNCTION public.update_inventory_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

COMMIT;
