-- Снимаем check «product_id или design_id обязателен».
-- Он мешает ON DELETE SET NULL: при удалении товара строка транзакции,
-- у которой не было design_id, уходит в (null, null) и check падает.
-- Целостность на INSERT обеспечивается прикладным кодом (api.receive/sale/produce/etc.).

alter table public.merch_transactions
  drop constraint if exists merch_transactions_subject_check;
