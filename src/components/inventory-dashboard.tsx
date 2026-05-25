"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Inventory, PrintInventory, Product, Size, Warehouse } from "@/lib/types";
import {
  Package,
  Shirt,
  Image as ImageIcon,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

type WarehouseFilter = "all" | string;

/** Минимум на каждый (изделие × размер). Ниже — считается дефицитом. */
const MIN_STOCK = 2;

export function InventoryDashboard({
  inv,
  prints,
  warehouses,
  sizes,
  products,
  loading,
}: {
  inv: Inventory[];
  prints: PrintInventory[];
  warehouses: Warehouse[];
  sizes: Size[];
  products: Product[];
  loading: boolean;
}) {
  const [whFilter, setWhFilter] = useState<WarehouseFilter>("all");
  const [onlyShortage, setOnlyShortage] = useState(false);

  // ---- Сток по продукту с учётом фильтра склада
  const stockByProduct = useMemo(() => {
    const m = new Map<string, { total: number; byWh: Map<string, number> }>();
    for (const r of inv) {
      if (whFilter !== "all" && r.warehouse_id !== whFilter) continue;
      const e = m.get(r.product_id) ?? { total: 0, byWh: new Map() };
      e.total += r.quantity;
      e.byWh.set(r.warehouse_id, (e.byWh.get(r.warehouse_id) ?? 0) + r.quantity);
      m.set(r.product_id, e);
    }
    return m;
  }, [inv, whFilter]);

  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [sizes]
  );

  // ---- Строим матрицу из каталога продуктов (а не из инвентаря).
  // Это позволяет показать ячейки даже там, где остаток = 0.
  const { blankRows, finishedRows } = useMemo(() => {
    const groups = new Map<string, MatrixRow>();
    for (const p of products) {
      const isBlank = !!p.is_blank;
      // Готовые без offer_id (sku) скорее всего «внутренние» — пропускаем
      if (!isBlank && !p.sku) continue;

      const key = isBlank
        ? `b|${p.category_id}|${p.fabric_id}|${p.color_id}`
        : `f|${p.category_id}|${p.fabric_id}|${p.color_id}|${p.design_id}|${p.decoration_type_id}`;

      let row = groups.get(key);
      if (!row) {
        row = {
          key,
          isBlank,
          label: `${p.category?.name ?? ""} ${p.fabric?.name?.toLowerCase() ?? ""}`,
          subLabel: p.color?.name ?? "",
          hex: p.color?.hex_code ?? null,
          designLabel: isBlank ? null : `${p.decoration_type?.name ?? ""}: ${p.design?.name ?? ""}`,
          cells: {},
          total: 0,
          shortageCount: 0,
          missingCount: 0,
        };
        groups.set(key, row);
      }

      const stock = stockByProduct.get(p.id);
      const total = stock?.total ?? 0;
      const byWh = stock?.byWh ?? new Map();
      row.cells[p.size_id] = { qty: total, byWh, hasProduct: true };
      row.total += total;
      if (total < MIN_STOCK) row.shortageCount++;
      if (total === 0) row.missingCount++;
    }
    const all = Array.from(groups.values()).sort((a, b) => {
      const al = `${a.label} ${a.designLabel ?? ""} ${a.subLabel}`;
      const bl = `${b.label} ${b.designLabel ?? ""} ${b.subLabel}`;
      return al.localeCompare(bl, "ru");
    });
    return {
      blankRows: all.filter((r) => r.isBlank),
      finishedRows: all.filter((r) => !r.isBlank),
    };
  }, [products, stockByProduct]);

  // ---- KPI и сводка дефицита
  const stats = useMemo(() => {
    const sum = (rows: MatrixRow[]) =>
      rows.reduce(
        (a, r) => ({
          units: a.units + r.total,
          shortage: a.shortage + r.shortageCount,
          missing: a.missing + r.missingCount,
          rowsWithShortage: a.rowsWithShortage + (r.shortageCount > 0 ? 1 : 0),
        }),
        { units: 0, shortage: 0, missing: 0, rowsWithShortage: 0 }
      );
    const b = sum(blankRows);
    const f = sum(finishedRows);
    const printsFiltered = whFilter === "all" ? prints : prints.filter((p) => p.warehouse_id === whFilter);
    const printUnits = printsFiltered.reduce((s, p) => s + p.quantity, 0);
    const printDesigns = new Set(printsFiltered.map((p) => p.design_id)).size;
    return {
      blankUnits: b.units,
      blankShortage: b.shortage,
      blankMissing: b.missing,
      blankSkuCount: blankRows.reduce((s, r) => s + Object.keys(r.cells).length, 0),
      finishedUnits: f.units,
      finishedShortage: f.shortage,
      finishedMissing: f.missing,
      finishedSkuCount: finishedRows.reduce((s, r) => s + Object.keys(r.cells).length, 0),
      printUnits,
      printDesigns,
      totalUnits: b.units + f.units,
    };
  }, [blankRows, finishedRows, prints, whFilter]);

  const visibleBlankRows = useMemo(
    () => (onlyShortage ? blankRows.filter((r) => r.shortageCount > 0) : blankRows),
    [blankRows, onlyShortage]
  );
  const visibleFinishedRows = useMemo(
    () => (onlyShortage ? finishedRows.filter((r) => r.shortageCount > 0) : finishedRows),
    [finishedRows, onlyShortage]
  );

  if (loading) return <div className="p-10 text-center text-muted-foreground">Загрузка…</div>;

  const showBreakdownInCells = whFilter === "all" && warehouses.length > 1;
  const filterLabel = whFilter === "all" ? "все склады" : warehouses.find((w) => w.id === whFilter)?.name?.toLowerCase() ?? "—";

  return (
    <div className="space-y-5">
      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <Pill active={whFilter === "all"} onClick={() => setWhFilter("all")}>Все склады</Pill>
        {warehouses.map((w) => (
          <Pill key={w.id} active={whFilter === w.id} onClick={() => setWhFilter(w.id)}>
            <span className={cn("h-2 w-2 rounded-full", w.type === "own" ? "bg-emerald-500" : "bg-amber-500")} />
            {w.name}
          </Pill>
        ))}
        <div className="mx-2 h-5 w-px bg-border" />
        <Pill active={!onlyShortage} onClick={() => setOnlyShortage(false)}>Все позиции</Pill>
        <Pill active={onlyShortage} onClick={() => setOnlyShortage(true)}>
          <AlertTriangle className="h-3 w-3" /> Только дефициты
        </Pill>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Package} label="Единиц на складе" value={stats.totalUnits} sub={filterLabel} />
        <Kpi icon={Shirt} label="Пустых SKU" value={stats.blankSkuCount} sub={`${stats.blankUnits} ед`} />
        <Kpi icon={Package} label="Готовых SKU" value={stats.finishedSkuCount} sub={`${stats.finishedUnits} ед`} />
        <Kpi icon={ImageIcon} label="Принтов" value={stats.printUnits} sub={`${stats.printDesigns} дизайнов`} />
      </div>

      {/* Дефицит */}
      <ShortageCard
        minStock={MIN_STOCK}
        blank={{ shortage: stats.blankShortage, missing: stats.blankMissing }}
        finished={{ shortage: stats.finishedShortage, missing: stats.finishedMissing }}
        onShowOnly={() => setOnlyShortage(true)}
      />

      <MatrixCard
        title="Пустые по размерам"
        description={`Заготовки для нанесения принта или вышивки · ${filterLabel}`}
        icon={Shirt}
        sizes={sortedSizes}
        rows={visibleBlankRows}
        warehouses={warehouses}
        showBreakdown={showBreakdownInCells}
        emptyText={onlyShortage ? "Дефицита пустых нет" : "Пустых нет"}
      />

      <MatrixCard
        title="Готовые по размерам"
        description={`Готовая продукция с принтом или вышивкой (с offer_id на Ozon) · ${filterLabel}`}
        icon={Package}
        sizes={sortedSizes}
        rows={visibleFinishedRows}
        warehouses={warehouses}
        showBreakdown={showBreakdownInCells}
        emptyText={onlyShortage ? "Дефицита готовых нет" : "Готовых нет"}
      />

      <PrintsCard prints={prints} warehouses={warehouses} whFilter={whFilter} />
    </div>
  );
}

