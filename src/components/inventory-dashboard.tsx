"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Inventory, OzonOrder, PrintInventory, Size, Warehouse } from "@/lib/types";
import {
  Package,
  Shirt,
  Image as ImageIcon,
  AlertTriangle,
  CheckCircle2,
  Hammer,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const POST_SHIPMENT = new Set([
  "delivering", "delivered", "driver_pickup", "sent_by_seller",
  "arbitration", "client_arbitration", "not_accepted", "cancelled",
]);

export function InventoryDashboard({
  inv,
  prints,
  warehouses,
  sizes,
  loading,
}: {
  inv: Inventory[];
  prints: PrintInventory[];
  warehouses: Warehouse[];
  sizes: Size[];
  loading: boolean;
}) {
  const [orders, setOrders] = useState<OzonOrder[] | null>(null);
  useEffect(() => {
    api.listOzonOrders().then(setOrders).catch(() => setOrders([]));
  }, []);

  // ---- KPIs
  const kpi = useMemo(() => {
    let units = 0, blankSku = 0, finishedSku = 0;
    const seen = new Set<string>();
    for (const i of inv) {
      units += i.quantity;
      if (!seen.has(i.product_id)) {
        seen.add(i.product_id);
        if (i.product?.is_blank) blankSku++; else finishedSku++;
      }
    }
    const printUnits = prints.reduce((s, p) => s + p.quantity, 0);
    return { units, blankSku, finishedSku, printUnits, printDesigns: new Set(prints.map((p) => p.design_id)).size };
  }, [inv, prints]);

  // ---- Stock helpers
  const stockByProduct = useMemo(() => {
    const m = new Map<string, { total: number; byWh: Map<string, number> }>();
    for (const r of inv) {
      const e = m.get(r.product_id) ?? { total: 0, byWh: new Map() };
      e.total += r.quantity;
      e.byWh.set(r.warehouse_id, (e.byWh.get(r.warehouse_id) ?? 0) + r.quantity);
      m.set(r.product_id, e);
    }
    return m;
  }, [inv]);

  const printStockByDesign = useMemo(() => {
    const m = new Map<string, { total: number; byWh: Map<string, number> }>();
    for (const p of prints) {
      const e = m.get(p.design_id) ?? { total: 0, byWh: new Map() };
      e.total += p.quantity;
      e.byWh.set(p.warehouse_id, (e.byWh.get(p.warehouse_id) ?? 0) + p.quantity);
      m.set(p.design_id, e);
    }
    return m;
  }, [prints]);

  // ---- Blank lookup by cat+fab+col+sz (for finished -> blank check on orders)
  const blankByKey = useMemo(() => {
    const m = new Map<string, string>(); // key -> productId
    for (const i of inv) {
      if (!i.product?.is_blank) continue;
      const k = `${i.product.category_id}|${i.product.fabric_id}|${i.product.color_id}|${i.product.size_id}`;
      m.set(k, i.product_id);
    }
    return m;
  }, [inv]);

  // ---- Order readiness summary
  const orderStats = useMemo(() => {
    if (!orders) return null;
    const active = orders.filter((o) => !o.shipped_at && !POST_SHIPMENT.has(o.status));
    let ready = 0, needsProduction = 0, needsBlanks = 0, needsPrints = 0, unmatched = 0;
    for (const o of active) {
      const items = o.items ?? [];
      if (items.length === 0) continue;
      let everyReady = true;
      let canProduce = true;
      let printShortfall = false;
      let blankShortfall = false;
      for (const it of items) {
        if (!it.product) { unmatched++; everyReady = false; canProduce = false; continue; }
        const fin = stockByProduct.get(it.product.id)?.total ?? 0;
        if (fin < it.quantity) {
          everyReady = false;
          // check blank availability
          const k = `${it.product.category_id}|${it.product.fabric_id}|${it.product.color_id}|${it.product.size_id}`;
          const blankId = blankByKey.get(k);
          const blankStock = blankId ? (stockByProduct.get(blankId)?.total ?? 0) : 0;
          if (blankStock < (it.quantity - fin)) blankShortfall = true;
          // check print stock for print designs
          if (it.product.decoration_type?.slug === "print" && it.product.design_id) {
            const printStock = printStockByDesign.get(it.product.design_id)?.total ?? 0;
            if (printStock < (it.quantity - fin)) printShortfall = true;
          }
        }
      }
      if (everyReady) ready++;
      else {
        if (blankShortfall) needsBlanks++;
        else if (printShortfall) needsPrints++;
        else if (canProduce) needsProduction++;
      }
    }
    return { active: active.length, ready, needsProduction, needsBlanks, needsPrints, unmatched };
  }, [orders, stockByProduct, blankByKey, printStockByDesign]);

  // ---- Matrices: blanks and finished by sizes
  const sortedSizes = useMemo(() => [...sizes].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), [sizes]);

  const blankMatrix = useMemo(() => buildSizeMatrix(inv, sortedSizes, (i) => !!i.product?.is_blank, (i) => ({
    key: `${i.product!.category_id}|${i.product!.fabric_id}|${i.product!.color_id}`,
    label: `${i.product!.category?.name ?? ""} ${i.product!.fabric?.name?.toLowerCase() ?? ""}`,
    subLabel: i.product!.color?.name ?? "",
    hex: i.product!.color?.hex_code ?? null,
    designLabel: null,
  })), [inv, sortedSizes]);

  const finishedMatrix = useMemo(() => buildSizeMatrix(inv, sortedSizes, (i) => i.product != null && !i.product.is_blank, (i) => ({
    key: `${i.product!.category_id}|${i.product!.fabric_id}|${i.product!.color_id}|${i.product!.design_id}|${i.product!.decoration_type_id}`,
    label: `${i.product!.category?.name ?? ""} ${i.product!.fabric?.name?.toLowerCase() ?? ""}`,
    subLabel: i.product!.color?.name ?? "",
    hex: i.product!.color?.hex_code ?? null,
    designLabel: `${i.product!.decoration_type?.name ?? ""}: ${i.product!.design?.name ?? ""}`,
  })), [inv, sortedSizes]);

  if (loading) {
    return <div className="p-10 text-center text-muted-foreground">Загрузка…</div>;
  }

  return (
    <div className="space-y-6">
      <KPIRow kpi={kpi} />

      {orderStats && orderStats.active > 0 && (
        <OrderReadinessCard stats={orderStats} />
      )}

      <MatrixCard
        title="Пустые по размерам"
        description="Сколько чистых заготовок есть по каждой комбинации ткани и цвета"
        icon={Shirt}
        sizes={sortedSizes}
        groups={blankMatrix}
        warehouses={warehouses}
        emptyText="Пустых на складе нет"
      />

      <MatrixCard
        title="Готовые по размерам"
        description="Готовая продукция с принтом или вышивкой — по дизайнам"
        icon={Package}
        sizes={sortedSizes}
        groups={finishedMatrix}
        warehouses={warehouses}
        emptyText="Готовых на складе нет"
      />

      <PrintsCard prints={prints} warehouses={warehouses} />
    </div>
  );
}

