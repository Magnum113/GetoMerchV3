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
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Inventory, OzonOrder, OzonOrderItem, Product, Warehouse, PrintInventory } from "@/lib/types";
import { OZON_STATUS_LABELS, OZON_STATUS_COLORS, WORKSHOP_STATUS_LABELS, WORKSHOP_STATUS_COLORS } from "@/lib/types";
import { ShoppingBag, RefreshCw, CheckCircle2, AlertTriangle, PackageCheck, Hammer, X, Search, Undo2, ExternalLink, Truck, Send } from "lucide-react";

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
import { formatDate, formatDateShort, formatMoney, errorMessage } from "@/lib/utils";

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

  async function reload() {
    setLoading(true);
    const [o, w, i, b, pr] = await Promise.all([
      api.listOzonOrders(),
      api.listWarehouses(),
      api.listInventory(),
      api.listAllProducts({ is_blank: true }),
      api.listPrintInventory(),
    ]);
    setOrders(o);
    setWarehouses(w);
    setInv(i);
    setBlanks(b);
    setPrints(pr);
    setLoading(false);
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
    if (!confirm(`Списать ${order.items?.length ?? 0} позиций со склада?`)) return;
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
    if (!confirm("Произвести недостающие изделия и отправить заказ? Спишутся пустые и принты со склада.")) return;
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
    if (!confirm("Подтвердить, что заказ произведён и отправлен покупателю?")) return;
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
    if (!confirm(`Произвести и отправить ${list.length} заказ(ов)? Спишутся готовые изделия, а где нужно — пустые и принты со склада.`)) return;
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
      if (ok.length) toast.success(`Произведено и отправлено: ${ok.length}${failed.length ? `, с ошибками: ${failed.length}` : ""}`);
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
    });
  }, [orders, tab, search]);
  const activeCount = useMemo(
    () => orders.filter((o) => o.source !== "fbo" && !o.shipped_at && !TERMINAL_STATUSES.has(o.status)).length,
    [orders],
  );
  const shippedCount = useMemo(
    () => orders.filter((o) => o.source !== "fbo" && (o.shipped_at || POST_SHIPMENT_STATUSES.has(o.status))).length,
    [orders],
  );
  const fbsCount = useMemo(
    () => orders.filter((o) => o.source !== "fbo").length,
    [orders],
  );

  // Заказы, которые реально можно закрыть одним действием (для чекбоксов и кнопок).
  const fulfillable = filtered.filter((o) => fulfillKind(o) !== null);
  const selectedOrders = fulfillable.filter((o) => selected.has(o.id));
  const allFulfillableSelected = fulfillable.length > 0 && selectedOrders.length === fulfillable.length;
  const showBulkBar = tab === "active" && fulfillable.length > 0;
  const selectable = tab === "active" && !bulkBusy;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) =>
      fulfillable.length > 0 && prev.size >= fulfillable.length && fulfillable.every((o) => prev.has(o.id))
        ? new Set()
        : new Set(fulfillable.map((o) => o.id)),
    );
  }

  return (
    <div>
      <PageHeader
        title="Заказы Ozon"
        description="Заказы FBS из личного кабинета Ozon. Видно наличие готовой продукции и пустых для производства. Кнопка «Отправил» списывает товар со склада."
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
              checked={allFulfillableSelected ? true : selectedOrders.length > 0 ? "indeterminate" : false}
              onCheckedChange={toggleSelectAll}
              disabled={bulkBusy}
              aria-label="Выбрать все заказы"
            />
            {selectedOrders.length > 0
              ? `Выбрано: ${selectedOrders.length} из ${fulfillable.length}`
              : `Выбрать готовые к действию (${fulfillable.length} из ${filtered.length})`}
          </label>
          <div className="flex items-center gap-2">
            {selectedOrders.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={bulkBusy}>
                Снять выделение
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => bulkFulfill(selectedOrders.length > 0 ? selectedOrders : fulfillable)}
              disabled={bulkBusy}
            >
              <Hammer className="h-3.5 w-3.5" />
              {bulkBusy
                ? "Отправка…"
                : selectedOrders.length > 0
                  ? `Произвести и отправить выбранные (${selectedOrders.length})`
                  : `Произвести и отправить все заказы (${fulfillable.length})`}
            </Button>
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
              selectable={selectable && fulfillKind(o) !== null}
              selected={selected.has(o.id)}
              onToggleSelect={() => toggleOne(o.id)}
              onShip={() => ship(o)}
              onUnship={() => unship(o)}
              onSendToWorkshop={() => sendToWorkshop(o)}
              onFulfillViaWorkshop={() => fulfillViaWorkshop(o)}
              onProduceAndShip={() => produceAndShip(o)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({ order, ready, availabilityByItem, canSendToWorkshop, canProduceAndShip, selectable, selected, onToggleSelect, onShip, onUnship, onSendToWorkshop, onFulfillViaWorkshop, onProduceAndShip }: {
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            {selectable && (
              <Checkbox
                className="mt-1 shrink-0"
                checked={selected}
                onCheckedChange={onToggleSelect}
                aria-label={`Выбрать заказ ${order.posting_number}`}
              />
            )}
            <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base font-mono">{order.posting_number}</CardTitle>
              <Badge className={statusColor}>{statusLabel}</Badge>
              {shipped && <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"><PackageCheck className="h-3 w-3 mr-1" /> Отправлен</Badge>}
              {wsLinked && ws && (
                <Badge className={`${WORKSHOP_STATUS_COLORS[ws.status]} gap-1`}>
                  <Hammer className="h-3 w-3" /> Цех: {WORKSHOP_STATUS_LABELS[ws.status]}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {order.in_process_at && <span>Создан: {formatDate(order.in_process_at)}</span>}
              {order.shipment_date && <span>Отгрузка до: {formatDateShort(order.shipment_date)}</span>}
              {order.customer_name && <span>{order.customer_name}</span>}
              {order.total_price != null && <span className="font-medium text-foreground">{formatMoney(order.total_price)}</span>}
            </div>
            </div>
          </div>
          <div className="flex gap-2">
            {showActions && !shipped && wsLinked && (
              <Button size="sm" onClick={onFulfillViaWorkshop}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Произвели и отправили
              </Button>
            )}
            {showActions && !shipped && !wsLinked && ready && (
              <Button size="sm" onClick={onShip}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Отправил заказ
              </Button>
            )}
            {showActions && !shipped && !wsLinked && !ready && canProduceAndShip && (
              <Button size="sm" onClick={onProduceAndShip}>
                <Hammer className="h-3.5 w-3.5" /> Произвёл и отправил
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
              <Badge variant="outline" className="gap-1"><Truck className="h-3 w-3" /> На стороне Ozon</Badge>
            )}
            <Button size="sm" variant="ghost" asChild>
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
      <CardContent className="pt-0">
        <div className="rounded-md border bg-muted/30">
          {order.items?.map((it, idx) => (
            <ItemRow
              key={it.id}
              item={it}
              availability={showAvailability ? availabilityByItem.get(it.id) ?? null : null}
              top={idx === 0}
              showPrice={(order.items?.length ?? 0) > 1}
            />
          ))}
        </div>
        {order.shipped_at && (
          <div className="text-xs text-muted-foreground mt-2">Отправлен в {formatDate(order.shipped_at)}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ItemRow({ item, availability, top, showPrice }: { item: OzonOrderItem; availability: ItemAvailability | null; top: boolean; showPrice: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-3 p-3 ${top ? "" : "border-t"}`}>
      <div className="flex-1 min-w-0">
        {item.product ? (
          <ProductDisplay p={item.product} compact />
        ) : (
          <div>
            <div className="font-medium">{item.name ?? item.offer_id}</div>
            <div className="text-[11px] font-mono text-muted-foreground">{item.offer_id}</div>
          </div>
        )}
        {availability && (
          <div className="mt-1.5">
            <AvailabilityBadge a={availability} />
          </div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="font-semibold tabular-nums">{item.quantity} шт</div>
        {showPrice && item.price != null && <div className="text-xs text-muted-foreground tabular-nums">{formatMoney(item.price)}</div>}
      </div>
    </div>
  );
}

function whDetail(list: { warehouseName: string; qty: number }[], total?: number) {
  if (list.length === 0) return "";
  if (list.length === 1 && (total == null || list[0].qty === total)) {
    return ` · ${list[0].warehouseName}`;
  }
  return ` · ${list.map((w) => `${w.warehouseName}: ${w.qty}`).join(", ")}`;
}

function sumByWarehouseType(list: WhQty[], type: Warehouse["type"], warehouseTypeById: Map<string, Warehouse["type"]>) {
  let total = 0;
  for (const row of list) {
    if (warehouseTypeById.get(row.warehouseId) === type) total += row.qty;
  }
  return total;
}

function blankGarmentLabel(product: Product | null) {
  const raw = `${product?.category?.slug ?? ""} ${product?.category?.name ?? ""}`.toLowerCase();
  if (raw.includes("hoodie") || raw.includes("худи")) return "худи";
  if (raw.includes("sweatshirt") || raw.includes("свит")) return "свитшот";
  if (raw.includes("tshirt") || raw.includes("shirt") || raw.includes("фут")) return "футболку";
  return "изделие";
}

function AvailabilityBadge({ a }: { a: ItemAvailability }) {
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
        <CheckCircle2 className="h-3 w-3" /> Готово: {a.finished}{whDetail(a.finishedByWh, a.finished)}
      </Badge>
    );
  }
  const blanksLabel = a.isPrint ? "Пустых на моём складе" : "Пустых";
  const needForProduction = a.need - a.finished;
  if (a.status === "partial") {
    return (
      <div className="flex flex-wrap gap-1.5">
        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 gap-1">
          <AlertTriangle className="h-3 w-3" /> Готово: {a.finished} / {a.need}{whDetail(a.finishedByWh, a.finished)}
        </Badge>
        {a.blankProduct && a.blank > 0 && (
          <Badge variant="outline" className="gap-1">
            <Hammer className="h-3 w-3" /> {blanksLabel} для допроизводства: {a.blank}{whDetail(a.blankByWh, a.blank)}
          </Badge>
        )}
        <WorkshopTransferBadge a={a} />
        <PrintBadge a={a} need={needForProduction} />
      </div>
    );
  }
  if (a.status === "needs_production") {
    return (
      <div className="flex flex-wrap gap-1.5">
        <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 gap-1">
          <Hammer className="h-3 w-3" />{" "}
          {a.isPrint
            ? `Готовых нет, есть пустые на моём складе: ${a.blank}`
            : `Готовых нет, есть пустые: ${a.blank}`}
          {whDetail(a.blankByWh, a.blank)}
        </Badge>
        <WorkshopTransferBadge a={a} />
        <PrintBadge a={a} need={needForProduction} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 gap-1">
        <X className="h-3 w-3" />{" "}
        {a.isPrint ? "Готовых нет · пустых нет на моём складе" : "Нет ни готовых, ни пустых"}
      </Badge>
      <WorkshopTransferBadge a={a} />
      <PrintBadge a={a} need={needForProduction} />
    </div>
  );
}

function WorkshopTransferBadge({ a }: { a: ItemAvailability }) {
  if (a.isPrint || !a.needsWorkshopTransfer) return null;
  return (
    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 gap-1">
      <Truck className="h-3 w-3" /> Нужно отправить {blankGarmentLabel(a.blankProduct)} на склад вышивки: {a.workshopTransferQty}
    </Badge>
  );
}

// Наличие принтов на складе для производства печатной позиции.
function PrintBadge({ a, need }: { a: ItemAvailability; need: number }) {
  if (!a.hasPrintInfo) return null;
  const enough = a.print >= need;
  return (
    <Badge
      className={`gap-1 ${enough
        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
        : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"}`}
    >
      {enough ? <CheckCircle2 className="h-3 w-3" /> : <X className="h-3 w-3" />}{" "}
      {enough ? `Принты на складе: ${a.print}` : `Принтов не хватает: ${a.print} / ${need}`}
    </Badge>
  );
}

function blankKey(cat: string, fab: string, col: string, sz: string) {
  return `${cat}|${fab}|${col}|${sz}`;
}
