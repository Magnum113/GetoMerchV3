import assert from "node:assert/strict";
import {
  allocateOrderResources,
  productBlankKey,
} from "@/lib/ozon/order-resource-allocation";
import type { OzonOrder, OzonOrderItem, Product } from "@/lib/types";

const ownWarehouse = "own";
const workshopWarehouse = "workshop";

run();

function run() {
  blockedOrderDoesNotReservePrint();
  productionQueueSkipsSizesWithoutBlanks();
  partialKitDoesNotReserveMaterials();
  multiItemOrderRollsBackEveryResource();
  earlierExecutableOrderKeepsPriority();
  console.log("Ozon order resource allocation checks passed.");
}

function productionQueueSkipsSizesWithoutBlanks() {
  const xl = product("finished-xl", "blank-xl", "gojo", "xl");
  const sizeS = product("finished-s", "blank-s", "gojo", "s");
  const beigeXl = product("finished-beige-xl", "blank-beige-xl", "gojo", "xl");
  const xxl = product("finished-xxl", "blank-xxl", "gojo", "xxl");
  const result = allocate([
    order("xl-1", [item("xl-1-item", xl)]),
    order("s-1", [item("s-1-item", sizeS)]),
    order("xl-2", [item("xl-2-item", xl)]),
    order("s-2", [item("s-2-item", sizeS)]),
    order("beige-xl", [item("beige-xl-item", beigeXl)]),
    order("xxl", [item("xxl-item", xxl)]),
  ], {
    "blank-xl": 22,
    "blank-s": 0,
    "blank-beige-xl": 0,
    "blank-xxl": 16,
  }, { gojo: 4 });

  assert.equal(result.get("xl-1-item")?.canOwnProduce, true);
  assert.equal(result.get("xl-2-item")?.canOwnProduce, true);
  assert.equal(result.get("xxl-item")?.canOwnProduce, true);
  assert.equal(result.get("s-1-item")?.canOwnProduce, false);
  assert.equal(result.get("s-2-item")?.canOwnProduce, false);
  assert.equal(result.get("beige-xl-item")?.canOwnProduce, false);
}

function blockedOrderDoesNotReservePrint() {
  const blockedProduct = product("finished-s", "blank-s", "design", "size-s");
  const executableProduct = product("finished-xl", "blank-xl", "design", "size-xl");
  const blocked = order("blocked", [item("blocked-item", blockedProduct)]);
  const executable = order("executable", [item("executable-item", executableProduct)]);
  const result = allocate([blocked, executable], {
    "blank-s": 0,
    "blank-xl": 1,
  }, { design: 1 });

  assert.equal(result.get("blocked-item")?.canOwnProduce, false);
  assert.equal(result.get("executable-item")?.canOwnProduce, true);
  assert.equal(result.get("executable-item")?.print, 1);
}

function partialKitDoesNotReserveMaterials() {
  const largeProduct = product("finished-large", "blank-shared", "design", "size-shared");
  const smallProduct = product("finished-small", "blank-shared", "design", "size-shared");
  const blocked = order("needs-two", [item("needs-two-item", largeProduct, 2)]);
  const executable = order("needs-one", [item("needs-one-item", smallProduct)]);
  const result = allocate([blocked, executable], { "blank-shared": 1 }, { design: 2 });

  assert.equal(result.get("needs-two-item")?.canOwnProduce, false);
  assert.equal(result.get("needs-one-item")?.canOwnProduce, true);
}

function multiItemOrderRollsBackEveryResource() {
  const possible = product("finished-a", "blank-a", "design-a", "size-a");
  const impossible = product("finished-b", "blank-b", "design-b", "size-b");
  const blocked = order("multi", [
    item("multi-a", possible),
    item("multi-b", impossible),
  ]);
  const later = order("later", [item("later-a", possible)]);
  const result = allocate(
    [blocked, later],
    { "blank-a": 1, "blank-b": 0 },
    { "design-a": 1, "design-b": 1 },
  );

  assert.equal(result.get("multi-b")?.canOwnProduce, false);
  assert.equal(result.get("later-a")?.canOwnProduce, true);
}

