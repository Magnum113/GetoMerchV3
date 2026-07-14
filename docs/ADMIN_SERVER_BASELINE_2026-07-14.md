# Baseline админки GetoMerch перед remediation

Дата фиксации: 14 июля 2026 года.

## Серверный контур

- Домен: `https://admin.komui.ru`.
- Сервер: `89.111.152.112`.
- Service: `getomerch-admin.service`.
- Active release на момент проверки:
  `/opt/getomerch/releases/20260714T173509Z-admin-492905e1dd25`.
- Active runtime commit: `492905e1dd25`.
- `origin/main` после документационного push: `dd1be02918b0`.
- `getomerch-admin.service`: active.
- `nginx`: active.
- `komui-deploy-status`: `postgresql`, `nginx`, `komui-backend`,
  `komui-production-backend`, `komui-backup.timer`, `komui-healthcheck.timer`,
  `komui-deploy-bot` active.

## Smoke

- `https://admin.komui.ru/` без cookie: `307` на `/login`.
- `https://admin.komui.ru/login`: `200`.
- Protected admin API без cookie: `401`.
- Страницы под валидной session cookie открываются с `200`:
  `/`, `/products`, `/inventory`, `/orders`, `/settings`, `/komui/products`,
  `/komui/orders`, `/komui/import`, `/komui/runtime`.
- KOMUI prod API через админку: товары `200`, заказы `200`.
- KOMUI stage API через админку с Basic Auth: товары `200`.
- `https://komui.ru`: `200`.
- `https://stage.komui.ru` без Basic Auth: `401`; серверный smoke stage API:
  `200`.

## Supabase baseline

Проект Supabase: `GetoMerchV3`, project id `bkxpzfnglihxpbnhtjjq`.

Состояние RLS на момент проверки:

- для таблиц `public.merch_*` RLS включён;
- `relforcerowsecurity=false`;
- найдено 41 policy по `merch_*`;
- 32 policy имеют permissive `ALL` с `USING true` и `WITH CHECK true`;
- backup-таблицы `merch_products_backup_20260622` и
  `merch_products_backup_v2` имеют RLS без policies;
- `merch_storefront_products` имеет публичную read-only policy для активных
  витринных товаров;
- прямой lockdown RLS отложен до этапов BFF, иначе текущий browser-side
  Supabase UI перестанет работать.

Security Advisor на момент проверки показывает:

- `RLS Enabled No Policy` для backup-таблиц `merch_products_backup_20260622` и
  `merch_products_backup_v2`;
- `RLS Policy Always True` для административных `merch_*` таблиц;
- `Public Can Execute SECURITY DEFINER Function` для
  `public.notify_vercel_storefront_changed()`;
- `Signed-In Users Can Execute SECURITY DEFINER Function` для той же функции.

## Backup gap

До remediation существующий `/usr/local/sbin/komui-backup` покрывал магазин
KOMUI, но не включал GetoMerch admin env, systemd unit, nginx vhost и deploy
registry админки.

Для закрытия первого этапа добавлен отдельный backup-контур GetoMerch:

- script: `/usr/local/sbin/getomerch-backup`;
- service: `getomerch-backup.service`;
- timer: `getomerch-backup.timer`;
- local root: `/var/backups/getomerch`;
- encrypted daily archive: `getomerch-backup-<timestamp>.tar.gz.gpg`;
- external upload: Yandex Object Storage через существующий
  `/etc/komui/yandex-backup.env`, но с отдельным prefix `getomerch`.

Полный Supabase `pg_dump` пока требует отдельный server-side connection string
`GETOMERCH_SUPABASE_DATABASE_URL` в `/etc/getomerch/backup.env`. Без него
backup создаёт инфраструктурный архив и marker-файл о пропущенном Supabase
export. RLS/advisor baseline снят через Supabase MCP отдельно и зафиксирован в
этом документе.
