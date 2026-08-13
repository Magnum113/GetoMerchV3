import type { OzonOrder, OzonOrderItem, Product, Warehouse } from "@/lib/types";

export type StockStatus = "ready" | "partial" | "needs_production" | "missing" | "unmatched";

export interface WarehouseQuantity {
  warehouseId: string;
  warehouseName: string;
  qty: number;
}

export interface ItemAvailability {
  status: StockStatus;
  finished: number;
  blank: number;
  blankAtWorkshop: number;
  blankAtOwn: number;
  print: number;
  blankProduct: Product | null;
  need: number;
  finishedByWh: WarehouseQuantity[];
  blankByWh: WarehouseQuantity[];
  isPrint: boolean;
  hasPrintInfo: boolean;
  printShort: boolean;
  canOwnProduce: boolean;
  needsWorkshopTransfer: boolean;
  workshopTransferQty: number;
}

type QuantityPool = Map<string, Map<string, number>>;

export type OrderResourceAllocationInput = {
  /** Orders must already be sorted in the priority used for fulfillment. */
  orders: OzonOrder[];
  productStock: QuantityPool;
  printStock: QuantityPool;
  blankByKey: Map<string, Product>;
  warehouseTypeById: Map<string, Warehouse["type"]>;
  warehouseNameById: Map<string, string>;
};

/**
 * Builds a soft allocation for the operations screen. A blocked order never
 * consumes resources from the shared planning pool; the server transaction is
 * still the final authority when an order is fulfilled.
 */
export function allocateOrderResources(input: OrderResourceAllocationInput) {
  let productRemaining = clonePool(input.productStock);
  let printRemaining = clonePool(input.printStock);
  const availabilityByItem = new Map<string, ItemAvailability>();
  const blockedOrders: OzonOrder[] = [];

  for (const order of input.orders) {
    const productTrial = clonePool(productRemaining);
    const printTrial = clonePool(printRemaining);
    const trial = allocateOrder(order, productTrial, printTrial, input);

    if (canCommitOrder(order, trial)) {
      productRemaining = productTrial;
      printRemaining = printTrial;
      copyAvailability(trial, availabilityByItem);
    } else {
      blockedOrders.push(order);
    }
  }

  // Blocked orders do not compete with each other. Recalculate each one from
  // the pool left after executable orders so badges show unallocated stock.
  for (const order of blockedOrders) {
    const diagnostic = allocateOrder(
      order,
      clonePool(productRemaining),
      clonePool(printRemaining),
      input,
    );
    copyAvailability(diagnostic, availabilityByItem);
  }

  return availabilityByItem;
}

export function productBlankKey(
  categoryId: string,
  fabricId: string,
  colorId: string,
  sizeId: string,
) {
  return `${categoryId}|${fabricId}|${colorId}|${sizeId}`;
}

function allocateOrder(
  order: OzonOrder,
  productRemaining: QuantityPool,
  printRemaining: QuantityPool,
  input: OrderResourceAllocationInput,
) {
  const result = new Map<string, ItemAvailability>();
  for (const item of order.items ?? []) {
    result.set(item.id, allocateItem(item, productRemaining, printRemaining, input));
  }
  return result;
}

function allocateItem(
  item: OzonOrderItem,
  productRemaining: QuantityPool,
  printRemaining: QuantityPool,
  input: OrderResourceAllocationInput,
): ItemAvailability {
  const need = item.quantity;
  const product = item.product;
  if (!product) return unmatchedAvailability(need);

  const isPrint = product.decoration_type?.made_at !== "workshop";
  const finishedPeek = peek(
    productRemaining,
    product.id,
    false,
    input.warehouseTypeById,
    input.warehouseNameById,
  );
  const finished = Math.min(need, finishedPeek.total);
  const finishedByWh = take(
    productRemaining,
    product.id,
    finished,
    false,
    false,
    input,
  );
  const remainingNeed = need - finished;
  const blankProduct = input.blankByKey.get(productBlankKey(
    product.category_id,
    product.fabric_id,
    product.color_id,
    product.size_id,
  )) ?? null;

  let blank = 0;
  let blankAtWorkshop = 0;
  let blankAtOwn = 0;
  let blankByWh: WarehouseQuantity[] = [];
  let print = 0;
  const hasPrintInfo = isPrint && Boolean(product.design_id);

  if (blankProduct) {
    const blankPeek = peek(
      productRemaining,
      blankProduct.id,
      isPrint,
      input.warehouseTypeById,
      input.warehouseNameById,
    );
    blank = blankPeek.total;
    blankByWh = blankPeek.list;
    blankAtWorkshop = isPrint
      ? 0
      : sumByWarehouseType(blankPeek.list, "workshop", input.warehouseTypeById);
    blankAtOwn = sumByWarehouseType(blankPeek.list, "own", input.warehouseTypeById);
  }
  if (hasPrintInfo) {
    print = peek(
      printRemaining,
      product.design_id!,
      true,
      input.warehouseTypeById,
      input.warehouseNameById,
    ).total;
  }

  // A print and a blank are one production kit. Never reserve either resource
  // without the other. Embroidery only consumes a blank at this planning stage.
  const productionQuantity = hasPrintInfo
    ? Math.min(remainingNeed, blank, print)
    : Math.min(remainingNeed, blank);
  if (productionQuantity > 0 && blankProduct) {
    take(productRemaining, blankProduct.id, productionQuantity, isPrint, !isPrint, input);
    if (hasPrintInfo) {
      take(printRemaining, product.design_id!, productionQuantity, true, false, input);
    }
  }

  let status: StockStatus;
  if (finished >= need) status = "ready";
  else if (finished > 0) status = "partial";
  else if (blankProduct && blank >= remainingNeed) status = "needs_production";
  else status = "missing";

  const printShort = isPrint && remainingNeed > 0 && blank >= remainingNeed && print < remainingNeed;
  const canOwnProduce = isPrint
    && finished < need
    && Boolean(blankProduct)
    && finished + Math.min(blank, print) >= need;
  const workshopTransferQty = !isPrint && remainingNeed > 0
    ? Math.min(Math.max(0, remainingNeed - blankAtWorkshop), blankAtOwn)
    : 0;

  return {
    status,
    finished,
    blank,
    blankAtWorkshop,
    blankAtOwn,
    print,
    blankProduct,
    need,
    finishedByWh,
    blankByWh,
    isPrint,
    hasPrintInfo,
    printShort,
    canOwnProduce,
    needsWorkshopTransfer: workshopTransferQty > 0,
    workshopTransferQty,
  };
}

