-- Generic fulfillment projection for Ozon FBS and future KOMUI orders.
--
-- This migration is additive. Ozon FBO remains analytics-only and is
-- explicitly prohibited from linking to fulfillment.

CREATE TABLE public.merch_fulfillment_orders (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    source_channel text NOT NULL,
    fulfillment_scheme text NOT NULL,
    source_order_key text NOT NULL,
    external_order_id text,
    external_posting_number text,
    source_status text NOT NULL,
    source_substatus text,
    source_created_at timestamp with time zone,
    source_updated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_fulfillment_orders_source_channel_check
      CHECK (source_channel = ANY (ARRAY['ozon_fbs'::text, 'komui'::text])),
    CONSTRAINT merch_fulfillment_orders_scheme_check
      CHECK (fulfillment_scheme = ANY (ARRAY['fbs'::text, 'd2c'::text])),
    CONSTRAINT merch_fulfillment_orders_source_scheme_check
      CHECK (
        (source_channel = 'ozon_fbs' AND fulfillment_scheme = 'fbs')
        OR (source_channel = 'komui' AND fulfillment_scheme = 'd2c')
      ),
    CONSTRAINT merch_fulfillment_orders_source_order_key_check
      CHECK (length(source_order_key) BETWEEN 1 AND 300),
    CONSTRAINT merch_fulfillment_orders_external_order_id_check
      CHECK (external_order_id IS NULL OR length(external_order_id) BETWEEN 1 AND 300),
    CONSTRAINT merch_fulfillment_orders_external_posting_check
      CHECK (
        external_posting_number IS NULL
        OR length(external_posting_number) BETWEEN 1 AND 300
      ),
    CONSTRAINT merch_fulfillment_orders_status_check
      CHECK (length(source_status) BETWEEN 1 AND 120),
    CONSTRAINT merch_fulfillment_orders_ozon_posting_check
      CHECK (
        source_channel <> 'ozon_fbs'
        OR external_posting_number = source_order_key
      ),
    UNIQUE (source_channel, source_order_key)
);

CREATE TABLE public.merch_fulfillment_order_items (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fulfillment_order_id uuid NOT NULL
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
    source_item_key text NOT NULL,
    product_id uuid REFERENCES public.merch_products(id) ON DELETE SET NULL,
    offer_id text,
    external_product_id text,
    quantity integer NOT NULL,
    marking_requirement text DEFAULT 'unknown'::text NOT NULL,
    exemplar_flow_available boolean,
    source_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_fulfillment_items_source_item_key_check
      CHECK (length(source_item_key) BETWEEN 1 AND 1000),
    CONSTRAINT merch_fulfillment_items_quantity_check CHECK (quantity > 0),
    CONSTRAINT merch_fulfillment_items_marking_requirement_check
      CHECK (
        marking_requirement = ANY (
          ARRAY['unknown'::text, 'required'::text, 'not_required'::text]
        )
      ),
    CONSTRAINT merch_fulfillment_items_offer_id_check
      CHECK (offer_id IS NULL OR length(offer_id) BETWEEN 1 AND 300),
    CONSTRAINT merch_fulfillment_items_external_product_id_check
      CHECK (
        external_product_id IS NULL
        OR length(external_product_id) BETWEEN 1 AND 200
      ),
    UNIQUE (id, fulfillment_order_id),
    UNIQUE (fulfillment_order_id, source_item_key)
);

CREATE TABLE public.merch_fulfillment_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fulfillment_order_id uuid NOT NULL
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT,
    fulfillment_item_id uuid,
    event_type text NOT NULL,
    source_revision text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT merch_fulfillment_events_type_check
      CHECK (length(event_type) BETWEEN 1 AND 120),
    CONSTRAINT merch_fulfillment_events_revision_check
      CHECK (source_revision ~ '^[0-9a-f]{64}$'),
    CONSTRAINT merch_fulfillment_events_dedupe_key_check
      CHECK (length(dedupe_key) BETWEEN 8 AND 500),
    CONSTRAINT merch_fulfillment_events_details_check
      CHECK (jsonb_typeof(details) = 'object'),
    CONSTRAINT merch_fulfillment_events_item_order_fkey
      FOREIGN KEY (fulfillment_item_id, fulfillment_order_id)
      REFERENCES public.merch_fulfillment_order_items(id, fulfillment_order_id)
      ON DELETE RESTRICT
);

ALTER TABLE public.merch_ozon_orders
    ADD COLUMN fulfillment_order_id uuid;

