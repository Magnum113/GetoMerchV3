"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, BarChart3, PackageX, PieChart, RefreshCw, Sparkles, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProductDisplay } from "@/components/product-display";
import { ExpenseDonut } from "@/components/analytics/expense-donut";
import { NonRedemptionChart } from "@/components/analytics/non-redemption-chart";
import { OrdersChart } from "@/components/analytics/orders-chart";
import { PeriodChart } from "@/components/analytics/period-chart";
import { RevenueChart } from "@/components/analytics/revenue-chart";
import { Sparkline } from "@/components/analytics/sparkline";
import { StockValueCard } from "@/components/analytics/stock-value-card";
import { api } from "@/lib/api";
import {
  bucketize,
  bucketizeNonRedemption,
  bucketizeOrders,
  bucketizeOrdersRevenue,
  buildCostIndex,
  computePeriodMetrics,
  delta,
  expenseBreakdown,
  formatDateRange,
  isoDate,
  nonRedemptionByProduct,
  ordersRevenueSummary,
  ordersSummary,
  presetRange,
  previousPeriod,
  suggestGranularity,
  topProductsByProfit,
  type Granularity,
  type PeriodFilter,
} from "@/lib/analytics";
import type { Expense, ExpenseCategory, Inventory, OzonFinanceOperation, OzonOrder, Product, Warehouse } from "@/lib/types";
import { cn, errorMessage, formatMoney } from "@/lib/utils";

type PresetKey = "7d" | "30d" | "90d" | "mtd" | "ytd";

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "7d", label: "7 дн" },
  { key: "30d", label: "30 дн" },
  { key: "90d", label: "90 дн" },
  { key: "mtd", label: "Месяц" },
  { key: "ytd", label: "Год" },
];