// ---------- subcomponents ----------

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

function ShortageCard({
  minStock,
  blank,
  finished,
  onShowOnly,
}: {
  minStock: number;
  blank: { shortage: number; missing: number };
  finished: { shortage: number; missing: number };
  onShowOnly: () => void;
}) {
  const total = blank.shortage + finished.shortage;
  const allGood = total === 0;

  if (allGood) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/20">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          <div className="text-sm">
            <span className="font-semibold text-emerald-900 dark:text-emerald-200">Всё в норме</span>
            <span className="text-muted-foreground"> · на каждый размер каждого изделия ≥ {minStock} шт</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-200 bg-amber-50/40 dark:bg-amber-950/20">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <AlertTriangle className="h-5 w-5 text-amber-700 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Дефицит: {total} позиций ниже минимума ({minStock} шт)
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5">
                <span>Пустые: <span className="font-medium text-foreground">{blank.shortage}</span> ниже минимума {blank.missing > 0 && <span className="text-red-700">· из них {blank.missing} = 0</span>}</span>
                <span>Готовые: <span className="font-medium text-foreground">{finished.shortage}</span> ниже минимума {finished.missing > 0 && <span className="text-red-700">· из них {finished.missing} = 0</span>}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onShowOnly}
            className="text-xs font-medium underline underline-offset-2 hover:text-foreground text-amber-900 dark:text-amber-200"
          >
            Показать только дефициты →
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

