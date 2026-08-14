# Открытые вопросы и стоп-условия

Дата ревизии: `2026-07-26`.

## Открытые вопросы

| ID | Вопрос | Владелец | Срок пересмотра | Блокирует |
|---|---|---|---|---|
| S0-04 | Когда появится реальный FBS posting с непустым `products_requiring_mandatory_mark` для пилотного товара? | operations | при первом таком заказе | только production observation fixture |
| S0-05 | Какие Ozon statuses и identifiers приходят при отмене до передачи, возврате продавцу и автоматическом переводе возврата в FBO? | operations + integration | до этапа 12 | returns automation |
| S0-06 | Какой production `omsId` используется и создано ли внешнее подключение `omsConnection`? | platform owner | до этапа 9 | True API/SUZ auth |
| S0-07 | Какой МОД должен использовать ИП для `LK_RECEIPT action=DISTANCE`: `fias_id`, а при наличии юридического лица - какой `kpp`? | владелец бизнеса / compliance | до этапа 11 | вывод из оборота |
| S0-08 | Нужен ли `document_type` для конкретного FBS дистанционного вывода или он остается опциональным; какой Ozon документ является первичным? | compliance + integration | до этапа 11 | withdrawal payload |
| S0-09 | Какой источник события надежно подтверждает фактическую передачу FBS shipment Ozon? | operations + integration | до этапа 11 | момент вывода |

Сроки здесь привязаны к этапам, а не к календарю: вопрос нельзя закрывать
предположением только ради перехода дальше.

## Уже разрешенные вопросы

| Вопрос | Ответ | Источник |
|---|---|---|
| Какая товарная группа СУЗ? | `lp` | API СУЗ 3.0 |
| Какой способ выпуска? | `PRODUCTION` | API СУЗ 3.0 |
| Какой шаблон КМ? | `templateId=10` | API СУЗ 3.0 |
| Нужен ли ручной отчет о нанесении для футболок? | Нет, для легкой промышленности отчет создается автоматически | API СУЗ 3.0 |
| Какой документ ввода в оборот? | `LP_INTRODUCE_GOODS`, `production_type=OWN_PRODUCTION` | True API |
| Какой документ дистанционного вывода? | `LK_RECEIPT`, `action=DISTANCE` | True API |
| Как вернуть целый код после дистанционной продажи? | `LP_RETURN`, `return_type=REMOTE_SALE_RETURN` | True API |
| Каковы актуальные exemplar endpoints Ozon? | `v6 create-or-get`, `v5 validate`, `v6 set`, `v5 status`, `v1 update` | официальная документация Ozon Seller API |
| Где РД является gate? | Не блокирует readiness, заказ/импорт, назначение, печать и нанесение КМ; обязательный fail-closed gate перед `LP_INTRODUCE_GOODS` | True API v716.0 и production canary 14.08.2026 |

## Стоп-условия

До закрытия соответствующего вопроса запрещено:

- вызывать Ozon write endpoints до реализации idempotency, feature flag,
  allow-list и canary-процедуры соответствующего этапа;
- автоматически выводить товар из оборота при неустановленном событии передачи;
- выполнять автоматический `LP_RETURN` только по marketplace status без
  подтверждения маршрута товара и состояния КМ;
- помещать runtime `omsId`, `omsConnection`, токены, подписи или полный КМ в
  документацию, fixture или лог.

## Evidence policy

Допустимые evidence:

- актуальная официальная документация;
- sanitized production read-only response;
- redacted contract snapshot;
- фактически обработанный sandbox/canary документ;
- данные Национального каталога и ГИС МТ.

Переписка со службой поддержки не используется как requirement, evidence,
production gate или замена проверяемому API-контракту.

Отсутствие РД и значения `goodMarkFlag`/`goodTurnFlag` отображаются для
диагностики и не запрещают заказ КМ, назначение, печать или нанесение.
Передача `LP_INTRODUCE_GOODS` и последующие Ozon set/shipping запрещены, пока
вид, номер и дата применимого документа соответствия не проверены.