// ---------- subcomponents ----------

function KPIRow({ kpi }: { kpi: { units: number; blankSku: number; finishedSku: number; printUnits: number; printDesigns: number } }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Kpi icon={Package} label="Единиц на складе" value={kpi.units} />
      <Kpi icon={Shirt} label="Пустых SKU" value={kpi.blankSku} />
      <Kpi icon={Package} label="Готовых SKU" value={kpi.finishedSku} />
      <Kpi icon={ImageIcon} label="Принтов в наличии" value={kpi.printUnits} sub={`${kpi.printDesigns} дизайнов`} />
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-muted p-2"><Icon className="h-4 w-4 text-muted-foreground" /></div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold tabular-nums leading-tight">{value}</div>
            {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderReadinessCard({ stats }: { stats: { active: number; ready: number; needsProduction: number; needsBlanks: number; needsPrints: number; unmatched: number } }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Активные заказы Ozon · {stats.active}</CardTitle>
          <Button asChild size="sm" variant="ghost">
            <Link href="/orders">К заказам <ArrowRight className="h-3.5 w-3.5" /></Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 pt-0">
        <ReadinessTile color="emerald" icon={CheckCircle2} label="Готовы к отправке" value={stats.ready} />
        <ReadinessTile color="blue" icon={Hammer} label="Нужно произвести" value={stats.needsProduction} hint="Пустые есть, принт есть" />
        <ReadinessTile color="amber" icon={AlertTriangle} label="Не хватает пустых" value={stats.needsBlanks} />
        <ReadinessTile color="amber" icon={ImageIcon} label="Не хватает принтов" value={stats.needsPrints} />
        {stats.unmatched > 0 && <ReadinessTile color="zinc" icon={AlertTriangle} label="Без SKU в каталоге" value={stats.unmatched} />}
      </CardContent>
    </Card>
  );
}

function ReadinessTile({ color, icon: Icon, label, value, hint }: { color: "emerald" | "blue" | "amber" | "zinc"; icon: React.ComponentType<{ className?: string }>; label: string; value: number; hint?: string }) {
  const palette: Record<typeof color, string> = {
    emerald: "border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30",
    blue: "border-blue-200 bg-blue-50 dark:bg-blue-950/30",
    amber: "border-amber-200 bg-amber-50 dark:bg-amber-950/30",
    zinc: "border-zinc-200 bg-zinc-50 dark:bg-zinc-900/40",
  };
  return (
    <div className={cn("rounded-md border p-3", palette[color])}>
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" />
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

interface MatrixGroup {
  key: string;
  label: string;
  subLabel: string;
  hex: string | null;
  designLabel: string | null;
  cells: Record<string, { total: number; byWh: Map<string, number> }>; // sizeId -> stock
  total: number;
}

function buildSizeMatrix(
  inv: Inventory[],
  sizes: Size[],
  filter: (i: Inventory) => boolean,
  keyFn: (i: Inventory) => Omit<MatrixGroup, "cells" | "total">,
): MatrixGroup[] {
  const map = new Map<string, MatrixGroup>();
  for (const i of inv) {
    if (!filter(i) || !i.product) continue;
    const meta = keyFn(i);
    let g = map.get(meta.key);
    if (!g) {
      g = { ...meta, cells: {}, total: 0 };
      map.set(meta.key, g);
    }
    const cell = g.cells[i.product.size_id] ?? { total: 0, byWh: new Map() };
    cell.total += i.quantity;
    cell.byWh.set(i.warehouse_id, (cell.byWh.get(i.warehouse_id) ?? 0) + i.quantity);
    g.cells[i.product.size_id] = cell;
    g.total += i.quantity;
  }
  // Sort: by label, then designLabel, then subLabel
  return Array.from(map.values()).sort((a, b) => {
    const al = `${a.label} ${a.designLabel ?? ""} ${a.subLabel}`;
    const bl = `${b.label} ${b.designLabel ?? ""} ${b.subLabel}`;
    return al.localeCompare(bl, "ru");
  });
}

function MatrixCard({
  title,
  description,
  icon: Icon,
  sizes,
  groups,
  warehouses,
  emptyText,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  sizes: Size[];
  groups: MatrixGroup[];
  warehouses: Warehouse[];
  emptyText: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="pt-0">
        {groups.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">{emptyText}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left font-medium pb-2 pr-3 sticky left-0 bg-background">Группа</th>
                  {sizes.map((s) => (
                    <th key={s.id} className="font-medium pb-2 px-1 text-center w-12">{s.name}</th>
                  ))}
                  <th className="font-medium pb-2 pl-3 text-right">Σ</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} className="border-t">
                    <td className="py-1.5 pr-3 sticky left-0 bg-background">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="h-3 w-3 rounded-full border shrink-0" style={{ backgroundColor: g.hex ?? "#999" }} />
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate">{g.label} · <span className="font-normal">{g.subLabel}</span></div>
                          {g.designLabel && <div className="text-[11px] text-muted-foreground truncate">{g.designLabel}</div>}
                        </div>
                      </div>
                    </td>
                    {sizes.map((s) => {
                      const cell = g.cells[s.id];
                      return <Cell key={s.id} cell={cell} warehouses={warehouses} />;
                    })}
                    <td className="py-1.5 pl-3 text-right font-semibold tabular-nums">{g.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Cell({ cell, warehouses }: { cell?: { total: number; byWh: Map<string, number> }; warehouses: Warehouse[] }) {
  const qty = cell?.total ?? 0;
  const cls = qty === 0
    ? "text-muted-foreground/40"
    : qty <= 2
    ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
    : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200";

  const tooltip = cell
    ? Array.from(cell.byWh.entries())
        .map(([wid, q]) => `${warehouses.find((w) => w.id === wid)?.name ?? "?"}: ${q}`)
        .join(" · ")
    : "";

  return (
    <td className="px-1 py-1.5 text-center">
      <div className={cn("inline-flex items-center justify-center min-w-[2rem] h-7 rounded text-sm tabular-nums px-1.5", cls)} title={tooltip}>
        {qty === 0 ? "·" : qty}
      </div>
    </td>
  );
}

function PrintsCard({ prints, warehouses }: { prints: PrintInventory[]; warehouses: Warehouse[] }) {
  const rows = useMemo(() => {
    const byDesign = new Map<string, { design: PrintInventory["design"]; total: number; byWh: Map<string, number> }>();
    for (const p of prints) {
      const e = byDesign.get(p.design_id) ?? { design: p.design, total: 0, byWh: new Map() };
      e.total += p.quantity;
      e.byWh.set(p.warehouse_id, (e.byWh.get(p.warehouse_id) ?? 0) + p.quantity);
      byDesign.set(p.design_id, e);
    }
    return Array.from(byDesign.values()).sort((a, b) => (a.design?.name ?? "").localeCompare(b.design?.name ?? "", "ru"));
  }, [prints]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Принты на складе</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground">Готовые принты для нанесения. При производстве система списывает 1 принт на изделие.</p>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">Принтов на складе нет</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left font-medium pb-2 pr-3">Дизайн</th>
                  {warehouses.map((w) => (
                    <th key={w.id} className="font-medium pb-2 px-2 text-center">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn("h-2 w-2 rounded-full", w.type === "own" ? "bg-emerald-500" : "bg-amber-500")} />
                        {w.name}
                      </span>
                    </th>
                  ))}
                  <th className="font-medium pb-2 pl-3 text-right">Σ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.design?.id} className="border-t">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {r.design?.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.design.image_url} alt="" className="h-8 w-8 rounded object-cover border shrink-0" />
                        ) : (
                          <div className="h-8 w-8 rounded border bg-muted flex items-center justify-center shrink-0">
                            <ImageIcon className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate">{r.design?.name ?? "—"}</div>
                          {r.total === 0 && <Badge variant="outline" className="text-[10px] h-4 mt-0.5 text-amber-700 border-amber-300">пусто</Badge>}
                        </div>
                      </div>
                    </td>
                    {warehouses.map((w) => {
                      const q = r.byWh.get(w.id) ?? 0;
                      return (
                        <td key={w.id} className="px-2 py-2 text-center">
                          <span className={cn("inline-flex items-center justify-center min-w-[2rem] h-7 rounded text-sm tabular-nums px-1.5",
                            q === 0 ? "text-muted-foreground/40" :
                            q <= 2 ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200" :
                            "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200")}>
                            {q === 0 ? "·" : q}
                          </span>
                        </td>
                      );
                    })}
                    <td className="py-2 pl-3 text-right font-semibold tabular-nums">{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
