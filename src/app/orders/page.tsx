"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Inventory, OzonOrder, OzonOrderItem, Product, Warehouse } from "@/lib/types";
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

interface ItemAvailability {
  status: StockStatus;
  finished: number;
  blank: number;
  blankProduct: Product | null;
  need: number;
  finishedByWh: { warehouseId: string; warehouseName: string; qty: number }[];
  blankByWh: { warehouseId: string; warehouseName: string; qty: number }[];
  /** true для изделий с принтом (made_at === "own" или не задано) — пустые из цеха
   *  вышивки игнорируются, т.к. оттуда заготовки на мой склад для печати не возят. */
  isPrint: boolean;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OzonOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inv, setInv] = useState<Inventory[]>([]);
  const [blanks, setBlanks] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"active" | "shipped" | "all">("active");

  async function reload() {
    setLoading(true);
    const [o, w, i, b] = await Promise.all([
      api.listOzonOrders(),
      api.listWarehouses(),
      api.listInventory(),
      api.listProducts({ is_blank: true }),
    ]);
    setOrders(o);
    setWarehouses(w);
    setInv(i);
    setBlanks(b);
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

  function breakdown(productId: string, opts?: { excludeWorkshop?: boolean }) {
    const e = stockByProduct.get(productId);
    if (!e) return { total: 0, list: [] as { warehouseId: string; warehouseName: string; qty: number }[] };
    const entries = Array.from(e.byWh.entries()).filter(([wid, q]) => {
      if (q <= 0) return false;
      if (opts?.excludeWorkshop && warehouseTypeById.get(wid) === "workshop") return false;
      return true;
    });
    const list = entries.map(([warehouseId, qty]) => ({ warehouseId, warehouseName: warehouseNameById.get(warehouseId) ?? "—", qty }));
    const total = entries.reduce((s, [, q]) => s + q, 0);
    return { total, list };
  }

  function availability(item: OzonOrderItem): ItemAvailability {
    const need = item.quantity;
    if (!item.product) {
      return { status: "unmatched", finished: 0, blank: 0, blankProduct: null, need, finishedByWh: [], blankByWh: [], isPrint: false };
    }
    // Принт делается у меня на складе (или decoration_type не указан) — пустые из
    // цеха вышивки не учитываем, т.к. оттуда заготовки на мой склад для печати не возят.
    const isPrint = item.product.decoration_type?.made_at !== "workshop";
    const fin = breakdown(item.product.id);
    const blankProd = blankByKey.get(blankKey(item.product.category_id, item.product.fabric_id, item.product.color_id, item.product.size_id)) ?? null;
    const blk = blankProd ? breakdown(blankProd.id, { excludeWorkshop: isPrint }) : { total: 0, list: [] };
    const base = { finished: fin.total, blank: blk.total, blankProduct: blankProd, need, finishedByWh: fin.list, blankByWh: blk.list, isPrint };
    if (fin.total >= need) return { status: "ready", ...base };
    if (fin.total > 0) return { status: "partial", ...base };
    if (blk.total >= need) return { status: "needs_production", ...base };
    return { status: "missing", ...base };
  }

  function orderReady(order: OzonOrder): boolean {
    if (!order.items || order.items.length === 0) return false;
    return order.items.every((it) => it.product && (stockByProduct.get(it.product.id)?.total ?? 0) >= it.quantity);
  }

  async function doSync(scope: "active" | "all" = "active") {
    setSyncing(true);
    try {
      const r = await api.syncOzonOrders({ scope, days: 60 });
      const scopeLabel = r.scope === "active" ? "активных" : "всех";
      toast.success(`Синхронизировано ${scopeLabel}: ${r.fetched} (новых ${r.created}, обновлено ${r.updated})${r.unmatchedItems ? `, без SKU ${r.unmatchedItems}` : ""}`);
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
      if (!it.product) return false;
      const a = availability(it);
      if (a.status === "ready") return false;
      const dec = it.product.decoration_type;
      if (!dec || dec.made_at !== "workshop") return false;
      if (!a.blankProduct) return false;
      if (a.blank < a.need) return false;
      return true;
    });
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
      if (tab === "shipped" && !o.shipped_at && !POST_SHIPMENT_STATUSES.has(o.status)) return false;
      if (tab === "active" && (o.shipped_at || TERMINAL_STATUSES.has(o.status))) return false;
      if (search) {
        const hay = [o.posting_number, o.order_number, o.customer_name, ...(o.items?.map((it) => `${it.offer_id} ${it.name}`) ?? [])].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [orders, tab, search]);

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
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="active">Активные</TabsTrigger>
            <TabsTrigger value="shipped">Отправленные</TabsTrigger>
            <TabsTrigger value="all">Все</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Поиск по номеру отправления, артикулу, имени…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

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
              availability={availability}
              canSendToWorkshop={workshopEligible(o)}
              onShip={() => ship(o)}
              onUnship={() => unship(o)}
              onSendToWorkshop={() => sendToWorkshop(o)}
              onFulfillViaWorkshop={() => fulfillViaWorkshop(o)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({ order, ready, availability, canSendToWorkshop, onShip, onUnship, onSendToWorkshop, onFulfillViaWorkshop }: {
  order: OzonOrder;
  ready: boolean;
  availability: (it: OzonOrderItem) => ItemAvailability;
  canSendToWorkshop: boolean;
  onShip: () => void;
  onUnship: () => void;
  onSendToWorkshop: () => void;
  onFulfillViaWorkshop: () => void;
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
          <div className="flex gap-2">
            {showActions && !shipped && wsLinked && (
              <Button size="sm" onClick={onFulfillViaWorkshop}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Произвели и отправили
              </Button>
            )}
            {showActions && !shipped && !wsLinked && canSendToWorkshop && !ready && (
              <Button size="sm" onClick={onSendToWorkshop}>
                <Send className="h-3.5 w-3.5" /> Отправить в цех
              </Button>
            )}
            {showActions && !shipped && !wsLinked && ready && (
              <Button size="sm" onClick={onShip}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Отправил заказ
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
              <a href={`https://seller.ozon.ru/app/orders/fbs/${order.posting_number}`} target="_blank" rel="noopener noreferrer">
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
              availability={showAvailability ? availability(it) : null}
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
      </div>
    );
  }
  if (a.status === "needs_production") {
    return (
      <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 gap-1">
        <Hammer className="h-3 w-3" />{" "}
        {a.isPrint
          ? `Готовых нет, есть пустые на моём складе: ${a.blank}`
          : `Готовых нет, есть пустые: ${a.blank}`}
        {whDetail(a.blankByWh, a.blank)}
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 gap-1">
      <X className="h-3 w-3" />{" "}
      {a.isPrint ? "Готовых нет · пустых нет на моём складе" : "Нет ни готовых, ни пустых"}
    </Badge>
  );
}

function blankKey(cat: string, fab: string, col: string, sz: string) {
  return `${cat}|${fab}|${col}|${sz}`;
}
