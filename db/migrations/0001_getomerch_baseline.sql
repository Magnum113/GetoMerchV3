-- Reviewed baseline of the 20-table GetoMerch migration scope.
-- Source snapshot: Supabase public schema, 2026-07-16.
-- Supabase roles, grants, RLS policies, platform schemas, storefront objects,
-- and backup tables are intentionally excluded.
-- Transaction boundaries are owned by db/scripts/migrate.mjs.

SET LOCAL search_path = public, pg_catalog;

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
ALTER TABLE ONLY public.merch_warehouses ADD CONSTRAINT merch_warehouses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_product_categories ADD CONSTRAINT merch_product_categories_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_fabric_types ADD CONSTRAINT merch_fabric_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_colors ADD CONSTRAINT merch_colors_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_sizes ADD CONSTRAINT merch_sizes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_designs ADD CONSTRAINT merch_designs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_decoration_types ADD CONSTRAINT merch_decoration_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_inventory ADD CONSTRAINT merch_inventory_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_print_inventory ADD CONSTRAINT merch_print_inventory_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_workshop_orders ADD CONSTRAINT merch_workshop_orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_workshop_order_items ADD CONSTRAINT merch_workshop_order_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_ozon_orders ADD CONSTRAINT merch_ozon_orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_ozon_order_items ADD CONSTRAINT merch_ozon_order_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_ozon_finance_operations ADD CONSTRAINT merch_ozon_finance_operations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_expense_categories ADD CONSTRAINT merch_expense_categories_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_expenses ADD CONSTRAINT merch_expenses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_ozon_import_runs ADD CONSTRAINT merch_ozon_import_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_ozon_import_items ADD CONSTRAINT merch_ozon_import_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.merch_product_categories ADD CONSTRAINT merch_product_categories_name_key UNIQUE (name);
ALTER TABLE ONLY public.merch_product_categories ADD CONSTRAINT merch_product_categories_slug_key UNIQUE (slug);
ALTER TABLE ONLY public.merch_fabric_types ADD CONSTRAINT merch_fabric_types_name_key UNIQUE (name);
ALTER TABLE ONLY public.merch_fabric_types ADD CONSTRAINT merch_fabric_types_slug_key UNIQUE (slug);
ALTER TABLE ONLY public.merch_colors ADD CONSTRAINT merch_colors_name_key UNIQUE (name);
ALTER TABLE ONLY public.merch_sizes ADD CONSTRAINT merch_sizes_name_key UNIQUE (name);
ALTER TABLE ONLY public.merch_decoration_types ADD CONSTRAINT merch_decoration_types_name_key UNIQUE (name);
ALTER TABLE ONLY public.merch_decoration_types ADD CONSTRAINT merch_decoration_types_slug_key UNIQUE (slug);
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_sku_key UNIQUE (sku);
ALTER TABLE ONLY public.merch_inventory ADD CONSTRAINT merch_inventory_product_id_warehouse_id_key UNIQUE (product_id, warehouse_id);
ALTER TABLE ONLY public.merch_print_inventory ADD CONSTRAINT merch_print_inventory_design_id_warehouse_id_key UNIQUE (design_id, warehouse_id);
ALTER TABLE ONLY public.merch_workshop_orders ADD CONSTRAINT merch_workshop_orders_order_number_key UNIQUE (order_number);
ALTER TABLE ONLY public.merch_ozon_orders ADD CONSTRAINT merch_ozon_orders_posting_number_key UNIQUE (posting_number);
ALTER TABLE ONLY public.merch_ozon_finance_operations ADD CONSTRAINT merch_ozon_finance_operations_operation_id_key UNIQUE (operation_id);
ALTER TABLE ONLY public.merch_warehouses ADD CONSTRAINT merch_warehouses_type_check CHECK (type = ANY (ARRAY['own'::text, 'workshop'::text]));
ALTER TABLE ONLY public.merch_designs ADD CONSTRAINT merch_designs_type_check CHECK (type = ANY (ARRAY['print'::text, 'embroidery'::text]));
ALTER TABLE ONLY public.merch_decoration_types ADD CONSTRAINT merch_decoration_types_made_at_check CHECK (made_at = ANY (ARRAY['own'::text, 'workshop'::text]));
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT design_decoration_consistency CHECK (is_blank = true AND design_id IS NULL AND decoration_type_id IS NULL OR is_blank = false AND design_id IS NOT NULL AND decoration_type_id IS NOT NULL);
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_hoodie_fabric_chk CHECK (hoodie_fabric IS NULL OR (hoodie_fabric = ANY (ARRAY['FLC'::text, 'NF'::text])));
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_hoodie_fit_chk CHECK (hoodie_fit IS NULL OR (hoodie_fit = ANY (ARRAY['REG'::text, 'CRP'::text])));
ALTER TABLE ONLY public.merch_inventory ADD CONSTRAINT merch_inventory_quantity_check CHECK (quantity >= 0);
ALTER TABLE ONLY public.merch_print_inventory ADD CONSTRAINT merch_print_inventory_quantity_check CHECK (quantity >= 0);
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_quantity_check CHECK (quantity > 0);
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_type_check CHECK (type = ANY (ARRAY['receive'::text, 'transfer'::text, 'sale'::text, 'production'::text, 'adjustment'::text, 'writeoff'::text]));
ALTER TABLE ONLY public.merch_workshop_orders ADD CONSTRAINT merch_workshop_orders_status_check CHECK (status = ANY (ARRAY['sent'::text, 'ready'::text, 'received'::text, 'cancelled'::text]));
ALTER TABLE ONLY public.merch_workshop_order_items ADD CONSTRAINT merch_workshop_order_items_quantity_check CHECK (quantity > 0);
ALTER TABLE ONLY public.merch_expenses ADD CONSTRAINT merch_expenses_amount_check CHECK (amount > 0::numeric);
ALTER TABLE ONLY public.merch_ozon_import_runs ADD CONSTRAINT merch_ozon_import_runs_status_check CHECK (status = ANY (ARRAY['preview'::text, 'applying'::text, 'applied'::text, 'partial'::text, 'failed'::text]));
ALTER TABLE ONLY public.merch_ozon_import_items ADD CONSTRAINT merch_ozon_import_items_severity_check CHECK (severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text]));
ALTER TABLE ONLY public.merch_ozon_import_items ADD CONSTRAINT merch_ozon_import_items_status_check CHECK (status = ANY (ARRAY['new_design'::text, 'new_product'::text, 'update'::text, 'noop'::text, 'conflict'::text, 'skipped'::text, 'applied'::text, 'error'::text]));
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_category_id_fkey FOREIGN KEY (category_id) REFERENCES merch_product_categories(id);
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_color_id_fkey FOREIGN KEY (color_id) REFERENCES merch_colors(id);
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_decoration_type_id_fkey FOREIGN KEY (decoration_type_id) REFERENCES merch_decoration_types(id);
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_design_id_fkey FOREIGN KEY (design_id) REFERENCES merch_designs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_fabric_id_fkey FOREIGN KEY (fabric_id) REFERENCES merch_fabric_types(id);
ALTER TABLE ONLY public.merch_products ADD CONSTRAINT merch_products_size_id_fkey FOREIGN KEY (size_id) REFERENCES merch_sizes(id);
ALTER TABLE ONLY public.merch_inventory ADD CONSTRAINT merch_inventory_product_id_fkey FOREIGN KEY (product_id) REFERENCES merch_products(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_inventory ADD CONSTRAINT merch_inventory_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES merch_warehouses(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_print_inventory ADD CONSTRAINT merch_print_inventory_design_id_fkey FOREIGN KEY (design_id) REFERENCES merch_designs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_print_inventory ADD CONSTRAINT merch_print_inventory_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES merch_warehouses(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_design_id_fkey FOREIGN KEY (design_id) REFERENCES merch_designs(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES merch_warehouses(id);
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_product_id_fkey FOREIGN KEY (product_id) REFERENCES merch_products(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_source_design_id_fkey FOREIGN KEY (source_design_id) REFERENCES merch_designs(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_source_product_id_fkey FOREIGN KEY (source_product_id) REFERENCES merch_products(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES merch_warehouses(id);
ALTER TABLE ONLY public.merch_transactions ADD CONSTRAINT merch_transactions_workshop_order_id_fkey FOREIGN KEY (workshop_order_id) REFERENCES merch_workshop_orders(id);
ALTER TABLE ONLY public.merch_workshop_orders ADD CONSTRAINT merch_workshop_orders_workshop_id_fkey FOREIGN KEY (workshop_id) REFERENCES merch_warehouses(id);
ALTER TABLE ONLY public.merch_workshop_order_items ADD CONSTRAINT merch_workshop_order_items_blank_product_id_fkey FOREIGN KEY (blank_product_id) REFERENCES merch_products(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_workshop_order_items ADD CONSTRAINT merch_workshop_order_items_decoration_type_id_fkey FOREIGN KEY (decoration_type_id) REFERENCES merch_decoration_types(id);
ALTER TABLE ONLY public.merch_workshop_order_items ADD CONSTRAINT merch_workshop_order_items_design_id_fkey FOREIGN KEY (design_id) REFERENCES merch_designs(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_workshop_order_items ADD CONSTRAINT merch_workshop_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES merch_workshop_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_workshop_order_items ADD CONSTRAINT merch_workshop_order_items_result_product_id_fkey FOREIGN KEY (result_product_id) REFERENCES merch_products(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_ozon_orders ADD CONSTRAINT merch_ozon_orders_shipped_from_warehouse_id_fkey FOREIGN KEY (shipped_from_warehouse_id) REFERENCES merch_warehouses(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_ozon_orders ADD CONSTRAINT merch_ozon_orders_workshop_order_id_fkey FOREIGN KEY (workshop_order_id) REFERENCES merch_workshop_orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_ozon_order_items ADD CONSTRAINT merch_ozon_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES merch_ozon_orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_ozon_order_items ADD CONSTRAINT merch_ozon_order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES merch_products(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_ozon_order_items ADD CONSTRAINT merch_ozon_order_items_shipped_from_warehouse_id_fkey FOREIGN KEY (shipped_from_warehouse_id) REFERENCES merch_warehouses(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_expenses ADD CONSTRAINT merch_expenses_category_id_fkey FOREIGN KEY (category_id) REFERENCES merch_expense_categories(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.merch_ozon_import_items ADD CONSTRAINT merch_ozon_import_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES merch_ozon_import_runs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.merch_ozon_import_items ADD CONSTRAINT merch_ozon_import_items_target_product_id_fkey FOREIGN KEY (target_product_id) REFERENCES merch_products(id) ON DELETE SET NULL;
CREATE INDEX merch_designs_code_idx ON public.merch_designs USING btree (code) WHERE (code IS NOT NULL);
CREATE UNIQUE INDEX merch_designs_code_type_unique ON public.merch_designs USING btree (code, type) WHERE (code IS NOT NULL);
CREATE UNIQUE INDEX idx_merch_products_blank_combo ON public.merch_products USING btree (category_id, fabric_id, color_id, size_id) WHERE (is_blank = true);
CREATE INDEX idx_merch_products_finished_combo ON public.merch_products USING btree (category_id, fabric_id, color_id, size_id, design_id, decoration_type_id) WHERE (is_blank = false);
CREATE INDEX merch_products_legacy_skus_gin ON public.merch_products USING gin (legacy_skus);
CREATE UNIQUE INDEX merch_products_ozon_sku_key ON public.merch_products USING btree (ozon_sku) WHERE (ozon_sku IS NOT NULL);
CREATE INDEX idx_inventory_product ON public.merch_inventory USING btree (product_id);
CREATE INDEX idx_inventory_warehouse ON public.merch_inventory USING btree (warehouse_id);
CREATE INDEX merch_print_inventory_design_idx ON public.merch_print_inventory USING btree (design_id);
CREATE INDEX merch_print_inventory_warehouse_idx ON public.merch_print_inventory USING btree (warehouse_id);
CREATE INDEX idx_transactions_date ON public.merch_transactions USING btree (occurred_at DESC);
CREATE INDEX idx_transactions_product ON public.merch_transactions USING btree (product_id);
CREATE INDEX idx_workshop_items_order ON public.merch_workshop_order_items USING btree (order_id);
CREATE INDEX merch_ozon_orders_created_idx ON public.merch_ozon_orders USING btree (ozon_created_at DESC);
CREATE INDEX merch_ozon_orders_shipped_idx ON public.merch_ozon_orders USING btree (shipped_at);
CREATE INDEX merch_ozon_orders_source_idx ON public.merch_ozon_orders USING btree (source);
CREATE INDEX merch_ozon_orders_status_idx ON public.merch_ozon_orders USING btree (status);
CREATE INDEX merch_ozon_orders_workshop_order_idx ON public.merch_ozon_orders USING btree (workshop_order_id);
CREATE INDEX merch_ozon_order_items_offer_idx ON public.merch_ozon_order_items USING btree (offer_id);
CREATE INDEX merch_ozon_order_items_order_idx ON public.merch_ozon_order_items USING btree (order_id);
CREATE INDEX merch_ozon_order_items_product_idx ON public.merch_ozon_order_items USING btree (product_id);
CREATE INDEX merch_ozon_finance_ops_date_idx ON public.merch_ozon_finance_operations USING btree (operation_date DESC);
CREATE INDEX merch_ozon_finance_ops_posting_idx ON public.merch_ozon_finance_operations USING btree (posting_number);
CREATE INDEX merch_ozon_finance_ops_type_idx ON public.merch_ozon_finance_operations USING btree (operation_type);
CREATE INDEX merch_expenses_category_idx ON public.merch_expenses USING btree (category_id);
CREATE INDEX merch_expenses_occurred_idx ON public.merch_expenses USING btree (occurred_at DESC);
CREATE INDEX merch_ozon_import_runs_created_idx ON public.merch_ozon_import_runs USING btree (created_at DESC);
CREATE INDEX merch_ozon_import_items_offer_idx ON public.merch_ozon_import_items USING btree (offer_id);
CREATE INDEX merch_ozon_import_items_run_idx ON public.merch_ozon_import_items USING btree (run_id);
CREATE UNIQUE INDEX merch_ozon_import_items_run_offer_key ON public.merch_ozon_import_items USING btree (run_id, offer_id);
CREATE INDEX merch_ozon_import_items_status_idx ON public.merch_ozon_import_items USING btree (status);
CREATE TRIGGER trg_inventory_updated_at BEFORE UPDATE ON merch_inventory FOR EACH ROW EXECUTE FUNCTION update_inventory_timestamp();