function earlierExecutableOrderKeepsPriority() {
  const shared = product("finished", "blank", "design", "size");
  const first = order("first", [item("first-item", shared)]);
  const second = order("second", [item("second-item", shared)]);
  const result = allocate([first, second], { blank: 1 }, { design: 1 });

  assert.equal(result.get("first-item")?.canOwnProduce, true);
  assert.equal(result.get("second-item")?.canOwnProduce, false);
}

function allocate(
  orders: OzonOrder[],
  blanks: Record<string, number>,
  prints: Record<string, number>,
) {
  const blankProducts = new Map<string, Product>();
  const productStock = new Map<string, Map<string, number>>();
  for (const currentOrder of orders) {
    for (const orderItem of currentOrder.items ?? []) {
      const finished = orderItem.product!;
      productStock.set(finished.id, new Map([[ownWarehouse, 0]]));
      const blankId = finished.fabric_id;
      if (!blankProducts.has(blankId)) {
        const blank = blankProduct(blankId, finished);
        blankProducts.set(blankId, blank);
        productStock.set(blank.id, new Map([[ownWarehouse, blanks[blankId] ?? 0]]));
      }
    }
  }
  return allocateOrderResources({
    orders,
    productStock,
    printStock: new Map(Object.entries(prints).map(([designId, quantity]) => [
      designId,
      new Map([[ownWarehouse, quantity]]),
    ])),
    blankByKey: new Map([...blankProducts.values()].map((blank) => [
      productBlankKey(blank.category_id, blank.fabric_id, blank.color_id, blank.size_id),
      blank,
    ])),
    warehouseTypeById: new Map([
      [ownWarehouse, "own"],
      [workshopWarehouse, "workshop"],
    ]),
    warehouseNameById: new Map([
      [ownWarehouse, "Мой склад"],
      [workshopWarehouse, "Цех"],
    ]),
  });
}

function order(id: string, items: OzonOrderItem[]): OzonOrder {
  return {
    id,
    posting_number: id,
    order_id: null,
    order_number: null,
    status: "awaiting_packaging",
    substatus: null,
    ozon_created_at: null,
    in_process_at: null,
    shipment_date: null,
    delivery_method: null,
    warehouse_name: null,
    customer_name: null,
    total_price: null,
    source: "fbs",
    synced_at: "2026-08-13T00:00:00Z",
    shipped_at: null,
    shipped_from_warehouse_id: null,
    workshop_order_id: null,
    notes: null,
    created_at: "2026-08-13T00:00:00Z",
    items,
  };
}

function item(id: string, value: Product, quantity = 1): OzonOrderItem {
  return {
    id,
    order_id: id,
    offer_id: id,
    ozon_sku: null,
    name: id,
    quantity,
    price: null,
    product_id: value.id,
    product: value,
  };
}

function product(id: string, blankId: string, designId: string, sizeId: string): Product {
  return {
    id,
    category_id: "category",
    fabric_id: blankId,
    color_id: "color",
    size_id: sizeId,
    design_id: designId,
    decoration_type_id: "print",
    sku: id,
    ozon_sku: null,
    design_version: null,
    hoodie_fit: null,
    hoodie_fabric: null,
    is_blank: false,
    cost_price: null,
    sale_price: null,
    created_at: "2026-08-13T00:00:00Z",
    decoration_type: {
      id: "print",
      name: "Принт",
      slug: "print",
      made_at: "own",
      created_at: "2026-08-13T00:00:00Z",
    },
  };
}

function blankProduct(id: string, finished: Product): Product {
  return {
    ...finished,
    id,
    sku: id,
    design_id: null,
    decoration_type_id: null,
    is_blank: true,
    decoration_type: null,
  };
}