export default function AnalyticsDashboardPage() {
  const [preset, setPreset] = useState<PresetKey>("30d");
  const [orders, setOrders] = useState<OzonOrder[]>([]);
  const [ops, setOps] = useState<OzonFinanceOperation[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [skuMap, setSkuMap] = useState<Array<{ ozon_sku: string; product: Product }>>([]);
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [gran, setGran] = useState<Granularity | "auto">("auto");
  const [ordersMode, setOrdersMode] = useState<"orders" | "revenue">("orders");
  const [showAllNonRedemptionProducts, setShowAllNonRedemptionProducts] = useState(false);
  const reloadSequence = useRef(0);

  const filter = useMemo<PeriodFilter>(() => presetRange(preset), [preset]);
  const prevFilter = useMemo(() => previousPeriod(filter), [filter]);
  const dataWindow = useMemo(() => {
    const from = new Date(Math.min(filter.from.getTime(), prevFilter.from.getTime()));
    const toExclusive = new Date(Math.max(filter.to.getTime(), prevFilter.to.getTime()));
    const toInclusive = new Date(toExclusive.getTime() - 1);
    return {
      financeFrom: from.toISOString(),
      financeTo: toExclusive.toISOString(),
      expenseFrom: isoDate(from),
      expenseTo: isoDate(toInclusive),
    };
  }, [filter, prevFilter]);

  async function reload() {
    const sequence = ++reloadSequence.current;
    setLoading(true);
    try {
      const [ord, opsAll, exp, cats, sync, sku, invRows, whRows] = await Promise.all([
        api.listOzonOrders(),
        api.listFinanceOperations({ from: dataWindow.financeFrom, to: dataWindow.financeTo }),
        api.listExpenses({ from: dataWindow.expenseFrom, to: dataWindow.expenseTo }),
        api.listExpenseCategories(),
        api.lastFinanceSyncAt(),
        api.listOzonSkuProductMap(),
        api.listInventory(),
        api.listWarehouses(),
      ]);
      if (sequence !== reloadSequence.current) return;
      setOrders(ord);
      setOps(opsAll);
      setExpenses(exp);
      setCategories(cats);
      setLastSync(sync);
      setSkuMap(sku);
      setInventory(invRows);
      setWarehouses(whRows);
    } catch (e) {
      if (sequence === reloadSequence.current) toast.error(errorMessage(e));
    } finally {
      if (sequence === reloadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [preset]);

  async function sync() {
    setSyncing(true);
    try {
      // 1) Дотягиваем заказы за 180 дней, чтобы COGS считалась по максимуму свежей карточки заказа
      // 2) Тянем все финансовые операции за год
      const [ordRes, finRes] = await Promise.all([
        api.syncOzonOrders({ scope: "all", days: 180 }).catch((e) => ({ error: errorMessage(e) })),
        api.syncOzonFinance(),
      ]);
      const ordMsg = "error" in ordRes
        ? `Заказы: ошибка (${ordRes.error})`
        : `Заказы: +${ordRes.created} / обн. ${ordRes.updated}${ordRes.failedOrders ? `, не обновлено ${ordRes.failedOrders}` : ""}${ordRes.failedItemOrders ? `, позиции ${ordRes.failedItemOrders}` : ""}`;
      toast.success(`Финансы: +${finRes.created} / обн. ${finRes.updated}. ${ordMsg}`);
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  const costIndex = useMemo(() => buildCostIndex(orders, skuMap), [orders, skuMap]);

  const metrics = useMemo(
    () => computePeriodMetrics(ops, expenses, costIndex, filter, orders),
    [ops, expenses, costIndex, filter, orders],
  );
  const prevMetrics = useMemo(
    () => computePeriodMetrics(ops, expenses, costIndex, prevFilter, orders),
    [ops, expenses, costIndex, prevFilter, orders],
  );

  const granularity: Granularity = gran === "auto" ? suggestGranularity(filter) : gran;
  const buckets = useMemo(
    () => bucketize(ops, expenses, costIndex, filter, granularity, orders),
    [ops, expenses, costIndex, filter, granularity, orders],
  );

  const breakdown = useMemo(
    () => expenseBreakdown(metrics, expenses, categories, filter),
    [metrics, expenses, categories, filter],
  );
  const ordersBuckets = useMemo(
    () => bucketizeOrders(orders, filter, granularity),
    [orders, filter, granularity],
  );
  const prevOrdersBuckets = useMemo(
    () => bucketizeOrders(orders, prevFilter, granularity),
    [orders, prevFilter, granularity],
  );
  const ordersStats = useMemo(() => ordersSummary(orders, filter), [orders, filter]);
  const prevOrdersStats = useMemo(() => ordersSummary(orders, prevFilter), [orders, prevFilter]);
  const revenueBuckets = useMemo(
    () => bucketizeOrdersRevenue(orders, filter, granularity),
    [orders, filter, granularity],
  );
  const prevRevenueBuckets = useMemo(
    () => bucketizeOrdersRevenue(orders, prevFilter, granularity),
    [orders, prevFilter, granularity],
  );
  const revenueStats = useMemo(() => ordersRevenueSummary(orders, filter), [orders, filter]);
  const prevRevenueStats = useMemo(() => ordersRevenueSummary(orders, prevFilter), [orders, prevFilter]);
  const nonRedemptionBuckets = useMemo(
    () => bucketizeNonRedemption(orders, filter, granularity),
    [orders, filter, granularity],
  );
  const prevNonRedemptionBuckets = useMemo(
    () => bucketizeNonRedemption(orders, prevFilter, granularity),
    [orders, prevFilter, granularity],
  );
  const productNonRedemption = useMemo(
    () => nonRedemptionByProduct(orders, filter, 12),
    [orders, filter],
  );
  const visibleProductNonRedemption = showAllNonRedemptionProducts
    ? productNonRedemption
    : productNonRedemption.slice(0, 5);
  const nonRedemptionTerminal = ordersStats.delivered + ordersStats.cancelled;
  const prevNonRedemptionTerminal = prevOrdersStats.delivered + prevOrdersStats.cancelled;
  const nonRedemptionRate = nonRedemptionTerminal > 0 ? ordersStats.cancelled / nonRedemptionTerminal : 0;
  const prevNonRedemptionRate = prevNonRedemptionTerminal > 0 ? prevOrdersStats.cancelled / prevNonRedemptionTerminal : 0;
  const topProducts = useMemo(
    () =>
      topProductsByProfit(
        ops,
        costIndex,
        filter,
        {
          tax: metrics.tax,
          ozonOther: metrics.ozonOther,
          otherExpenses: metrics.otherExpenses,
          totalRevenue: metrics.revenue,
        },
        8,
      ),
    [ops, costIndex, filter, metrics.tax, metrics.ozonOther, metrics.otherExpenses, metrics.revenue],
  );

  const sparkData = useMemo(() => {
    return {
      revenue: buckets.map((b) => b.metrics.revenue),
      orders: buckets.map((b) => b.metrics.ordersCount),
      expenses: buckets.map((b) => b.metrics.totalExpenses),
      profit: buckets.map((b) => b.metrics.netProfit),
    };
  }, [buckets]);

  const noData = !loading && ops.length === 0 && expenses.length === 0;

  return (
    <div>
      <PageHeader
        title="Аналитика"
        action={
          <div className="flex flex-col items-end gap-1">
            <Button onClick={sync} disabled={syncing} variant="outline">
              <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
              {syncing ? "Синхронизация…" : "Обновить данные Ozon"}
            </Button>
            {lastSync && (
              <span className="text-[11px] text-muted-foreground">
                Финансы Ozon обновлены: {new Date(lastSync).toLocaleString("ru-RU")}
              </span>
            )}
          </div>
        }
      />

      <Card className="mb-5">
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground mr-1">Период:</span>
          {PRESETS.map((p) => (
            <Pill key={p.key} active={preset === p.key} onClick={() => setPreset(p.key)}>{p.label}</Pill>
          ))}
          <span className="text-xs text-muted-foreground ml-auto mr-1">Шаг:</span>
          {([
            { v: "auto", l: "Авто" },
            { v: "day", l: "День" },
            { v: "week", l: "Неделя" },
            { v: "month", l: "Месяц" },
          ] as const).map((g) => (
            <Pill key={g.v} active={gran === g.v} onClick={() => setGran(g.v)}>{g.l}</Pill>
          ))}
          <span className="text-xs text-muted-foreground w-full sm:w-auto sm:ml-3">
            {formatDateRange(filter)}
          </span>
        </CardContent>
      </Card>

      {!loading && ops.length === 0 && expenses.length > 0 && (
        <Card className="mb-5 border-state-warning-fg/30 bg-state-warning/40">
          <CardContent className="p-3 flex items-center gap-3 text-sm">
            <Sparkles className="h-4 w-4 text-state-warning-fg shrink-0" />
            <span className="text-state-warning-fg">
              Финансы Ozon ещё не загружены — выручка, комиссии и налог считаются по нулям. Запустите синхронизацию для полной картины.
            </span>
          </CardContent>
        </Card>
      )}

      {noData ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Sparkles}
              title="Финансы Ozon ещё не загружены"
              description="Нажмите «Обновить данные Ozon» — мы потянем за последний год операции (комиссии, логистику, поступления) и сможем считать чистую прибыль."
              action={<Button onClick={sync} disabled={syncing}><RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} /> Запустить синхронизацию</Button>}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-5">
            <KpiCard
              label="Выручка"
              value={formatMoney(metrics.revenue)}
              delta={delta(metrics.revenue, prevMetrics.revenue)}
              sparkData={sparkData.revenue}
              sparkColor="hsl(var(--state-info-fg))"
              loading={loading}
            />
            <KpiCard
              label="Заказов"
              value={metrics.ordersCount.toLocaleString("ru-RU")}
              delta={delta(metrics.ordersCount, prevMetrics.ordersCount)}
              sparkData={sparkData.orders}
              sparkColor="hsl(var(--primary))"
              loading={loading}
            />
            <KpiCard
              label="Расходы"
              value={formatMoney(metrics.totalExpenses)}
              delta={delta(metrics.totalExpenses, prevMetrics.totalExpenses)}
              sparkData={sparkData.expenses}
              sparkColor="hsl(var(--state-danger-fg))"
              loading={loading}
              invertDelta
            />
            <KpiCard
              label="Чистая прибыль"
              value={formatMoney(metrics.netProfit)}
              delta={delta(metrics.netProfit, prevMetrics.netProfit)}
              sparkData={sparkData.profit}
              sparkColor="hsl(var(--state-success-fg))"
              loading={loading}
              hint={`Маржа ${(metrics.margin * 100).toFixed(0)}%`}
              emphasize
            />
          </div>

          {/* Динамика */}
          <Card className="mb-5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Динамика по {granularity === "day" ? "дням" : granularity === "week" ? "неделям" : "месяцам"}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-1">
              {buckets.length > 0 ? (
                <PeriodChart buckets={buckets} />
              ) : (
                <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                  За период данных нет
                </div>
              )}
            </CardContent>
          </Card>

          {/* Заказы и выручка — переключатель режимов */}
          <Card className="mb-5">
            <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                Заказы и выручка
              </CardTitle>
              <div className="flex items-center gap-1.5">
                <Pill active={ordersMode === "orders"} onClick={() => setOrdersMode("orders")}>Заказы</Pill>
                <Pill active={ordersMode === "revenue"} onClick={() => setOrdersMode("revenue")}>Выручка</Pill>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {ordersMode === "orders" ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <FunnelTile
                      label="Всего товаров"
                      value={String(ordersStats.total)}
                      delta={delta(ordersStats.total, prevOrdersStats.total)}
                      accent="default"
                    />
                    <FunnelTile
                      label="Доставлено"
                      value={String(ordersStats.delivered)}
                      hint={ordersStats.total > 0 ? `${Math.round((ordersStats.delivered / ordersStats.total) * 100)}%` : undefined}
                      delta={delta(ordersStats.delivered, prevOrdersStats.delivered)}
                      accent="success"
                    />
                    <FunnelTile
                      label="В процессе"
                      value={String(ordersStats.inflight)}
                      hint={ordersStats.total > 0 ? `${Math.round((ordersStats.inflight / ordersStats.total) * 100)}%` : undefined}
                      delta={delta(ordersStats.inflight, prevOrdersStats.inflight)}
                      accent="info"
                    />
                    <FunnelTile
                      label="Отменено / невыкуп"
                      value={String(ordersStats.cancelled)}
                      hint={ordersStats.total > 0 ? `${Math.round((ordersStats.cancelled / ordersStats.total) * 100)}%` : undefined}
                      delta={delta(ordersStats.cancelled, prevOrdersStats.cancelled)}
                      accent="danger"
                      invertDelta
                    />
                  </div>
                  {ordersBuckets.length > 0 ? (
                    <OrdersChart buckets={ordersBuckets} prevBuckets={prevOrdersBuckets} />
                  ) : (
                    <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                      За период заказов нет
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <FunnelTile
                      label="Выручка по заказам"
                      value={formatMoney(revenueStats.revenue)}
                      delta={delta(revenueStats.revenue, prevRevenueStats.revenue)}
                      accent="info"
                    />
                    <FunnelTile
                      label="Заказов"
                      value={String(revenueStats.orders)}
                      delta={delta(revenueStats.orders, prevRevenueStats.orders)}
                      accent="default"
                    />
                    <FunnelTile
                      label="Средний чек"
                      value={formatMoney(revenueStats.avgCheck)}
                      delta={delta(revenueStats.avgCheck, prevRevenueStats.avgCheck)}
                      accent="default"
                    />
                  </div>
                  {revenueBuckets.length > 0 ? (
                    <RevenueChart buckets={revenueBuckets} prevBuckets={prevRevenueBuckets} />
                  ) : (
                    <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                      За период заказов нет
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Выручка по дате создания заказа в Ozon — оперативная метрика, совпадает с цифрами в кабинете Ozon. Не путать с KPI «Выручка» сверху (по дате финансовой проводки — кассовый метод).
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Невыкуп */}
          <div className="mb-5 grid gap-5 2xl:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <PackageX className="h-4 w-4 text-muted-foreground" />
                  Процент невыкупа
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <FunnelTile
                    label="Невыкуп"
                    value={`${(nonRedemptionRate * 100).toFixed(1)}%`}
                    hint={`${ordersStats.cancelled} из ${nonRedemptionTerminal} финализированных`}
                    delta={delta(nonRedemptionRate, prevNonRedemptionRate)}
                    accent="danger"
                    invertDelta
                  />
                  <FunnelTile
                    label="Доставлено"
                    value={String(ordersStats.delivered)}
                    hint={nonRedemptionTerminal > 0 ? `${Math.round((ordersStats.delivered / nonRedemptionTerminal) * 100)}% финализированных` : undefined}
                    delta={delta(ordersStats.delivered, prevOrdersStats.delivered)}
                    accent="success"
                  />
                </div>
                <NonRedemptionChart buckets={nonRedemptionBuckets} prevBuckets={prevNonRedemptionBuckets} />
                <p className="text-[11px] text-muted-foreground">
                  Процент считается только по финализированным товарам: доставлено + отменено / не принято. Заказы в пути не включены в знаменатель.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Топ товаров по невыкупу</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
                {productNonRedemption.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-10">Нет финализированных товаров за период</div>
                ) : (
                  <div className="overflow-hidden rounded-md border">
                    <Table className="min-w-[600px] table-fixed 2xl:min-w-0">
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead className="w-[48%] px-4">Товар</TableHead>
                          <TableHead className="w-[13%] px-3 text-right">Невыкуп</TableHead>
                          <TableHead className="w-[17%] px-3 text-right">Доставлено</TableHead>
                          <TableHead className="w-[10%] px-3 text-right">Всего</TableHead>
                          <TableHead className="w-[12%] px-4 text-right">%</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleProductNonRedemption.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell className="px-4 py-4 align-top">
                              {row.product ? (
                                <ProductDisplay p={row.product} compact layout="stacked" />
                              ) : (
                                <div className="min-w-0 space-y-1">
                                  <div className="break-words font-medium leading-snug">{row.name}</div>
                                  <div className="break-all font-mono text-xs text-muted-foreground">{row.offerId}</div>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap px-3 py-4 text-right tabular-nums text-state-danger-fg">{row.nonRedeemed}</TableCell>
                            <TableCell className="whitespace-nowrap px-3 py-4 text-right tabular-nums text-muted-foreground">{row.delivered}</TableCell>
                            <TableCell className="whitespace-nowrap px-3 py-4 text-right tabular-nums text-muted-foreground">{row.terminal}</TableCell>
                            <TableCell className="whitespace-nowrap px-4 py-4 text-right tabular-nums font-semibold">{(row.rate * 100).toFixed(1)}%</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {productNonRedemption.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
                    <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                      Сортировка по количеству невыкупленных товаров, процент считается внутри финализированных единиц товара.
                    </p>
                    {productNonRedemption.length > 5 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setShowAllNonRedemptionProducts((v) => !v)}
                      >
                        {showAllNonRedemptionProducts
                          ? "Свернуть"
                          : `Показать все (${productNonRedemption.length})`}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Donut + Top products */}
          <div className="mb-5 grid gap-5 2xl:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <PieChart className="h-4 w-4 text-muted-foreground" />
                  Структура расходов
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ExpenseDonut entries={breakdown} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Топ продуктов по чистой прибыли</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
                {topProducts.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-10">Нет данных</div>
                ) : (
                  <div className="overflow-hidden rounded-md border">
                    <Table className="min-w-[560px] table-fixed 2xl:min-w-0">
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead className="w-1/2 px-4">Товар</TableHead>
                          <TableHead className="w-[10%] px-3 text-right">Шт</TableHead>
                          <TableHead className="w-[20%] px-3 text-right">Выручка</TableHead>
                          <TableHead className="w-[20%] px-4 text-right">Чистая</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {topProducts.map((p) => {
                          const totalDeductions = p.cogs + p.ozonFees + p.allocatedOverhead;
                          const breakdownTitle =
                            `Выручка ${formatMoney(p.revenue)}\n` +
                            `− Себестоимость ${formatMoney(p.cogs)}\n` +
                            `− Расходы Ozon ${formatMoney(p.ozonFees)}\n` +
                            `− Налог + прочее ${formatMoney(p.allocatedOverhead)}\n` +
                            `= Чистая ${formatMoney(p.netProfit)} (всего вычетов ${formatMoney(totalDeductions)})`;
                          return (
                            <TableRow key={p.productId}>
                              <TableCell className="px-4 py-4 align-top">
                                <ProductDisplay p={p.product} compact layout="stacked" />
                              </TableCell>
                              <TableCell className="whitespace-nowrap px-3 py-4 text-right tabular-nums">{p.unitsSold}</TableCell>
                              <TableCell className="whitespace-nowrap px-3 py-4 text-right tabular-nums">{formatMoney(p.revenue)}</TableCell>
                              <TableCell className="px-4 py-4 text-right tabular-nums" title={breakdownTitle}>
                                <div className="flex flex-col items-end gap-0.5">
                                  <span
                                    className={cn(
                                      "whitespace-nowrap font-semibold",
                                      p.netProfit >= 0 ? "text-state-success-fg" : "text-state-danger-fg",
                                    )}
                                  >
                                    {formatMoney(p.netProfit)}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {(p.marginPct * 100).toFixed(0)}%
                                  </span>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Стоимость остатков */}
          <div className="mb-5">
            <StockValueCard inv={inventory} warehouses={warehouses} loading={loading} />
          </div>

          {/* Period table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">По периодам</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
              {buckets.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-10">Нет данных</div>
              ) : (
                <div className="overflow-hidden rounded-md border">
                  <Table className="min-w-[920px]">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead className="w-28 px-4">{granularity === "month" ? "Месяц" : granularity === "week" ? "Неделя" : "День"}</TableHead>
                        <TableHead className="px-3 text-right">Выручка</TableHead>
                        <TableHead className="px-3 text-right">Заказы</TableHead>
                        <TableHead className="px-3 text-right">Себест.</TableHead>
                        <TableHead className="px-3 text-right">Ozon</TableHead>
                        <TableHead className="px-3 text-right">Налог</TableHead>
                        <TableHead className="px-3 text-right">Прочее</TableHead>
                        <TableHead className="px-3 text-right">Чистая</TableHead>
                        <TableHead className="w-20 px-4 text-right">Маржа</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...buckets].reverse().map((b) => (
                        <TableRow key={b.key}>
                          <TableCell className="whitespace-nowrap px-4 py-3 font-medium">{b.label}</TableCell>
                          <TableCell className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatMoney(b.metrics.revenue)}</TableCell>
                          <TableCell className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">{b.metrics.ordersCount}</TableCell>
                          <TableCell className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">{formatMoney(b.metrics.cogs)}</TableCell>
                          <TableCell className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">{formatMoney(b.metrics.ozonFeesTotal)}</TableCell>
                          <TableCell className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">{formatMoney(b.metrics.tax)}</TableCell>
                          <TableCell className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">{formatMoney(b.metrics.otherExpenses)}</TableCell>
                          <TableCell className={cn("whitespace-nowrap px-3 py-3 text-right tabular-nums font-semibold", b.metrics.netProfit >= 0 ? "text-state-success-fg" : "text-state-danger-fg")}>
                            {formatMoney(b.metrics.netProfit)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted-foreground">{(b.metrics.margin * 100).toFixed(0)}%</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta: d,
  sparkData,
  sparkColor,
  loading,
  hint,
  emphasize,
  invertDelta,
}: {
  label: string;
  value: string;
  delta: { abs: number; pct: number | null };
  sparkData: number[];
  sparkColor: string;
  loading?: boolean;
  hint?: string;
  emphasize?: boolean;
  invertDelta?: boolean;
}) {
  const positiveIsGood = !invertDelta;
  const good = d.abs === 0 ? null : positiveIsGood ? d.abs > 0 : d.abs < 0;
  return (
    <Card className={cn(emphasize && "ring-1 ring-state-success-fg/30")}>
      <CardContent className={cn("p-5", emphasize && "pb-4")}>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
          {d.pct != null && (
            <span
              className={cn(
                "text-xs font-medium inline-flex items-center gap-0.5",
                good == null ? "text-muted-foreground" : good ? "text-state-success-fg" : "text-state-danger-fg",
              )}
              title={`Δ ${formatMoney(d.abs)} vs пред. период`}
            >
              {good == null ? null : d.abs > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {(d.pct * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <div className={cn("font-bold tabular-nums tracking-tight", emphasize ? "text-3xl" : "text-2xl")}>
          {loading ? <span className="inline-block h-8 w-24 bg-muted rounded animate-pulse" /> : value}
        </div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
        <div className="mt-2">
          <Sparkline data={sparkData} color={sparkColor} />
        </div>
      </CardContent>
    </Card>
  );
}

function FunnelTile({
  label,
  value,
  hint,
  accent,
  delta: d,
  invertDelta,
}: {
  label: string;
  value: string;
  hint?: string;
  accent: "default" | "success" | "info" | "danger";
  delta?: { abs: number; pct: number | null };
  invertDelta?: boolean;
}) {
  const accentClass = {
    default: "border-border",
    success: "border-state-success-fg/40 bg-state-success/20",
    info: "border-state-info-fg/40 bg-state-info/20",
    danger: "border-state-danger-fg/40 bg-state-danger/20",
  }[accent];
  const dotClass = {
    default: "bg-muted-foreground",
    success: "bg-state-success-fg",
    info: "bg-state-info-fg",
    danger: "bg-state-danger-fg",
  }[accent];
  const positiveIsGood = !invertDelta;
  const good = d == null || d.abs === 0 ? null : positiveIsGood ? d.abs > 0 : d.abs < 0;
  return (
    <div className={cn("rounded-md border p-3", accentClass)}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
          {label}
        </div>
        {d?.pct != null && (
          <span
            className={cn(
              "text-[11px] font-medium inline-flex items-center gap-0.5 shrink-0",
              good == null ? "text-muted-foreground" : good ? "text-state-success-fg" : "text-state-danger-fg",
            )}
            title={`Δ ${d.abs} vs пред. период`}
          >
            {good == null ? null : d.abs > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {(d.pct * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}
