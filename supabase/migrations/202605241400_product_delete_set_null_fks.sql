-- Разрешаем удаление товаров из каталога, не теряя историю:
-- транзакции и позиции заказов сохраняются с product_id = NULL.
-- Остатки удаляются каскадом (если товар удалён, его склад-карточка не нужна).

alter table public.merch_transactions
  drop constraint if exists merch_transactions_product_id_fkey;
alter table public.merch_transactions
  add constraint merch_transactions_product_id_fkey
  foreign key (product_id) references public.merch_products(id) on delete set null;

alter table public.merch_transactions
  drop constraint if exists merch_transactions_source_product_id_fkey;
alter table public.merch_transactions
  add constraint merch_transactions_source_product_id_fkey
  foreign key (source_product_id) references public.merch_products(id) on delete set null;

alter table public.merch_inventory
  drop constraint if exists merch_inventory_product_id_fkey;
alter table public.merch_inventory
  add constraint merch_inventory_product_id_fkey
  foreign key (product_id) references public.merch_products(id) on delete cascade;

alter table public.merch_workshop_order_items
  alter column blank_product_id drop not null;
alter table public.merch_workshop_order_items
  drop constraint if exists merch_workshop_order_items_blank_product_id_fkey;
alter table public.merch_workshop_order_items
  add constraint merch_workshop_order_items_blank_product_id_fkey
  foreign key (blank_product_id) references public.merch_products(id) on delete set null;

alter table public.merch_workshop_order_items
  drop constraint if exists merch_workshop_order_items_result_product_id_fkey;
alter table public.merch_workshop_order_items
  add constraint merch_workshop_order_items_result_product_id_fkey
  foreign key (result_product_id) references public.merch_products(id) on delete set null;
