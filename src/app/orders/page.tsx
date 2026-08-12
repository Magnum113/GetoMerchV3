"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { OrderItemMarkingControls } from "@/components/marking/order-item-controls";
import { api } from "@/lib/api";
import {
  downloadOzonPackageLabelBundle,
  downloadOzonPackageLabels,
} from "@/lib/ozon/package-label-client";
import { toast } from "sonner";
import type { Inventory, OzonOrder, OzonOrderItem, Product, Warehouse, PrintInventory } from "@/lib/types";
import { OZON_STATUS_LABELS, OZON_STATUS_COLORS, WORKSHOP_STATUS_LABELS, WORKSHOP_STATUS_COLORS } from "@/lib/types";
import { ShoppingBag, RefreshCw, CheckCircle2, AlertTriangle, PackageCheck, Hammer, X, Search, Undo2, ExternalLink, Truck, Send, Download, Loader2, ChevronDown } from "lucide-react";

const POST_SHIPMENT_STATUSES = new Set([
  "delivering",
  "delivered",
  "driver_pickup",
  "sent_by_seller",
  "arbitration",
  "client_arbitration",
  "not_accepted",
]);
const TERMINAL_STATUSES = new Set([...POST_SHIPMENT_STATUSES, "cancelled"]);
const BULK_LABEL_STATUSES = new Set(["awaiting_deliver", "acceptance_in_progress"]);
import { formatDate, formatMoney, errorMessage } from "@/lib/utils";

type StockStatus = "ready" | "partial" | "needs_production" | "missing" | "unmatched";

interface WhQty { warehouseId: string; warehouseName: string; qty: number }

interface ItemAvailability {
  status: StockStatus;
  /** Готовых, выделенных этому заказу (с учётом уже занятых более ранними заказами), не больше need. */
  finished: number;
  /** Пустых, доступных этому заказу (после вычета занятых ранее). */
  blank: number;
  /** Пустых на складе цеха, доступных этому заказу. Только для вышивки. */
  blankAtWorkshop: number;
  /** Пустых на моём складе, доступных этому заказу. */
  blankAtOwn: number;
  /** Принтов нужного дизайна, доступных этому заказу (только для печатных позиций). */
  print: number;
  blankProduct: Product | null;
  need: number;
  finishedByWh: WhQty[];
  blankByWh: WhQty[];
  /** true для изделий с принтом (made_at === "own" или не задано) — пустые из цеха
   *  вышивки игнорируются, т.к. оттуда заготовки на мой склад для печати не возят. */
  isPrint: boolean;
  /** Показывать ли строку про принты (печатная позиция с заданным дизайном). */
  hasPrintInfo: boolean;
  /** Пустых хватает, но принтов на складе не хватает для производства. */
  printShort: boolean;
  /** Можно произвести недостающее у себя (готовые + пустые + принты покрывают заказ). */
  canOwnProduce: boolean;
  /** Для вышивки: заготовки есть у меня, но их нужно передать в цех. */
  needsWorkshopTransfer: boolean;
  workshopTransferQty: number;
}