function canCommitOrder(
  order: OzonOrder,
  availability: Map<string, ItemAvailability>,
) {
  if (!order.items || order.items.length === 0) return false;
  return order.items.every((item) => {
    const itemAvailability = availability.get(item.id);
    if (!itemAvailability || itemAvailability.status === "unmatched") return false;
    if (itemAvailability.status === "ready") return true;
    if (itemAvailability.isPrint) return itemAvailability.canOwnProduce;
    return itemAvailability.finished + itemAvailability.blank >= itemAvailability.need;
  });
}

function peek(
  pool: QuantityPool,
  key: string,
  excludeWorkshop: boolean,
  warehouseTypeById: Map<string, Warehouse["type"]>,
  warehouseNameById: Map<string, string>,
) {
  const list: WarehouseQuantity[] = [];
  let total = 0;
  for (const [warehouseId, quantity] of pool.get(key) ?? []) {
    if (quantity <= 0) continue;
    if (excludeWorkshop && warehouseTypeById.get(warehouseId) === "workshop") continue;
    total += quantity;
    list.push({
      warehouseId,
      warehouseName: warehouseNameById.get(warehouseId) ?? "—",
      qty: quantity,
    });
  }
  return { total, list };
}

function take(
  pool: QuantityPool,
  key: string,
  wanted: number,
  excludeWorkshop: boolean,
  preferWorkshop: boolean,
  input: Pick<OrderResourceAllocationInput, "warehouseTypeById" | "warehouseNameById">,
) {
  const taken: WarehouseQuantity[] = [];
  const byWarehouse = pool.get(key);
  if (!byWarehouse || wanted <= 0) return taken;
  const warehouseIds = [...byWarehouse.keys()].sort((left, right) => (
    warehouseRank(left, preferWorkshop, input.warehouseTypeById)
      - warehouseRank(right, preferWorkshop, input.warehouseTypeById)
      || left.localeCompare(right)
  ));
  let remaining = wanted;
  for (const warehouseId of warehouseIds) {
    if (remaining <= 0) break;
    if (excludeWorkshop && input.warehouseTypeById.get(warehouseId) === "workshop") continue;
    const available = byWarehouse.get(warehouseId) ?? 0;
    if (available <= 0) continue;
    const quantity = Math.min(available, remaining);
    byWarehouse.set(warehouseId, available - quantity);
    remaining -= quantity;
    taken.push({
      warehouseId,
      warehouseName: input.warehouseNameById.get(warehouseId) ?? "—",
      qty: quantity,
    });
  }
  return taken;
}

function warehouseRank(
  warehouseId: string,
  preferWorkshop: boolean,
  warehouseTypeById: Map<string, Warehouse["type"]>,
) {
  const type = warehouseTypeById.get(warehouseId);
  if (preferWorkshop) return type === "workshop" ? 0 : type === "own" ? 1 : 2;
  return type === "own" ? 0 : type === "workshop" ? 2 : 1;
}

function clonePool(pool: QuantityPool): QuantityPool {
  return new Map([...pool].map(([key, byWarehouse]) => [key, new Map(byWarehouse)]));
}

function copyAvailability(
  source: Map<string, ItemAvailability>,
  target: Map<string, ItemAvailability>,
) {
  for (const [itemId, availability] of source) target.set(itemId, availability);
}

function sumByWarehouseType(
  list: WarehouseQuantity[],
  type: Warehouse["type"],
  warehouseTypeById: Map<string, Warehouse["type"]>,
) {
  return list.reduce((total, row) => (
    warehouseTypeById.get(row.warehouseId) === type ? total + row.qty : total
  ), 0);
}

function unmatchedAvailability(need: number): ItemAvailability {
  return {
    status: "unmatched",
    finished: 0,
    blank: 0,
    blankAtWorkshop: 0,
    blankAtOwn: 0,
    print: 0,
    blankProduct: null,
    need,
    finishedByWh: [],
    blankByWh: [],
    isPrint: false,
    hasPrintInfo: false,
    printShort: false,
    canOwnProduce: false,
    needsWorkshopTransfer: false,
    workshopTransferQty: 0,
  };
}
