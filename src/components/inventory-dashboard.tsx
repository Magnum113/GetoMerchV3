"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Inventory, PrintInventory, Size, Warehouse } from "@/lib/types";
import {
  Package,
  Shirt,
  Image as ImageIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type WarehouseFilter = "all" | string;

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
  const [whFilter, setWhFilter] = useState<WarehouseFilter>("all");

  const filteredInv = useMemo(() =>
    whFilter === "all" ? inv : inv.filter((i) => i.warehouse_id === whFilter),
  [inv, whFilter]);
  const filteredPrints = useMemo(() =>
    whFilter === "all" ? prints : prints.filter((p) => p.warehouse_id === whFilter),
  [prints, whFilter]);

  // ---- KPIs (по выбранному фильтру)
  const kpi = useMemo(() => {
    let units = 0, blankSku = 0, finishedSku = 0;
    const seen = new Set<string>();
    for (const i of filteredInv) {
      units += i.quantity;
      if (!seen.has(i.product_id)) {
        seen.add(i.product_id);
        if (i.product?.is_blank) blankSku++; else finishedSku++;
      }
    }
    const printUnits = filteredPrints.reduce((s, p) => s + p.quantity, 0);
    return { units, blankSku, finishedSku, printUnits, printDesigns: new Set(filteredPrints.map((p) => p.design_id)).size };
  }, [filteredInv, filteredPrints]);

  // ---- Per-warehouse breakdown (всегда по всем складам, для блока «Распределение»)
  const byWarehouse = useMemo(() => {
    const m = new Map<string, { units: number; products: Set<string>; prints: number; printDesigns: Set<string> }>();
    for (const w of warehouses) m.set(w.id, { units: 0, products: new Set(), prints: 0, printDesigns: new Set() });
    for (const i of inv) {
      const e = m.get(i.warehouse_id);
      if (!e) continue;
      e.units += i.quantity;
      e.products.add(i.product_id);
    }
    for (const p of prints) {
      const e = m.get(p.warehouse_id);
      if (!e) continue;
      e.prints += p.quantity;
      e.printDesigns.add(p.design_id);
    }
    return m;
  }, [inv, prints, warehouses]);

  // ---- Matrices
  const sortedSizes = useMemo(() => [...sizes].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), [sizes]);

  const blankMatrix = useMemo(() => buildSizeMatrix(filteredInv, (i) => !!i.product?.is_blank, (i) => ({
    key: `${i.product!.category_id}|${i.product!.fabric_id}|${i.product!.color_id}`,
    label: `${i.product!.category?.name ?? ""} ${i.product!.fabric?.name?.toLowerCase() ?? ""}`,
    subLabel: i.product!.color?.name ?? "",
    hex: i.product!.color?.hex_code ?? null,
    designLabel: null,
  })), [filteredInv]);

  const finishedMatrix = useMemo(() => buildSizeMatrix(filteredInv, (i) => i.product != null && !i.product.is_blank, (i) => ({
    key: `${i.product!.category_id}|${i.product!.fabric_id}|${i.product!.color_id}|${i.product!.design_id}|${i.product!.decoration_type_id}`,
    label: `${i.product!.category?.name ?? ""} ${i.product!.fabric?.name?.toLowerCase() ?? ""}`,
    subLabel: i.product!.color?.name ?? "",
    hex: i.product!.color?.hex_code ?? null,
    designLabel: `${i.product!.decoration_type?.name ?? ""}: ${i.product!.design?.name ?? ""}`,
  })), [filteredInv]);

  if (loading) {
    return <div className="p-10 text-center text-muted-foreground">Загрузка…</div>;
  }

  const showBreakdownInCells = whFilter === "all" && warehouses.length > 1;
  const filterLabel = whFilter === "all" ? "Все склады" : warehouses.find((w) => w.id === whFilter)?.name ?? "—";

  return (
    <div className="space-y-6">
      <WarehouseFilterBar value={whFilter} onChange={setWhFilter} warehouses={warehouses} />

      <KPIRow kpi={kpi} subtitle={filterLabel} />

      <WarehouseBreakdown warehouses={warehouses} byWarehouse={byWarehouse} activeId={whFilter} onPick={setWhFilter} />

      <MatrixCard
        title="Пустые по размерам"
        description={`Сколько чистых заготовок есть по каждой комбинации ткани и цвета · ${filterLabel}`}
        icon={Shirt}
        sizes={sortedSizes}
        groups={blankMatrix}
        warehouses={warehouses}
        showBreakdown={showBreakdownInCells}
        emptyText="Пустых на складе нет"
      />

      <MatrixCard
        title="Готовые по размерам"
        description={`Готовая продукция с принтом или вышивкой · ${filterLabel}`}
        icon={Package}
        sizes={sortedSizes}
        groups={finishedMatrix}
        warehouses={warehouses}
        showBreakdown={showBreakdownInCells}
        emptyText="Готовых на складе нет"
      />

      <PrintsCard prints={prints} warehouses={warehouses} whFilter={whFilter} />
    </div>
  );
}

