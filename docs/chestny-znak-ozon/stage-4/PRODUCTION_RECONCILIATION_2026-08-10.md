# Production reconciliation этапа 4

Дата: 10 августа 2026 года.
База: `getomerch_production` на VPS.
Режим: внешние marking write flags выключены.

## Источники

- актуальный каталог Ozon: 138 футболок;
- реестр Национального каталога после импорта: 146 карточек;
- точный манифест:
  `product-profile-manifest-2026-08-10.json`;
- импорт семи новых GTIN в НК: `11887008`.

В манифест включены только точные соответствия seller SKU, Ozon SKU и GTIN.
Восемь legacy GTIN без активного Ozon offer и две локальные D12, отсутствующие
в Ozon, исключены из применения.

## Выполнение

1. Production preview: 138 create, 0 conflicts.
2. Создан backup
   `getomerch-database-backup-20260810T114821Z.tar.gz.gpg`; проверка архива и
   off-site upload успешны.
3. Apply: 138 обработано, 124 enabled, 14 paused, 0 failed.
4. Повторный apply: 138 reconcile, 0 create, 0 conflicts, 0 failed.
5. Audit: 138 profile upsert, 131 GTIN verification, 138 operational status;
   failed audit records отсутствуют.
6. Первая сквозная проверка обнаружила обрезание микросекунд в readiness
   cursor. Cursor исправлен на сохранение точного PostgreSQL timestamp; после
   исправления обход всех страниц возвращает полный манифест без пропусков.

## Фактическое состояние

| Состояние | Количество |
|---|---:|
| Profiles | 138 |
| Verified profiles | 131 |
| Draft profiles | 7 |
| Enabled / readiness ready | 124 |
| Paused / readiness blocked | 14 |
| Verified trade items | 131 |
| Verified product mapping evidence | 131 |
| Ozon requirement conflicts | 7 |
| Ошибки применения | 0 |

Семь draft profiles соответствуют карточкам D26/D27, которые фактически
показываются в НК со статусом `На модерации`. Семь verified paused profiles
соответствуют SKU, по которым последний сохранённый FBS snapshot Ozon сообщил
`not_required`:

- `D16-TSH-PRT-WGRY-XXL`;
- `D23-TSH-PRT-WGRY-M`;
- `D23-TSH-PRT-WGRY-S`;
- `D2-TSH-EMB-BLK-2XL`;
- `D3-TSH-EMB-BLK-S`;
- `D8-TSH-PRT-WGRY-M`;
- `D8-TSH-PRT-WHT-L`.

## Повторная процедура

Preview без записи:

```bash
npm run marking:profiles:reconcile
```

Проверка уже применённого состояния:

```bash
npm run marking:profiles:verify
```

Apply разрешён только после нулевого количества structural conflicts и
актуального backup:

```bash
npm run marking:profiles:reconcile -- --apply
```

После модерации D26/D27 нельзя просто включать вручную. Сначала карточки
подписываются УКЭП и проверяется `Опубликована`, затем обновляются семь
статусов в манифесте и повторяется полный preview/apply/verify.
