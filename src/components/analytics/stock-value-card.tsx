"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Warehouse as WarehouseIcon } from "lucide-react";
import type { Warehouse } from "@/lib/types";
import { emptyStockValueBucket, type StockValueSummary } from "@/lib/analytics-stock";
import { cn, formatMoney } from "@/lib/utils";

export function StockValueCard({
  summary,
  warehouses,
  loading,
}: {
  summary: StockValueSummary;
  warehouses: Warehouse[];
  loading: boolean;
}) {
  const { perWarehouse, total } = summary;

  const totalValue = total.blankValue + total.finishedValue;
  const totalQty = total.blankQty + total.finishedQty;

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <WarehouseIcon className="h-4 w-4 text-muted-foreground" />
            Стоимость остатков
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-24 animate-pulse rounded bg-muted/50" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <WarehouseIcon className="h-4 w-4 text-muted-foreground" />
            Стоимость остатков
          </CardTitle>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums tracking-tight">{formatMoney(totalValue)}</div>
            <div className="text-xs text-muted-foreground">{totalQty} шт всего</div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Стоимость заготовок и готовых изделий по складам в закупочных ценах
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        {warehouses.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">Складов нет</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="text-left font-medium pb-2 pr-3">Склад</th>
                  <th className="text-right font-medium pb-2 px-3">Пустые</th>
                  <th className="text-right font-medium pb-2 px-3">Готовые</th>
                  <th className="text-right font-medium pb-2 pl-3">Всего</th>
                </tr>
              </thead>
              <tbody>
                {warehouses.map((w) => {
                  const b = perWarehouse[w.id] ?? emptyStockValueBucket();
                  const whTotal = b.blankValue + b.finishedValue;
                  const whQty = b.blankQty + b.finishedQty;
                  return (
                    <tr key={w.id} className="border-t">
                      <td className="py-2 pr-3">
                        <div className="inline-flex items-center gap-2">
                          <span className={cn("h-2 w-2 rounded-full", w.type === "own" ? "bg-emerald-500" : "bg-amber-500")} />
                          <span className="font-medium">{w.name}</span>
                          <span className="text-[11px] text-muted-foreground">{w.type === "own" ? "свой" : "цех"}</span>
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        <div>{formatMoney(b.blankValue)}</div>
                        <div className="text-[11px] text-muted-foreground">{b.blankQty} шт</div>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        <div>{formatMoney(b.finishedValue)}</div>
                        <div className="text-[11px] text-muted-foreground">{b.finishedQty} шт</div>
                      </td>
                      <td className="py-2 pl-3 text-right tabular-nums font-semibold">
                        <div>{formatMoney(whTotal)}</div>
                        <div className="text-[11px] text-muted-foreground font-normal">{whQty} шт</div>
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t bg-muted/30">
                  <td className="py-2 pr-3 font-semibold">Итого</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">
                    <div>{formatMoney(total.blankValue)}</div>
                    <div className="text-[11px] text-muted-foreground font-normal">{total.blankQty} шт</div>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">
                    <div>{formatMoney(total.finishedValue)}</div>
                    <div className="text-[11px] text-muted-foreground font-normal">{total.finishedQty} шт</div>
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums font-bold">
                    <div>{formatMoney(totalValue)}</div>
                    <div className="text-[11px] text-muted-foreground font-normal">{totalQty} шт</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
