"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { Expense, ExpenseCategory } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export function ExpenseDialog({
  open,
  onOpenChange,
  expense,
  categories,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  expense?: Expense | null;
  categories: ExpenseCategory[];
  onDone?: () => void;
}) {
  const editing = !!expense;
  const [categoryId, setCategoryId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [occurredAt, setOccurredAt] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCategoryId(expense?.category_id ?? categories[0]?.id ?? "");
    setAmount(expense ? String(expense.amount) : "");
    setOccurredAt(expense?.occurred_at ?? new Date().toISOString().slice(0, 10));
    setDescription(expense?.description ?? "");
  }, [open, expense, categories]);

  const valid = Number(amount) > 0 && !!occurredAt;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      if (editing && expense) {
        await api.updateExpense(expense.id, {
          categoryId: categoryId || null,
          amount: Number(amount),
          occurredAt,
          description: description || null,
        });
        toast.success("Расход обновлён");
      } else {
        await api.createExpense({
          categoryId: categoryId || null,
          amount: Number(amount),
          occurredAt,
          description: description || null,
        });
        toast.success("Расход добавлен");
      }
      onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Редактировать расход" : "Добавить расход"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Сумма, ₽</Label>
              <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <Label>Дата</Label>
              <Input type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Категория</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue placeholder={categories.length ? "Выбрать" : "Сначала добавьте категорию"} />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.color || "hsl(0 0% 60%)" }} />
                      {c.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Комментарий</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Опционально" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={!valid || busy}>{busy ? "..." : editing ? "Сохранить" : "Добавить"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
