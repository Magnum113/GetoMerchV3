-- Allow deletion of merch_designs:
-- merch_products.design_id → CASCADE (finished SKU без дизайна не имеет смысла; через каскад
--   уйдут и записи в merch_inventory, история в merch_transactions сохранится через SET NULL)
-- merch_workshop_order_items.design_id → SET NULL (заказ в цех остаётся как историческая запись)

alter table public.merch_products
  drop constraint if exists merch_products_design_id_fkey;
alter table public.merch_products
  add constraint merch_products_design_id_fkey
  foreign key (design_id) references public.merch_designs(id) on delete cascade;

alter table public.merch_workshop_order_items
  drop constraint if exists merch_workshop_order_items_design_id_fkey;
alter table public.merch_workshop_order_items
  add constraint merch_workshop_order_items_design_id_fkey
  foreign key (design_id) references public.merch_designs(id) on delete set null;