interface MatrixCell {
  qty: number;
  byWh: Map<string, number>;
  hasProduct: boolean;
}
interface MatrixRow {
  key: string;
  isBlank: boolean;
  label: string;
  subLabel: string;
  hex: string | null;
  designLabel: string | null;
  cells: Record<string, MatrixCell>;
  total: number;
  shortageCount: number;
  missingCount: number;
}

function MatrixCard({
  title,
  description,
  icon: Icon,
  sizes,
  rows,
  warehouses,
  showBreakdown,
  emptyText,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  sizes: Size[];
  rows: MatrixRow[];
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
        {rows.length === 0 ? (
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
                  <th className="font-medium pb-2 pl-3 text-right w-16">⚠</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
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
                    <td className="py-1.5 pl-3 text-right">
                      {g.shortageCount > 0 ? (
                        <Badge className={cn("text-[10px] h-5 px-1.5",
                          g.missingCount > 0
                            ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                            : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200")}>
                          {g.shortageCount}
                        </Badge>
                      ) : <span className="text-emerald-600 text-xs">✓</span>}
                    </td>
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
  return (name?.trim().charAt(0) || "").toUpperCase();
}

function Cell({ cell, warehouses, showBreakdown }: { cell?: MatrixCell; warehouses: Warehouse[]; showBreakdown: boolean }) {
  if (!cell?.hasProduct) {
    // нет такого SKU в каталоге — пустая ячейка
    return <td className="px-1 py-1.5 text-center align-top text-muted-foreground/30">—</td>;
  }
  const qty = cell.qty;
  const cls =
    qty === 0
      ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
      : qty < MIN_STOCK
      ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
      : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200";

  const breakdownEntries = Array.from(cell.byWh.entries())
    .filter(([, q]) => q > 0)
    .map(([wid, q]) => ({ wh: warehouses.find((w) => w.id === wid), q }));
  const tooltip = breakdownEntries.length > 0
    ? breakdownEntries.map(({ wh, q }) => `${wh?.name ?? "?"}: ${q}`).join(" · ")
    : "нет на складе";
  const showSplit = showBreakdown && breakdownEntries.length > 1;

  return (
    <td className="px-1 py-1.5 text-center align-top">
      <div className={cn("inline-flex flex-col items-center justify-center min-w-[2.25rem] rounded px-1.5 py-0.5", cls)} title={tooltip}>
        <div className="text-sm tabular-nums leading-tight">{qty}</div>
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
    () => (whFilter === "all" ? warehouses : warehouses.filter((w) => w.id === whFilter)),
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
