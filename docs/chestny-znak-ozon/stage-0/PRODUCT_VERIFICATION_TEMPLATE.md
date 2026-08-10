# Product verification record

Одна запись заполняется на один пилотный GTIN/SKU до заказа КМ.

## Identity

| Поле | Значение |
|---|---|
| Verification ID | |
| Checked at | |
| Checked by | |
| Internal product ID | |
| Offer ID / артикул | |
| Ozon product ID | |
| Ozon seller SKU | |
| GTIN-14 | |
| National Catalog card ID | |

## Product attributes

| Поле | Значение | Source | Verified |
|---|---|---|---|
| Вид изделия | | | no |
| Размер INT | | | no |
| Размер RU | | | no |
| Цвет | | | no |
| Состав | | | no |
| ТН ВЭД | | | no |
| Технический регламент | | | no |
| Модель производства | | | no |
| Fulfillment marking mode | | | no |

Допустимые значения модели производства:

- `own_production`;
- `pre_marked_minor_customization`;
- `remarking_after_customization`.

Допустимые значения fulfillment marking mode:

- `jit_after_order`;
- `prebuilt_stock`;
- `pre_marked_minor_customization`.

## National Catalog identity and diagnostics

| Проверка | Значение | Source | Verified |
|---|---|---|---|
| Карточка опубликована | | | no |
| Владелец карточки совпадает | | | no |
| `goodMarkFlag` (справочно) | | | no |
| `goodTurnFlag` (справочно) | | | no |
| Разрешительный документ (справочно) | | | no |

Справочные строки не являются readiness/canary gate и не запрещают заказ КМ,
нанесение, ввод в оборот или продажу.

## CRPT/SUZ readiness

| Проверка | Значение | Verified |
|---|---|---|
| `productGroup` | `lp` | yes |
| `releaseMethodType` | `PRODUCTION` | yes |
| `templateId` | `10` | yes |
| `cisType` | `UNIT` | yes |
| `serialNumberType` | `OPERATOR` | no |
| Production `omsId` доступен | | no |
| `omsConnection` доступен | | no |
| Signer готов | | no |

Runtime identifiers и секреты в эту карточку не вставляются. Фиксируется только
наличие и ссылка на secret manager key name.

## Ozon readiness

| Проверка | Значение | Verified |
|---|---|---|
| Posting требует mandatory mark | | no |
| Найден Ozon product ID внутри posting | | no |
| Create-or-get contract version | `v6` | yes |
| Validate contract version | `v5` | yes |
| Set contract version | `v6` | yes |
| Status contract version | `v5` | yes |
| Update contract version | `v1` | yes |

## Decision

- Verification status: `draft | blocked | ready_for_sandbox | ready_for_canary`
- Blocking reasons:
- Reviewer:
- Review date:

Запись `ready_for_canary` запрещена, если не подтверждены GTIN, модель
производства, владение товарной карточкой или точный Ozon exemplar contract.
Отсутствие РД и диагностические флаги Национального каталога не блокируют
статус.
