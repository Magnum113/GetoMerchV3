"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { ProductDisplay } from "@/components/product-display";
import { api } from "@/lib/api";
import { TRANSACTION_LABELS, WORKSHOP_STATUS_LABELS, WORKSHOP_STATUS_COLORS } from "@/lib/types";
import type { Inventory, Transaction, WorkshopOrder, Warehouse } from "@/lib/types";
import { Package, Warehouse as WarehouseIcon, Hammer, ArrowLeftRight, Plus, AlertTriangle } from "lucide-react";
import { formatDate } from "@/lib/utils";

export default function DashboardPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [recentTx, setRecentTx] = useState<Transaction[]>([]);
  const [orders, setOrders] = useState<WorkshopOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [w, inv, tx, ord] = await Promise.all([
          api.listWarehouses(),
          api.listInventory(),
          api.listTransactions(10),
          api.listWorkshopOrders(),
        ]);
        setWarehouses(w);
        setInventory(inv);
        setRecentTx(tx);
        setOrders(ord);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const totalItems = inventory.reduce((sum, i) => sum + i.quantity, 0);
  const totalSkus = new Set(inventory.map((i) => i.product_id)).size;
  const activeOrders = orders.filter((o) => ["pending", "sent", "in_progress", "ready"].includes(o.status));

  // По складам
  const byWarehouse = warehouses.map((w) => {
    const ws = inventory.filter((i) => i.warehouse_id === w.id);
    return {
      warehouse: w,
      total: ws.reduce((sum, i) => sum + i.quantity, 0),
      uniqueSkus: new Set(ws.map((i) => i.product_id)).size,
      blanks: ws.filter((i) => i.product?.is_blank).reduce((s, i) => s + i.quantity, 0),
      finished: ws.filter((i) => !i.product?.is_blank).reduce((s, i) => s + i.quantity, 0),
    };
  });

  const lowStock = inventory.filter((i) => i.quantity > 0 && i.quantity <= 2).slice(0, 5);

  return (
    <div>
      <PageHeader
        title="Дашборд"
        description="Сводка по складам, заказам в цех и последним операциям"
        action={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/inventory"><Plus className="h-4 w-4" /> Приёмка</Link>
            </Button>
            <Button asChild>
              <Link href="/workshop"><Hammer className="h-4 w-4" /> Заказ в цех</Link>
            </Button>
          </div>
        }
      />

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard icon={Package} label="Всего единиц" value={totalItems} loading={loading} />
        <KpiCard icon={WarehouseIcon} label="Уникальных SKU" value={totalSkus} loading={loading} />
        <KpiCard icon={Hammer} label="Активные заказы" value={activeOrders.length} loading={loading} accent="amber" />
        <KpiCard icon={ArrowLeftRight} label="Операций (всего)" value={recentTx.length > 0 ? `${recentTx.length}+` : 0} loading={loading} />
      </div>

      {/* По складам */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>По складам</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-4">
            {byWarehouse.map(({ warehouse, total, uniqueSkus, blanks, finished }) => (
              <div key={warehouse.id} className="rounded-lg border p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${warehouse.type === "own" ? "bg-emerald-500" : "bg-amber-500"}`} />
                    <span className="font-medium">{warehouse.name}</span>
                  </div>
                  <Badge variant="outline">{warehouse.type === "own" ? "свой" : "цех"}</Badge>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <Metric label="Единиц" value={total} />
                  <Metric label="Пустых" value={blanks} muted />
                  <Metric label="Готовых" value={finished} muted />
                </div>
                <div className="mt-3 text-xs text-muted-foreground">{uniqueSkus} уникальных SKU</div>
              </div>
            ))}
            {warehouses.length === 0 && !loading && (
              <div className="text-sm text-muted-foreground">Нет складов. <Link href="/settings" className="underline">Добавить</Link></div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Последние операции */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Последние операции</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/transactions">Все →</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recentTx.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">Операций пока нет</div>
            ) : (
              <div className="space-y-3">
                {recentTx.slice(0, 6).map((t) => (
                  <div key={t.id} className="flex items-start justify-between gap-3 pb-3 border-b last:border-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-[10px]">{TRANSACTION_LABELS[t.type]}</Badge>
                        <span className="text-xs text-muted-foreground">{formatDate(t.occurred_at)}</span>
                      </div>
                      <ProductDisplay p={t.product} compact />
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold">{t.quantity} шт</div>
                      <div className="text-[10px] text-muted-foreground">
                        {t.from_warehouse?.name ?? "—"} → {t.to_warehouse?.name ?? "—"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Активные заказы в цех + Low stock */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Активные заказы в цех</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/workshop">Все →</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {activeOrders.length === 0 ? (
                <div className="text-sm text-muted-foreground py-8 text-center">Активных заказов нет</div>
              ) : (
                <div className="space-y-3">
                  {activeOrders.slice(0, 4).map((o) => (
                    <Link href="/workshop" key={o.id} className="flex items-center justify-between gap-3 p-3 -mx-3 rounded-md hover:bg-muted/50 transition">
                      <div>
                        <div className="font-mono text-xs text-muted-foreground">{o.order_number}</div>
                        <div className="text-sm">{o.workshop?.name}</div>
                      </div>
                      <Badge className={WORKSHOP_STATUS_COLORS[o.status]}>{WORKSHOP_STATUS_LABELS[o.status]}</Badge>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {lowStock.length > 0 && (
            <Card className="border-amber-200 dark:border-amber-900/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  Заканчиваются
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {lowStock.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-3 text-sm">
                    <ProductDisplay p={i.product} compact />
                    <Badge variant="outline" className="shrink-0">{i.quantity} шт на «{i.warehouse?.name}»</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, loading, accent }: { icon: typeof Package; label: string; value: number | string; loading?: boolean; accent?: "amber" }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-3">
          <div className={`rounded-lg p-2 ${accent === "amber" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-bold tracking-tight">
              {loading ? <span className="inline-block h-6 w-12 bg-muted rounded animate-pulse" /> : value}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-semibold tabular-nums ${muted ? "text-muted-foreground" : ""}`}>{value}</div>
    </div>
  );
}
