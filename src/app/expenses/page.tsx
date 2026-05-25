"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Wallet, Tag } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { ExpenseDialog } from "@/components/analytics/expense-dialog";
import { CategoriesDialog } from "@/components/analytics/categories-dialog";
import { api } from "@/lib/api";
import type { Expense, ExpenseCategory } from "@/lib/types";
import { errorMessage, formatMoney } from "@/lib/utils";
import { isoDate, presetRange, formatDateRange, type PeriodFilter } from "@/lib/analytics";

type PresetKey = "7d" | "30d" | "90d" | "mtd" | "ytd" | "all";

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "7d", label: "7 дн" },
  { key: "30d", label: "30 дн" },
  { key: "90d", label: "90 дн" },
  { key: "mtd", label: "Месяц" },
  { key: "ytd", label: "Год" },
  { key: "all", label: "Всё" },
];

export default function ExpensesPage() {
  const [items, setItems] = useState<Expense[]>([]);
  const [cats, setCats] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<PresetKey>("30d");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [openCreate, setOpenCreate] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [openCats, setOpenCats] = useState(false);

  const periodFilter: PeriodFilter | null = useMemo(() => {
    if (preset === "all") return null;
    return presetRange(preset);
  }, [preset]);

  async function reload() {
    setLoading(true);
    try {
      const filters: { from?: string; to?: string; categoryId?: string } = {};
      if (periodFilter) {
        filters.from = isoDate(periodFilter.from);
        const lastDay = new Date(periodFilter.to.getTime() - 86400000);
        filters.to = isoDate(lastDay);
      }
      if (categoryId !== "all") filters.categoryId = categoryId;
      const [exp, c] = await Promise.all([api.listExpenses(filters), api.listExpenseCategories()]);
      setItems(exp);
      setCats(c);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [preset, categoryId]);

  const total = useMemo(() => items.reduce((s, e) => s + Number(e.amount), 0), [items]);

  async function remove(e: Expense) {
    if (!confirm("Удалить расход?")) return;
    try {
      await api.deleteExpense(e.id);
      toast.success("Удалено");
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div>
      <PageHeader
        title="Расходы"
        description="Налоги, аренда, услуги, материалы и всё, что не учитывается в Ozon"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpenCats(true)}>
              <Tag className="h-4 w-4" /> Категории
            </Button>
            <Button onClick={() => { setEditing(null); setOpenCreate(true); }}>
              <Plus className="h-4 w-4" /> Расход
            </Button>
          </div>
        }
      />

      <Card className="mb-4">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">Период:</span>
            {PRESETS.map((p) => (
              <Pill key={p.key} active={preset === p.key} onClick={() => setPreset(p.key)}>{p.label}</Pill>
            ))}
            {periodFilter && (
              <span className="text-xs text-muted-foreground ml-2">{formatDateRange(periodFilter)}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">Категория:</span>
            <Pill active={categoryId === "all"} onClick={() => setCategoryId("all")}>Все</Pill>
            {cats.map((c) => (
              <Pill key={c.id} active={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
                <span className="h-2 w-2 rounded-sm" style={{ background: c.color || "hsl(0 0% 60%)" }} />
                {c.name}
              </Pill>
            ))}
          </div>
          <div className="flex items-baseline gap-3 pt-1">
            <span className="text-xs text-muted-foreground">Итого за период:</span>
            <span className="text-xl font-semibold tabular-nums">{formatMoney(total)}</span>
            <span className="text-xs text-muted-foreground">· {items.length} записей</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center text-muted-foreground">Загрузка…</div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="Расходов пока нет"
              description={cats.length === 0 ? "Сначала добавьте хотя бы одну категорию через кнопку «Категории»" : "Добавьте первый расход, чтобы он появился в аналитике"}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Дата</TableHead>
                  <TableHead>Категория</TableHead>
                  <TableHead>Комментарий</TableHead>
                  <TableHead className="text-right">Сумма</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(e.occurred_at).toLocaleDateString("ru-RU")}
                    </TableCell>
                    <TableCell>
                      {e.category ? (
                        <span className="inline-flex items-center gap-2 text-sm">
                          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: e.category.color || "hsl(0 0% 60%)" }} />
                          {e.category.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Без категории</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[400px] truncate">{e.description ?? "—"}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatMoney(e.amount)}</TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex">
                        <Button variant="ghost" size="icon" onClick={() => { setEditing(e); setOpenCreate(true); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => remove(e)}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ExpenseDialog
        open={openCreate}
        onOpenChange={(v) => { setOpenCreate(v); if (!v) setEditing(null); }}
        expense={editing}
        categories={cats}
        onDone={reload}
      />
      <CategoriesDialog open={openCats} onOpenChange={setOpenCats} onDone={reload} />
    </div>
  );
}
