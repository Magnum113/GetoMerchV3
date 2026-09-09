import {
  mapFinanceAccrual,
  normalizeFinanceAccrualRange,
  type OzonFinanceAccrual,
} from "@/lib/ozon/finance-accruals";

const types = new Map([
  [1, { name: "Acquiring", description: "Эквайринг" }],
  [32, { name: "Logistic", description: "Логистика" }],
  [76, { name: "StockInsurance", description: "Страхование товара" }],
]);

const posting = mapFinanceAccrual({
  accrual_id: 61_765_929_990,
  date: "2026-09-02",
  total_amount: rub("2196.64"),
  unit_number: "TEST-POSTING-1",
  accrued_category: "POSTING",
  posting: {
    delivery_schema: "Fbo",
    products: [{
      sku: 4_804_394_600,
      delivery: {
        total_accrued: rub("-97.75"),
        services: [{ type_id: 32, accrued: rub("-97.75") }],
      },
      commission: {
        seller_price: rub("4692"),
        sale_commission: rub("-2397.61"),
      },
    }],
  },
}, types);

expect(posting.amount === 2196.64, "posting amount");
expect(posting.accruals_for_sale === 4692, "posting revenue");
expect(posting.sale_commission === -2397.61, "posting commission");
expect(posting.posting?.posting_number === "TEST-POSTING-1", "posting number");
expect(posting.items[0]?.sku === 4_804_394_600, "posting SKU");
expect(posting.services.length === 1 && posting.services[0].price === -97.75, "delivery service");
expect(posting.raw._getomerch_source === "finance_accrual_by_day", "source marker");

const item = mapFinanceAccrual({
  accrual_id: 61_657_160_362,
  date: "2026-09-01",
  total_amount: rub("-28.05"),
  unit_number: "TEST-ITEM-1",
  accrued_category: "ITEM",
  item_fees: {
    fees: [{ sku: 4_933_962_506, fees: [{ type_id: 1, accrued: rub("-28.05") }] }],
  },
}, types);

expect(item.posting === null, "item fee must not masquerade as a posting");
expect(item.services.length === 1 && item.services[0].name === "Acquiring", "item fee service");
expect(item.items[0]?.sku === 4_933_962_506, "item fee SKU");

const nonItem = mapFinanceAccrual({
  accrual_id: 61_624_178_246,
  date: "2026-09-01",
  total_amount: rub("-103.42"),
  accrued_category: "NON_ITEM",
  non_item_fee: { type_id: 76, accrued: rub("-103.42") },
}, types);

expect(nonItem.services.length === 0, "non-item fee must remain in the residual dashboard bucket");
expect(nonItem.operation_type_name === "Страхование товара", "non-item fee description");

expectThrows(() => mapFinanceAccrual({
  accrual_id: 1,
  date: "2026-09-01",
  total_amount: rub("100"),
  non_item_fee: { type_id: 76, accrued: rub("-10") },
}, types), "unbalanced accrual");

const range = normalizeFinanceAccrualRange(
  "2026-09-01T12:00:00.000Z",
  "2026-09-03T08:00:00.000Z",
);
expect(range.replaceFrom === "2026-09-01T00:00:00.000Z", "range start");
expect(range.replaceTo === "2026-09-04T00:00:00.000Z", "range end");
expect(range.dates.join(",") === "2026-09-01,2026-09-02,2026-09-03", "range dates");

console.log("ok - Ozon finance accrual adapter preserves dashboard semantics and validates balances");

function rub(amount: string) {
  return { amount, currency: "RUB" };
}

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(`Expected ${message}`);
}

function expectThrows(operation: () => OzonFinanceAccrual | unknown, message: string) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`Expected ${message} to throw`);
}