// Срочность заказа: дата отгрузки ↑ → дата создания на Ozon ↑ → дата записи.
// Тот же порядок используется и при распределении остатков (availabilityByItem),
// и при массовой отгрузке — чтобы списание шло в одинаковой последовательности.
function urgencyCompare(a: OzonOrder, b: OzonOrder) {
  const da = a.shipment_date ? Date.parse(a.shipment_date) : Infinity;
  const db = b.shipment_date ? Date.parse(b.shipment_date) : Infinity;
  if (da !== db) return da - db;
  const ia = a.in_process_at ? Date.parse(a.in_process_at) : Infinity;
  const ib = b.in_process_at ? Date.parse(b.in_process_at) : Infinity;
  if (ia !== ib) return ia - ib;
  return a.created_at.localeCompare(b.created_at);
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OzonOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inv, setInv] = useState<Inventory[]>([]);
  const [blanks, setBlanks] = useState<Product[]>([]);
  const [prints, setPrints] = useState<PrintInventory[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"active" | "shipped" | "all">("active");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [labelBundleBusy, setLabelBundleBusy] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const [o, w, i, pr] = await Promise.all([
        api.listOzonOrders(),
        api.listWarehouses(),
        api.listInventory(),
        api.listPrintInventory(),
      ]);
      const b = await api.listMatchingBlankProducts(blankKeysFromOrders(o));
      setOrders(o);
      setWarehouses(w);
      setInv(i);
      setBlanks(b);
      setPrints(pr);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  const ownWarehouse = warehouses.find((w) => w.type === "own");
  const defaultWorkshop = warehouses.find((w) => w.type === "workshop");
  const warehouseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of warehouses) m.set(w.id, w.name);
    return m;
  }, [warehouses]);
  const warehouseTypeById = useMemo(() => {
    const m = new Map<string, Warehouse["type"]>();
    for (const w of warehouses) m.set(w.id, w.type);
    return m;
  }, [warehouses]);

  // qty by product across all warehouses + per-warehouse breakdown
  const stockByProduct = useMemo(() => {
    const m = new Map<string, { total: number; byWh: Map<string, number> }>();
    for (const row of inv) {
      const e = m.get(row.product_id) ?? { total: 0, byWh: new Map() };
      e.total += row.quantity;
      e.byWh.set(row.warehouse_id, (e.byWh.get(row.warehouse_id) ?? 0) + row.quantity);
      m.set(row.product_id, e);
    }
    return m;
  }, [inv]);

  const blankByKey = useMemo(() => {
    const m = new Map<string, Product>();
    for (const b of blanks) {
      m.set(blankKey(b.category_id, b.fabric_id, b.color_id, b.size_id), b);
    }
    return m;
  }, [blanks]);

  // Принты на своём складе: design_id -> warehouse_id -> qty
  const printByDesign = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const row of prints) {
      const e = m.get(row.design_id) ?? new Map<string, number>();
      e.set(row.warehouse_id, (e.get(row.warehouse_id) ?? 0) + row.quantity);
      m.set(row.design_id, e);
    }
    return m;
  }, [prints]);

  // Распределение остатков по заказам: один и тот же товар не может быть «доступен»
  // сразу двум заказам. Идём по активным заказам в порядке срочности (дата отгрузки,
  // затем дата создания) и вычитаем занятое из общего пула остатков — готовых,
  // пустых и принтов. Результат — карта itemId -> доступность с учётом резерва.
  const availabilityByItem = useMemo(() => {
    const rankWh = (wid: string, preferWorkshop = false) => {
      const t = warehouseTypeById.get(wid);
      if (preferWorkshop) return t === "workshop" ? 0 : t === "own" ? 1 : 2;
      return t === "own" ? 0 : t === "workshop" ? 2 : 1;
    };
    // мутируемые копии пулов
    const prodRem = new Map<string, Map<string, number>>();
    for (const [pid, e] of stockByProduct) prodRem.set(pid, new Map(e.byWh));
    const printRem = new Map<string, Map<string, number>>();
    for (const [did, e] of printByDesign) printRem.set(did, new Map(e));

    function peek(rem: Map<string, Map<string, number>>, key: string, excludeWorkshop: boolean) {
      const byWh = rem.get(key);
      const list: WhQty[] = [];
      let total = 0;
      if (byWh) {
        for (const [wid, q] of byWh) {
          if (q <= 0) continue;
          if (excludeWorkshop && warehouseTypeById.get(wid) === "workshop") continue;
          total += q;
          list.push({ warehouseId: wid, warehouseName: warehouseNameById.get(wid) ?? "—", qty: q });
        }
      }
      return { total, list };
    }
    // Списывает up to `want` из пула. Для печати — свой склад первым; для
    // вышивки — склад цеха первым, чтобы заготовки в цехе резервировались под
    // заказы раньше заготовок на моём складе.
    function take(rem: Map<string, Map<string, number>>, key: string, want: number, excludeWorkshop: boolean, preferWorkshop = false): WhQty[] {
      const taken: WhQty[] = [];
      const byWh = rem.get(key);
      if (!byWh || want <= 0) return taken;
      const wids = Array.from(byWh.keys()).sort((a, b) => rankWh(a, preferWorkshop) - rankWh(b, preferWorkshop));
      let left = want;
      for (const wid of wids) {
        if (left <= 0) break;
        if (excludeWorkshop && warehouseTypeById.get(wid) === "workshop") continue;
        const avail = byWh.get(wid) ?? 0;
        if (avail <= 0) continue;
        const t = Math.min(avail, left);
        byWh.set(wid, avail - t);
        left -= t;
        taken.push({ warehouseId: wid, warehouseName: warehouseNameById.get(wid) ?? "—", qty: t });
      }
      return taken;
    }

    function allocItem(item: OzonOrderItem): ItemAvailability {
      const need = item.quantity;
      const p = item.product;
      if (!p) {
        return { status: "unmatched", finished: 0, blank: 0, blankAtWorkshop: 0, blankAtOwn: 0, print: 0, blankProduct: null, need, finishedByWh: [], blankByWh: [], isPrint: false, hasPrintInfo: false, printShort: false, canOwnProduce: false, needsWorkshopTransfer: false, workshopTransferQty: 0 };
      }
      // Принт делается у меня на складе (или decoration_type не указан) — пустые из
      // цеха вышивки не учитываем, т.к. оттуда заготовки на мой склад не возят.
      const isPrint = p.decoration_type?.made_at !== "workshop";
      // 1. Готовые — резервируем под этот заказ.
      const finPeek = peek(prodRem, p.id, false);
      const finished = Math.min(need, finPeek.total);
      const finishedByWh = take(prodRem, p.id, finished, false);
      const remainingNeed = need - finished;

      // 2. Пустые и принты для производства недостающего.
      const blankProd = blankByKey.get(blankKey(p.category_id, p.fabric_id, p.color_id, p.size_id)) ?? null;
      let blank = 0;
      let blankAtWorkshop = 0;
      let blankAtOwn = 0;
      let blankByWh: WhQty[] = [];
      let print = 0;
      const hasPrintInfo = isPrint && !!p.design_id;
      if (blankProd) {
        const blkPeek = peek(prodRem, blankProd.id, isPrint);
        blank = blkPeek.total;
        blankByWh = blkPeek.list;
        blankAtWorkshop = isPrint ? 0 : sumByWarehouseType(blkPeek.list, "workshop", warehouseTypeById);
        blankAtOwn = sumByWarehouseType(blkPeek.list, "own", warehouseTypeById);
      }
      if (hasPrintInfo) {
        print = peek(printRem, p.design_id!, true).total;
      }
      // Резервируем пустые/принты, которые этот заказ пустит в производство,
      // чтобы их не «увидел» доступными следующий заказ.
      if (remainingNeed > 0 && blankProd) {
        take(prodRem, blankProd.id, Math.min(remainingNeed, blank), isPrint, !isPrint);
        if (hasPrintInfo) take(printRem, p.design_id!, Math.min(remainingNeed, print), true);
      }

      let status: StockStatus;
      if (finished >= need) status = "ready";
      else if (finished > 0) status = "partial";
      else if (blankProd && blank >= remainingNeed) status = "needs_production";
      else status = "missing";

      const printShort = isPrint && status === "needs_production" && print < remainingNeed;
      // Можно произвести у себя: печатная позиция, недостающее покрывается пустыми + принтами.
      const canOwnProduce =
        isPrint && finished < need && !!blankProd &&
        finished + Math.min(blank, print) >= need;
      const workshopTransferQty = !isPrint && remainingNeed > 0
        ? Math.min(Math.max(0, remainingNeed - blankAtWorkshop), blankAtOwn)
        : 0;
      const needsWorkshopTransfer = workshopTransferQty > 0;

      return { status, finished, blank, blankAtWorkshop, blankAtOwn, print, blankProduct: blankProd, need, finishedByWh, blankByWh, isPrint, hasPrintInfo, printShort, canOwnProduce, needsWorkshopTransfer, workshopTransferQty };
    }

    const competing = orders
      .filter((o) => o.source !== "fbo" && !o.shipped_at && !TERMINAL_STATUSES.has(o.status))
      .sort(urgencyCompare);

    const map = new Map<string, ItemAvailability>();
    for (const o of competing) {
      for (const it of o.items ?? []) map.set(it.id, allocItem(it));
    }
    return map;
  }, [orders, stockByProduct, printByDesign, blankByKey, warehouseTypeById, warehouseNameById]);

  function orderReady(order: OzonOrder): boolean {
    if (!order.items || order.items.length === 0) return false;
    return order.items.every((it) => availabilityByItem.get(it.id)?.status === "ready");
  }

  // Заказ можно «произвести и отправить» у себя: каждая позиция либо уже готова,
  // либо это печатная позиция, которую можно изготовить из своих пустых + принтов.
  function canProduceAndShip(order: OzonOrder): boolean {
    if (order.workshop_order_id) return false;
    if (!order.items || order.items.length === 0) return false;
    if (!ownWarehouse) return false;
    let needsProduction = false;
    for (const it of order.items) {
      const a = availabilityByItem.get(it.id);
      if (!a) return false;
      if (a.status === "ready") continue;
      if (a.isPrint && a.canOwnProduce) { needsProduction = true; continue; }
      return false;
    }
    return needsProduction;
  }

  // Каким способом заказ можно «произвести и отправить» одним действием.
  // Приоритет совпадает с кнопками в карточке: цех → готово к отгрузке → производство у себя.
  // null — заказ нельзя закрыть без дополнительных шагов (нет остатков, нужен цех и т.п.).
  function fulfillKind(order: OzonOrder): "workshop" | "ship" | "produce" | null {
    if (order.source === "fbo" || order.shipped_at || TERMINAL_STATUSES.has(order.status)) return null;
    if (!markingCanShip(order)) return null;
    if (order.workshop_order_id) return "workshop";
    if (orderReady(order)) return "ship";
    if (canProduceAndShip(order)) return "produce";
    return null;
  }

  async function doSync(scope: "active" | "all" = "active") {
    setSyncing(true);
    try {
      const r = await api.syncOzonOrders({ scope, days: 60 });
      const scopeLabel = r.scope === "active" ? "активных" : "всех";
      const warnings = [
        r.unmatchedItems ? `без SKU ${r.unmatchedItems}` : "",
        r.failedOrders ? `не обновлено заказов ${r.failedOrders}` : "",
        r.failedItemOrders ? `не обновлены позиции ${r.failedItemOrders}` : "",
      ].filter(Boolean).join(", ");
      const message = `Синхронизировано ${scopeLabel}: ${r.fetched} (новых ${r.created}, обновлено ${r.updated})${warnings ? `, ${warnings}` : ""}`;
      if (r.failedOrders || r.failedItemOrders) toast.warning(message);
      else toast.success(message);
      await reload();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSyncing(false); }
  }

  async function ship(order: OzonOrder) {
    const question = order.marking_shipping
      ? "Подтвердить фактическую передачу заказа Ozon? Товар спишется со склада, а для КМ будет создан дистанционный вывод из оборота."
      : `Списать ${order.items?.length ?? 0} позиций со склада?`;
    if (!confirm(question)) return;
    try {
      await api.shipOzonOrder(order.id, ownWarehouse?.id);
      toast.success("Отправлено, товар списан");
      await reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }

  function workshopEligible(order: OzonOrder): boolean {
    if (order.workshop_order_id) return false;
    if (!order.items || order.items.length === 0) return false;
    if (!defaultWorkshop) return false;
    return order.items.every((it) => {
      const a = availabilityByItem.get(it.id);
      if (!a || a.status === "ready" || a.status === "unmatched") return false;
      if (a.isPrint) return false; // у цеха только вышивка
      if (!a.blankProduct) return false;
      return a.finished + a.blank >= a.need;
    });
  }

  async function produceAndShip(order: OzonOrder) {
    if (!ownWarehouse) return toast.error("Не настроен свой склад");
    const question = order.marking_shipping
      ? "Произвести недостающие изделия и подтвердить их фактическую передачу Ozon? Для КМ будет создан дистанционный вывод из оборота."
      : "Произвести недостающие изделия и отправить заказ? Спишутся пустые и принты со склада.";
    if (!confirm(question)) return;
    try {
      await api.fulfillOzonViaProduction({ ozonOrderId: order.id, ownWarehouseId: ownWarehouse.id });
      toast.success("Произведено и отправлено, материалы списаны");
      await reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }

  async function sendToWorkshop(order: OzonOrder) {
    if (!defaultWorkshop) return toast.error("Не настроен цех вышивки");
    if (!confirm(`Создать заказ в цех на ${order.items?.length ?? 0} позиций?`)) return;
    try {
      await api.createWorkshopOrderFromOzon({
        ozonOrderId: order.id,
        workshopId: defaultWorkshop.id,
        ownWarehouseId: ownWarehouse?.id ?? null,
      });
      toast.success("Заказ отправлен в цех, заготовки перенесены");
      await reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }

  async function fulfillViaWorkshop(order: OzonOrder) {
    const question = order.marking_shipping
      ? "Подтвердить, что заказ произведён и фактически передан Ozon? Для КМ будет создан дистанционный вывод из оборота."
      : "Подтвердить, что заказ произведён и отправлен покупателю?";
    if (!confirm(question)) return;
    try {
      await api.fulfillOzonViaWorkshop({ ozonOrderId: order.id, ownWarehouseId: ownWarehouse?.id ?? null });
      toast.success("Заказ закрыт, материалы списаны");
      await reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }

  // Массовая отгрузка: каждый заказ закрывается своим способом (цех / отгрузка /
  // производство у себя). Идём строго по срочности — тем же порядком, по которому
  // распределялись остатки, чтобы списание не разъехалось с индикаторами наличия.
  async function bulkFulfill(targets: OzonOrder[]) {
    const list = targets.filter((o) => fulfillKind(o) !== null).sort(urgencyCompare);
    if (list.length === 0) return toast.error("Нет заказов, готовых к отправке");
    const markedCount = list.filter((order) => order.marking_shipping).length;
    const kinds = new Set(list.map((order) => fulfillKind(order)));
    const question = markedCount > 0
      ? `Подтвердить фактическую передачу Ozon ${list.length} заказ(ов), включая маркируемых: ${markedCount}? Для их КМ будет создан дистанционный вывод из оборота.`
      : kinds.size === 1 && kinds.has("ship")
        ? `Подтвердить передачу Ozon ${list.length} готовых заказ(ов)? Товары будут списаны со склада.`
        : `Обработать ${list.length} заказ(ов)? Готовые товары или материалы для производства будут списаны со склада.`;
    if (!confirm(question)) return;
    setBulkBusy(true);
    const ok: string[] = [];
    const failed: { posting: string; msg: string }[] = [];
    try {
      for (const o of list) {
        const kind = fulfillKind(o);
        if (!kind) continue;
        try {
          if (kind === "workshop") await api.fulfillOzonViaWorkshop({ ozonOrderId: o.id, ownWarehouseId: ownWarehouse?.id ?? null });
          else if (kind === "ship") await api.shipOzonOrder(o.id, ownWarehouse?.id);
          else await api.fulfillOzonViaProduction({ ozonOrderId: o.id, ownWarehouseId: ownWarehouse!.id });
          ok.push(o.posting_number);
        } catch (e) {
          failed.push({ posting: o.posting_number, msg: errorMessage(e) });
        }
      }
      if (ok.length) toast.success(`Обработано заказов: ${ok.length}${failed.length ? `, с ошибками: ${failed.length}` : ""}`);
      if (failed.length) toast.error(`Не удалось: ${failed.slice(0, 3).map((f) => `${f.posting} — ${f.msg}`).join("; ")}${failed.length > 3 ? ` и ещё ${failed.length - 3}` : ""}`);
      setSelected(new Set());
      await reload();
    } finally {
      setBulkBusy(false);
    }
  }

  async function unship(order: OzonOrder) {
    if (!confirm("Вернуть товар на склад?")) return;
    try {
      await api.unshipOzonOrder(order.id);
      toast.success("Возврат на склад");
      await reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }

  async function downloadLabelBundle(targets: OzonOrder[]) {
    if (targets.length === 0) return toast.error("Нет готовых этикеток Ozon");
    setLabelBundleBusy(true);
    try {
      await downloadOzonPackageLabelBundle({
        orders: targets.map((order) => ({
          id: order.id,
          postingNumber: order.posting_number,
        })),
      });
      toast.success(`Скачан один PDF для ${targets.length} отправлений`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLabelBundleBusy(false);
    }
  }

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      // FBO-отправления отгружает сам Ozon — здесь они не нужны
      if (o.source === "fbo") return false;
      if (tab === "shipped" && !o.shipped_at && !POST_SHIPMENT_STATUSES.has(o.status)) return false;
      if (tab === "active" && (o.shipped_at || TERMINAL_STATUSES.has(o.status))) return false;
      if (search) {
        const hay = [o.posting_number, o.order_number, o.customer_name, ...(o.items?.map((it) => `${it.offer_id} ${it.name}`) ?? [])].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    }).sort(tab === "active" ? urgencyCompare : (a, b) => {
      const left = a.in_process_at ? Date.parse(a.in_process_at) : 0;
      const right = b.in_process_at ? Date.parse(b.in_process_at) : 0;
      return right - left;
    });
  }, [orders, tab, search]);
  const activeOrders = useMemo(
    () => orders
      .filter((o) => o.source !== "fbo" && !o.shipped_at && !TERMINAL_STATUSES.has(o.status))
      .sort(urgencyCompare),
    [orders],
  );
  const activeCount = activeOrders.length;
  const shippedCount = useMemo(
    () => orders.filter((o) => o.source !== "fbo" && (o.shipped_at || POST_SHIPMENT_STATUSES.has(o.status))).length,
    [orders],
  );
  const fbsCount = useMemo(
    () => orders.filter((o) => o.source !== "fbo").length,
    [orders],
  );

  // Складские и печатные массовые действия используют один выбор, но свои
  // наборы допустимых заказов. Этикетки Ozon появляются после упаковки.
  const fulfillable = filtered.filter((o) => fulfillKind(o) !== null);
  const selectedOrders = activeOrders.filter((o) => selected.has(o.id));
  const selectedFulfillable = fulfillable.filter((o) => selected.has(o.id));
  const visibleSelectable = tab === "active" ? filtered : [];
  const allVisibleSelected = visibleSelectable.length > 0
    && visibleSelectable.every((o) => selected.has(o.id));
  const showBulkBar = tab === "active" && filtered.length > 0;
  const selectable = tab === "active" && !bulkBusy && !labelBundleBusy;
  const bulkTargets = selectedOrders.length > 0 ? selectedFulfillable : fulfillable;
  const labelSource = selectedOrders.length > 0 ? selectedOrders : activeOrders;
  const labelTargets = labelSource.filter(canDownloadBulkLabel);
  const skippedLabelCount = labelSource.length - labelTargets.length;
  const bulkKinds = new Set(bulkTargets.map((order) => fulfillKind(order)));
  const bulkLabel = bulkKinds.size === 1 && bulkKinds.has("ship")
    ? `Передать Ozon (${bulkTargets.length})`
    : bulkKinds.size === 1 && bulkKinds.has("produce")
      ? `Произвести и передать Ozon (${bulkTargets.length})`
      : bulkKinds.size === 1 && bulkKinds.has("workshop")
        ? `Завершить заказы из цеха (${bulkTargets.length})`
        : `Обработать заказы (${bulkTargets.length})`;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) =>
      allVisibleSelected
        ? new Set(Array.from(prev).filter((id) => !visibleSelectable.some((order) => order.id === id)))
        : new Set([...prev, ...visibleSelectable.map((o) => o.id)]),
    );
  }

  return (
    <div>
      <PageHeader
        title="Заказы Ozon"
        description="Рабочая очередь FBS и готовность заказов к передаче Ozon."
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => doSync("active")} disabled={syncing} title="Тянет только заказы, требующие действий (ждут упаковки / отгрузки)">
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Синхронизация…" : "Синхронизировать"}
            </Button>
            <Button variant="outline" onClick={() => doSync("all")} disabled={syncing} title="Полная синхронизация за 60 дней — медленнее, обновит и доставленные/отменённые">
              Полная
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Tabs value={tab} onValueChange={(v) => { setTab(v as typeof tab); setSelected(new Set()); }}>
          <TabsList>
            <TabsTrigger value="active">Активные ({activeCount})</TabsTrigger>
            <TabsTrigger value="shipped">Отправленные ({shippedCount})</TabsTrigger>
            <TabsTrigger value="all">Все ({fbsCount})</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Поиск по номеру отправления, артикулу, имени…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {showBulkBar && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3 rounded-md border bg-muted/30 px-3 py-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <Checkbox
              checked={allVisibleSelected ? true : selectedOrders.length > 0 ? "indeterminate" : false}
              onCheckedChange={toggleSelectAll}
              disabled={bulkBusy || labelBundleBusy}
              aria-label="Выбрать все заказы"
            />
            {selectedOrders.length > 0
              ? `Выбрано: ${selectedOrders.length} из ${activeOrders.length}`
              : `Выбрать все активные (${activeOrders.length})`}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {selectedOrders.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={bulkBusy || labelBundleBusy}>
                Снять выделение
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadLabelBundle(labelTargets)}
              disabled={labelBundleBusy || bulkBusy || labelTargets.length === 0}
              title={skippedLabelCount > 0
                ? `${skippedLabelCount} заказ(ов) ещё ждут упаковки, Ozon пока не сформировал для них этикетки`
                : "Скачать один PDF со всеми этикетками 58x40 мм"}
            >
              {labelBundleBusy ? <Loader2 className="animate-spin" /> : <Download />}
              {labelBundleBusy
                ? "Сборка PDF…"
                : selectedOrders.length > 0
                  ? `Этикетки выбранных (${labelTargets.length}${skippedLabelCount > 0 ? ` из ${labelSource.length}` : ""})`
                  : `Все этикетки (${labelTargets.length}${skippedLabelCount > 0 ? ` из ${labelSource.length}` : ""})`}
            </Button>
            {bulkTargets.length > 0 && (
              <Button
                size="sm"
                onClick={() => bulkFulfill(bulkTargets)}
                disabled={bulkBusy || labelBundleBusy}
              >
                <Hammer className="h-3.5 w-3.5" />
                {bulkBusy ? "Обработка…" : bulkLabel}
              </Button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-muted-foreground">Загрузка…</div>
      ) : orders.length === 0 ? (
        <Card><CardContent>
          <EmptyState
            icon={ShoppingBag}
            title="Заказов ещё нет"
            description="Нажми «Синхронизировать», чтобы подтянуть отправления FBS из Ozon за последние 60 дней."
            action={<Button onClick={() => doSync("active")} disabled={syncing}><RefreshCw className="h-4 w-4" /> Синхронизировать</Button>}
          />
        </CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={ShoppingBag} title="Ничего не найдено" description="Попробуйте сменить вкладку или очистить поиск." />
        </CardContent></Card>
      ) : (
        <div className="grid gap-3">
          {filtered.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              ready={orderReady(o)}
              availabilityByItem={availabilityByItem}
              canSendToWorkshop={workshopEligible(o)}
              canProduceAndShip={canProduceAndShip(o)}
              selectable={selectable}
              selected={selected.has(o.id)}
              onToggleSelect={() => toggleOne(o.id)}
              onShip={() => ship(o)}
              onUnship={() => unship(o)}
              onSendToWorkshop={() => sendToWorkshop(o)}
              onFulfillViaWorkshop={() => fulfillViaWorkshop(o)}
              onProduceAndShip={() => produceAndShip(o)}
              onMarkingChanged={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({ order, ready, availabilityByItem, canSendToWorkshop, canProduceAndShip, selectable, selected, onToggleSelect, onShip, onUnship, onSendToWorkshop, onFulfillViaWorkshop, onProduceAndShip, onMarkingChanged }: {
  order: OzonOrder;
  ready: boolean;
  availabilityByItem: Map<string, ItemAvailability>;
  canSendToWorkshop: boolean;
  canProduceAndShip: boolean;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onShip: () => void;
  onUnship: () => void;
  onSendToWorkshop: () => void;
  onFulfillViaWorkshop: () => void;
  onProduceAndShip: () => void;
  onMarkingChanged: () => Promise<void>;
}) {
  const statusLabel = OZON_STATUS_LABELS[order.status] ?? order.status;
  const statusColor = OZON_STATUS_COLORS[order.status] ?? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  const shipped = !!order.shipped_at;
  const onOzonSide = POST_SHIPMENT_STATUSES.has(order.status);
  const cancelled = order.status === "cancelled";
  const showActions = !cancelled && !onOzonSide;
  const showAvailability = !shipped && !cancelled && !onOzonSide;
  const wsLinked = !!order.workshop_order_id && !shipped && !cancelled && !onOzonSide;
  const ws = order.workshop_order ?? null;
  const markingBlocked = !markingCanShip(order);
  const [labelBusy, setLabelBusy] = useState(false);
  const unitCount = order.items?.reduce((sum, item) => sum + item.quantity, 0) ?? 0;

  async function downloadLabels() {
    setLabelBusy(true);
    try {
      await downloadOzonPackageLabels({
        orderId: order.id,
        postingNumber: order.posting_number,
      });
      toast.success("Этикетки Ozon скачаны");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLabelBusy(false);
    }
  }

  return (
    <Card className={selected ? "border-foreground/30 bg-muted/10" : undefined}>
      <CardHeader className="p-4 pb-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {selectable && (
              <Checkbox
                className="mt-1 shrink-0"
                checked={selected}
                onCheckedChange={onToggleSelect}
                aria-label={`Выбрать заказ ${order.posting_number}`}
              />
            )}
            <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-[15px] font-semibold">
                <span className="text-muted-foreground">Отправление </span>
                <span className="font-mono text-foreground">{order.posting_number}</span>
              </CardTitle>
              <Badge className={statusColor}>{statusLabel}</Badge>
              {shipped && <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"><PackageCheck className="mr-1 h-3 w-3" /> Склад списан</Badge>}
              {wsLinked && ws && (
                <Badge className={`${WORKSHOP_STATUS_COLORS[ws.status]} gap-1`}>
                  <Hammer className="h-3 w-3" /> Цех: {WORKSHOP_STATUS_LABELS[ws.status]}
                </Badge>
              )}
              {order.marking_shipping && order.marking_shipping.requiredUnits > 0 && (
                <Badge variant={order.marking_shipping.allowed ? "outline"
                  : order.marking_shipping.mode === "enforce" ? "destructive" : "secondary"}
                  title="Предварительная готовность КМ. Окончательная проверка выполняется сервером при передаче."
                >
                  КМ {order.marking_shipping.readyUnits}/{order.marking_shipping.requiredUnits}
                  {order.marking_shipping.mode === "observe" ? " · наблюдение" : ""}
                </Badge>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {order.shipment_date && (
                <span className={deadlineClass(order.shipment_date, cancelled || onOzonSide)}>
                  Отгрузить до {formatDate(order.shipment_date)}
                </span>
              )}
              <span>{unitCount} {pluralizeUnits(unitCount)}</span>
              {order.total_price != null && <span className="font-medium text-foreground">{formatMoney(order.total_price)}</span>}
            </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            {!cancelled && (
              <Button
                size="sm"
                variant="outline"
                onClick={downloadLabels}
                disabled={labelBusy}
                title="Скачать официальный PDF Ozon: QR заказа и штрихкод товара, 58x40 мм. Ozon формирует файл после сборки заказа."
              >
                {labelBusy ? <Loader2 className="animate-spin" /> : <Download />}
                Этикетки Ozon
              </Button>
            )}
            {showActions && !shipped && wsLinked && (
              <Button size="sm" onClick={onFulfillViaWorkshop} disabled={markingBlocked}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                {order.marking_shipping ? "Произвели и передали Ozon" : "Произвели и отправили"}
              </Button>
            )}
            {showActions && !shipped && !wsLinked && ready && (
              <Button size="sm" onClick={onShip} disabled={markingBlocked}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                {order.marking_shipping ? "Передал Ozon" : "Отправил заказ"}
              </Button>
            )}
            {showActions && !shipped && !wsLinked && !ready && canProduceAndShip && (
              <Button size="sm" onClick={onProduceAndShip} disabled={markingBlocked}>
                <Hammer className="h-3.5 w-3.5" />
                {order.marking_shipping ? "Произвёл и передал Ozon" : "Произвёл и отправил"}
              </Button>
            )}
            {showActions && !shipped && !wsLinked && !ready && !canProduceAndShip && canSendToWorkshop && (
              <Button size="sm" onClick={onSendToWorkshop}>
                <Send className="h-3.5 w-3.5" /> Отправить в цех
              </Button>
            )}
            {showActions && shipped && (
              <Button size="sm" variant="outline" onClick={onUnship}>
                <Undo2 className="h-3.5 w-3.5" /> Откатить
              </Button>
            )}
            {onOzonSide && !shipped && (
              <Badge variant="outline" className="gap-1"><Truck className="h-3 w-3" /> У Ozon</Badge>
            )}
            <Button size="icon" variant="ghost" asChild title="Открыть отправление в Ozon" className="hidden sm:inline-flex">
              <a
                href={`https://seller.ozon.ru/app/postings/${order.source === "fbo" ? "fbo" : "fbs"}?postingDetails=${order.posting_number}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        {order.marking_shipping && !order.marking_shipping.allowed && (
          <div className={`mb-3 flex items-start gap-2 border-y px-3 py-2 text-xs ${
            order.marking_shipping.mode === "enforce"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-amber-300 bg-amber-50 text-amber-800"
          }`}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {order.marking_shipping.mode === "enforce"
                ? "Предварительно заблокировано; сервер проверит повторно: "
                : "Предварительная проверка в режиме наблюдения: "}
              {order.marking_shipping.blockers.join("; ")}
            </span>
          </div>
        )}
        <div className="border-y">
          {order.items?.map((it, idx) => (
            <ItemRow
              key={it.id}
              item={it}
              availability={showAvailability ? availabilityByItem.get(it.id) ?? null : null}
              top={idx === 0}
              showPrice={(order.items?.length ?? 0) > 1}
              onMarkingChanged={onMarkingChanged}
            />
          ))}
        </div>
        {order.shipped_at && (
          <div className="mt-2 text-xs text-muted-foreground">Склад списан {formatDate(order.shipped_at)}</div>
        )}
        <OrderTechnicalDetails order={order} />
      </CardContent>
    </Card>
  );
}

function markingCanShip(order: OzonOrder) {
  return !order.marking_shipping
    || order.marking_shipping.mode !== "enforce"
    || order.marking_shipping.allowed;
}

function canDownloadBulkLabel(order: OzonOrder) {
  return BULK_LABEL_STATUSES.has(order.status) && order.source !== "fbo";
}

function ItemRow({
  item,
  availability,
  top,
  showPrice,
  onMarkingChanged,
}: {
  item: OzonOrderItem;
  availability: ItemAvailability | null;
  top: boolean;
  showPrice: boolean;
  onMarkingChanged: () => Promise<void>;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 py-3 ${top ? "" : "border-t"}`}>
      <div className="flex-1 min-w-0">
        {item.product ? (
          <ProductDisplay p={item.product} compact />
        ) : (
          <div>
            <div className="font-medium">{item.name ?? item.offer_id}</div>
            <div className="text-[11px] font-mono text-muted-foreground">{item.offer_id}</div>
          </div>
        )}
        {item.product && (
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {item.offer_id}
          </div>
        )}
        {availability && (
          <div className="mt-1.5">
            <AvailabilityBadge a={availability} />
          </div>
        )}
        <OrderItemMarkingControls
          item={item}
          onChanged={onMarkingChanged}
        />
      </div>
      <div className="text-right shrink-0">
        <div className="font-semibold tabular-nums">{item.quantity} шт</div>
        {showPrice && item.price != null && <div className="text-xs text-muted-foreground tabular-nums">{formatMoney(item.price)}</div>}
      </div>
    </div>
  );
}

function sumByWarehouseType(list: WhQty[], type: Warehouse["type"], warehouseTypeById: Map<string, Warehouse["type"]>) {
  let total = 0;
  for (const row of list) {
    if (warehouseTypeById.get(row.warehouseId) === type) total += row.qty;
  }
  return total;
}

function AvailabilityBadge({ a }: { a: ItemAvailability }) {
  const productionNeed = Math.max(0, a.need - a.finished);
  if (a.status === "unmatched") {
    return (
      <Badge className="bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 gap-1">
        <AlertTriangle className="h-3 w-3" /> Нет SKU в каталоге
      </Badge>
    );
  }
  if (a.status === "ready") {
    return (
      <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 gap-1">
        <CheckCircle2 className="h-3 w-3" /> Готово к упаковке · {a.finished}/{a.need}
      </Badge>
    );
  }

  const state = availabilityState(a, productionNeed);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge className={`${state.className} gap-1`}>
        <state.icon className="h-3 w-3" /> {state.label}
      </Badge>
      {a.finished > 0 && <ResourceBadge label="Готовые" value={a.finished} need={a.need} />}
      {a.blankProduct && (
        <ResourceBadge
          label={a.isPrint ? "Заготовки" : "В цехе"}
          value={a.isPrint ? a.blank : a.blankAtWorkshop}
          need={productionNeed}
        />
      )}
      {!a.isPrint && a.blankAtOwn > 0 && (
        <ResourceBadge label="У меня" value={a.blankAtOwn} need={a.workshopTransferQty || productionNeed} />
      )}
      {a.hasPrintInfo && <ResourceBadge label="Принты" value={a.print} need={productionNeed} />}
    </div>
  );
}

function availabilityState(a: ItemAvailability, productionNeed: number) {
  if (a.canOwnProduce) {
    return {
      label: a.finished > 0 ? "Допроизвести" : "Можно изготовить",
      className: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
      icon: Hammer,
    };
  }
  if (a.needsWorkshopTransfer) {
    return {
      label: `Передать в цех · ${a.workshopTransferQty}`,
      className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
      icon: Truck,
    };
  }
  if (a.printShort) {
    return {
      label: "Не хватает принтов",
      className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
      icon: X,
    };
  }
  if (a.blank < productionNeed) {
    return {
      label: "Не хватает заготовок",
      className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
      icon: X,
    };
  }
  return {
    label: a.status === "partial" ? "Готово частично" : "Нужно изготовить",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    icon: AlertTriangle,
  };
}

function ResourceBadge({ label, value, need }: { label: string; value: number; need: number }) {
  const enough = value >= need;
  return (
    <Badge variant="outline" className={enough ? "text-emerald-700" : "text-red-700"}>
      {label} {value}/{need}
    </Badge>
  );
}

function OrderTechnicalDetails({ order }: { order: OzonOrder }) {
  const itemRows = order.items?.flatMap((item) => [
    { label: `Позиция ${item.offer_id}`, value: item.fulfillment?.id ?? item.fulfillment_item_id },
    { label: `Ozon SKU ${item.offer_id}`, value: item.ozon_sku },
  ]) ?? [];
  const rows = [
    { label: "Номер заказа Ozon", value: order.order_number },
    { label: "Ozon order ID", value: order.order_id?.toString() },
    { label: "Внутренний ID", value: order.id },
    { label: "ID исполнения", value: order.fulfillment?.id ?? order.fulfillment_order_id },
    { label: "Ключ источника", value: order.fulfillment?.source_order_key },
    ...itemRows,
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));

  if (rows.length === 0 && !order.customer_name && !order.in_process_at) return null;
  return (
    <details className="group mt-3 border-t pt-2 text-xs text-muted-foreground">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 py-1 font-medium hover:text-foreground">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        Технические данные
      </summary>
      <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {order.in_process_at && <TechnicalValue label="Создан" value={formatDate(order.in_process_at)} />}
        {order.customer_name && <TechnicalValue label="Получатель" value={order.customer_name} />}
        {rows.map((row) => <TechnicalValue key={`${row.label}:${row.value}`} label={row.label} value={row.value} mono />)}
      </div>
    </details>
  );
}

function TechnicalValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div>{label}</div>
      <div className={`break-all text-foreground ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function deadlineClass(value: string, inactive: boolean) {
  if (inactive) return "";
  const remaining = Date.parse(value) - Date.now();
  if (remaining < 0) return "font-semibold text-red-700";
  if (remaining < 24 * 60 * 60 * 1_000) return "font-semibold text-amber-700";
  return "font-medium text-foreground";
}

function pluralizeUnits(value: number) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return "товар";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "товара";
  return "товаров";
}

function blankKey(cat: string, fab: string, col: string, sz: string) {
  return `${cat}|${fab}|${col}|${sz}`;
}

function blankKeysFromOrders(orders: OzonOrder[]) {
  const keys = new Map<string, { category_id: string; fabric_id: string; color_id: string; size_id: string }>();
  for (const order of orders) {
    for (const item of order.items ?? []) {
      const product = item.product;
      if (!product) continue;
      const key = {
        category_id: product.category_id,
        fabric_id: product.fabric_id,
        color_id: product.color_id,
        size_id: product.size_id,
      };
      keys.set(blankKey(key.category_id, key.fabric_id, key.color_id, key.size_id), key);
    }
  }
  return Array.from(keys.values());
}