function WarehouseFilterBar({ value, onChange, warehouses }: { value: WarehouseFilter; onChange: (v: WarehouseFilter) => void; warehouses: Warehouse[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground mr-1">Показать:</span>
      <Pill active={value === "all"} onClick={() => onChange("all")}>Все склады</Pill>
      {warehouses.map((w) => (
        <Pill key={w.id} active={value === w.id} onClick={() => onChange(w.id)}>
          <span className={cn("h-2 w-2 rounded-full", w.type === "own" ? "bg-emerald-500" : "bg-amber-500")} />
          {w.name}
        </Pill>
      ))}
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

function WarehouseBreakdown({ warehouses, byWarehouse, activeId, onPick }: {
  warehouses: Warehouse[];
  byWarehouse: Map<string, { units: number; products: Set<string>; prints: number; printDesigns: Set<string> }>;
  activeId: WarehouseFilter;
  onPick: (id: WarehouseFilter) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Распределение по складам</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {warehouses.map((w) => {
          const data = byWarehouse.get(w.id) ?? { units: 0, products: new Set<string>(), prints: 0, printDesigns: new Set<string>() };
          const active = activeId === w.id;
          return (
            <button
              key={w.id}
              type="button"
              onClick={() => onPick(active ? "all" : w.id)}
              className={cn(
                "rounded-md border p-3 text-left transition-colors",
                active ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:bg-accent/40"
              )}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={cn("h-2 w-2 rounded-full", w.type === "own" ? "bg-emerald-500" : "bg-amber-500")} />
                <span className="font-medium text-sm">{w.name}</span>
                <Badge variant="outline" className="text-[10px] h-4 ml-auto">{w.type === "own" ? "свой" : "цех"}</Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat label="Изделий" value={data.units} sub={`${data.products.size} SKU`} />
                <Stat label="Принтов" value={data.prints} sub={`${data.printDesigns.size} диз.`} />
                <Stat label="Доля" value={percent(data.units, totalUnits(byWarehouse))} suffix="%" />
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub, suffix }: { label: string; value: number; sub?: string; suffix?: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums leading-tight">{value}{suffix ?? ""}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function totalUnits(m: Map<string, { units: number }>) {
  let s = 0; for (const v of m.values()) s += v.units; return s;
}
function percent(n: number, total: number) {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

// ---------- subcomponents ----------

function KPIRow({ kpi, subtitle }: { kpi: { units: number; blankSku: number; finishedSku: number; printUnits: number; printDesigns: number }; subtitle: string }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Kpi icon={Package} label="Единиц на складе" value={kpi.units} sub={subtitle} />
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
            {sub && <div className="text-[11px] text-muted-foreground truncate">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
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
  showBreakdown,
  emptyText,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  sizes: Size[];
  groups: MatrixGroup[];
  warehouses: Warehouse[];
  showBreakdown: boolean;
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
                      return <Cell key={s.id} cell={cell} warehouses={warehouses} showBreakdown={showBreakdown} />;
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

function shortWh(name: string) {
  if (!name) return "";
  const trimmed = name.trim();
  // «Мой склад» → «М», «Цех вышивки» → «Ц»
  return trimmed.charAt(0).toUpperCase();
}

function Cell({ cell, warehouses, showBreakdown }: { cell?: { total: number; byWh: Map<string, number> }; warehouses: Warehouse[]; showBreakdown: boolean }) {
  const qty = cell?.total ?? 0;
  const cls = qty === 0
    ? "text-muted-foreground/40"
    : qty <= 2
    ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
    : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200";

  const breakdownEntries = cell
    ? Array.from(cell.byWh.entries())
        .filter(([, q]) => q > 0)
        .map(([wid, q]) => ({ wh: warehouses.find((w) => w.id === wid), q }))
    : [];
  const tooltip = breakdownEntries.map(({ wh, q }) => `${wh?.name ?? "?"}: ${q}`).join(" · ");
  const showSplit = showBreakdown && breakdownEntries.length > 1;

  return (
    <td className="px-1 py-1.5 text-center align-top">
      <div className={cn("inline-flex flex-col items-center justify-center min-w-[2.25rem] rounded px-1.5 py-0.5", cls)} title={tooltip}>
        <div className="text-sm tabular-nums leading-tight">{qty === 0 ? "·" : qty}</div>
        {showSplit && (
          <div className="text-[9px] opacity-70 leading-tight font-medium">
            {breakdownEntries.map(({ wh, q }) => `${shortWh(wh?.name ?? "")}${q}`).join("·")}
          </div>
        )}
      </div>
    </td>
  );
}

function PrintsCard({ prints, warehouses, whFilter }: { prints: PrintInventory[]; warehouses: Warehouse[]; whFilter: WarehouseFilter }) {
  const visibleWarehouses = useMemo(
    () => whFilter === "all" ? warehouses : warehouses.filter((w) => w.id === whFilter),
    [warehouses, whFilter]
  );
  const rows = useMemo(() => {
    const byDesign = new Map<string, { design: PrintInventory["design"]; total: number; byWh: Map<string, number> }>();
    for (const p of prints) {
      if (whFilter !== "all" && p.warehouse_id !== whFilter) continue;
      const e = byDesign.get(p.design_id) ?? { design: p.design, total: 0, byWh: new Map() };
      e.total += p.quantity;
      e.byWh.set(p.warehouse_id, (e.byWh.get(p.warehouse_id) ?? 0) + p.quantity);
      byDesign.set(p.design_id, e);
    }
    return Array.from(byDesign.values()).sort((a, b) => (a.design?.name ?? "").localeCompare(b.design?.name ?? "", "ru"));
  }, [prints, whFilter]);

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
                  {visibleWarehouses.map((w) => (
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
                    {visibleWarehouses.map((w) => {
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
