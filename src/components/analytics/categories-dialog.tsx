"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2, Archive, ArchiveRestore, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { ExpenseCategory } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const PRESET_COLORS = [
  "#10b981", "#22c55e", "#84cc16", "#eab308", "#f59e0b",
  "#f97316", "#ef4444", "#ec4899", "#a855f7", "#6366f1",
  "#3b82f6", "#06b6d4", "#14b8a6", "#64748b", "#475569",
];

export function CategoriesDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}) {
  const [cats, setCats] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PRESET_COLORS[0]);

  async function reload() {
    setLoading(true);
    try {
      setCats(await api.listExpenseCategories({ includeArchived: true }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) reload();
  }, [open]);

  async function add() {
    if (!name.trim()) return;
    try {
      await api.createExpenseCategory({ name: name.trim(), color, sort_order: cats.length });
      setName("");
      await reload();
      onDone?.();
      toast.success("Категория добавлена");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function rename(c: ExpenseCategory, next: string) {
    if (!next.trim() || next === c.name) return;
    try {
      await api.updateExpenseCategory(c.id, { name: next.trim() });
      await reload();
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function changeColor(c: ExpenseCategory, hex: string) {
    try {
      await api.updateExpenseCategory(c.id, { color: hex });
      await reload();
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function toggleArchived(c: ExpenseCategory) {
    try {
      await api.updateExpenseCategory(c.id, { archived: !c.archived });
      await reload();
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(c: ExpenseCategory) {
    if (!confirm(`Удалить категорию «${c.name}»? Связанные расходы останутся без категории.`)) return;
    try {
      await api.deleteExpenseCategory(c.id);
      await reload();
      onDone?.();
      toast.success("Удалено");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Категории расходов</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <ColorPicker value={color} onChange={setColor} />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название категории" onKeyDown={(e) => e.key === "Enter" && add()} />
          <Button onClick={add} disabled={!name.trim()}><Plus className="h-4 w-4" /> Добавить</Button>
        </div>

        <div className="border rounded-md divide-y">
          {loading && <div className="p-4 text-sm text-muted-foreground text-center">Загрузка…</div>}
          {!loading && cats.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground text-center">Категорий пока нет</div>
          )}
          {cats.map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-2">
              <ColorPicker value={c.color || "#94a3b8"} onChange={(v) => changeColor(c, v)} />
              <InlineRename value={c.name} onSave={(v) => rename(c, v)} archived={c.archived} />
              {c.archived && <span className="text-[10px] text-muted-foreground uppercase">архив</span>}
              <div className="ml-auto flex gap-1">
                <Button variant="ghost" size="icon" onClick={() => toggleArchived(c)} title={c.archived ? "Вернуть из архива" : "Архивировать"}>
                  {c.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => remove(c)} title="Удалить">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Готово</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-8 rounded border shrink-0"
        style={{ background: value }}
        aria-label="Цвет"
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 bg-popover border rounded-md shadow-md p-2 grid grid-cols-5 gap-1">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { onChange(c); setOpen(false); }}
                className="h-6 w-6 rounded border"
                style={{ background: c }}
                aria-label={c}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function InlineRename({ value, onSave, archived }: { value: string; onSave: (v: string) => void; archived: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(value);
      }}
      className={`h-8 ${archived ? "text-muted-foreground line-through" : ""}`}
    />
  );
}
