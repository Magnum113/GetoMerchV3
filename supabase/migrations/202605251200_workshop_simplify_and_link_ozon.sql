-- Collapse 'pending' and 'in_progress' into 'sent'.
update merch_workshop_orders
set status = 'sent',
    sent_at = coalesce(sent_at, created_at, now())
where status in ('pending', 'in_progress');

alter table merch_workshop_orders drop constraint if exists merch_workshop_orders_status_check;
alter table merch_workshop_orders
  add constraint merch_workshop_orders_status_check
  check (status in ('sent', 'ready', 'received', 'cancelled'));

alter table merch_workshop_orders alter column status set default 'sent';

-- Link an Ozon order to the workshop order spawned from it.
alter table merch_ozon_orders
  add column if not exists workshop_order_id uuid
  references merch_workshop_orders(id) on delete set null;

create index if not exists merch_ozon_orders_workshop_order_idx
  on merch_ozon_orders(workshop_order_id);
