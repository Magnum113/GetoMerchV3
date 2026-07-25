-- Preselected finished product for workshop items that originate from an Ozon order.
--
-- After the Ozon article migration the finished-combo
-- (category, fabric, color, size, design, decoration) is no longer unique: several
-- merch_products can share the same attributes (e.g. a legacy card kept alongside its new
-- D### twin). Re-deriving the finished product by attributes at workshop intake could then
-- match more than one row and raise ambiguous_product_variant, blocking "Произвели и отправили".
--
-- Ozon-sourced items already know the exact product_id of the order line, so we carry it here
-- and use it directly at intake instead of findOrCreateProductInternal. Manual workshop orders
-- leave this NULL and keep the attribute-based lookup.

ALTER TABLE public.merch_workshop_order_items
    ADD COLUMN target_product_id uuid;

ALTER TABLE public.merch_workshop_order_items
    ADD CONSTRAINT merch_workshop_order_items_target_product_id_fkey
    FOREIGN KEY (target_product_id) REFERENCES public.merch_products(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.merch_workshop_order_items.target_product_id IS
    'Заранее известный готовый товар (для позиций из заказа Ozon — product_id позиции заказа). '
    'При приёмке используется напрямую вместо поиска по атрибутам, чтобы дубли finished-combo '
    'в каталоге не давали ambiguous_product_variant. NULL — искать/создавать товар по атрибутам.';