ALTER TABLE public.merch_ozon_order_items
    ADD COLUMN source_item_key text,
    ADD COLUMN ozon_product_id text,
    ADD COLUMN marking_requirement text DEFAULT 'unknown'::text NOT NULL,
    ADD COLUMN exemplar_flow_available boolean,
    ADD COLUMN source_active boolean DEFAULT true NOT NULL,
    ADD COLUMN fulfillment_item_id uuid,
    ADD COLUMN updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL;

UPDATE public.merch_ozon_order_items
SET source_item_key =
      'ozon:v1:'
      || encode(convert_to(offer_id, 'UTF8'), 'hex')
      || ':'
      || encode(convert_to(coalesce(ozon_sku, ''), 'UTF8'), 'hex'),
    ozon_product_id = ozon_sku,
    updated_at = clock_timestamp()
WHERE source_item_key IS NULL;

DO $collision_check$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.merch_ozon_order_items
    GROUP BY order_id, source_item_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'existing Ozon order items contain ambiguous source item keys';
  END IF;
END
$collision_check$;

ALTER TABLE public.merch_ozon_order_items
    ALTER COLUMN source_item_key SET NOT NULL,
    ADD CONSTRAINT merch_ozon_order_items_source_item_key_check
      CHECK (length(source_item_key) BETWEEN 1 AND 1000),
    ADD CONSTRAINT merch_ozon_order_items_marking_requirement_check
      CHECK (
        marking_requirement = ANY (
          ARRAY['unknown'::text, 'required'::text, 'not_required'::text]
        )
      ),
    ADD CONSTRAINT merch_ozon_order_items_ozon_product_id_check
      CHECK (
        ozon_product_id IS NULL
        OR length(ozon_product_id) BETWEEN 1 AND 200
      ),
    ADD CONSTRAINT merch_ozon_order_items_fulfillment_item_id_fkey
      FOREIGN KEY (fulfillment_item_id)
      REFERENCES public.merch_fulfillment_order_items(id) ON DELETE RESTRICT;

ALTER TABLE public.merch_ozon_orders
    ADD CONSTRAINT merch_ozon_orders_fbo_fulfillment_check
      CHECK (source IS DISTINCT FROM 'fbo' OR fulfillment_order_id IS NULL)
      NOT VALID,
    ADD CONSTRAINT merch_ozon_orders_fulfillment_order_id_fkey
      FOREIGN KEY (fulfillment_order_id)
      REFERENCES public.merch_fulfillment_orders(id) ON DELETE RESTRICT;

ALTER TABLE public.merch_ozon_orders
    VALIDATE CONSTRAINT merch_ozon_orders_fbo_fulfillment_check;

CREATE UNIQUE INDEX merch_ozon_order_items_source_key
  ON public.merch_ozon_order_items (order_id, source_item_key);
CREATE UNIQUE INDEX merch_ozon_orders_fulfillment_order
  ON public.merch_ozon_orders (fulfillment_order_id)
  WHERE fulfillment_order_id IS NOT NULL;
CREATE UNIQUE INDEX merch_ozon_order_items_fulfillment_item
  ON public.merch_ozon_order_items (fulfillment_item_id)
  WHERE fulfillment_item_id IS NOT NULL;
CREATE INDEX merch_ozon_order_items_active_order
  ON public.merch_ozon_order_items (order_id, source_active, id);
CREATE INDEX merch_fulfillment_orders_status
  ON public.merch_fulfillment_orders (
    source_channel,
    source_status,
    source_updated_at DESC
  );
CREATE INDEX merch_fulfillment_items_product
  ON public.merch_fulfillment_order_items (product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX merch_fulfillment_items_marking
  ON public.merch_fulfillment_order_items (
    marking_requirement,
    source_active,
    updated_at DESC
  );
CREATE INDEX merch_fulfillment_events_order_created
  ON public.merch_fulfillment_events (
    fulfillment_order_id,
    created_at DESC,
    id DESC
  );
CREATE INDEX merch_fulfillment_events_item_created
  ON public.merch_fulfillment_events (
    fulfillment_item_id,
    created_at DESC,
    id DESC
  )
  WHERE fulfillment_item_id IS NOT NULL;

REVOKE ALL
  ON public.merch_fulfillment_orders,
     public.merch_fulfillment_order_items,
     public.merch_fulfillment_events
  FROM getomerch_app;
GRANT SELECT, INSERT, UPDATE
  ON public.merch_fulfillment_orders,
     public.merch_fulfillment_order_items
  TO getomerch_app;
GRANT SELECT, INSERT
  ON public.merch_fulfillment_events
  TO getomerch_app;
GRANT SELECT
  ON public.merch_fulfillment_orders,
     public.merch_fulfillment_order_items,
     public.merch_fulfillment_events
  TO getomerch_backup;
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO getomerch_app;
GRANT SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO getomerch_backup;
