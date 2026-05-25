"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WarehouseSelect } from "@/components/warehouse-select";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Plus, Settings, MinusCircle, Image as ImageIcon } from "lucide-react";
import { errorMessage } from "@/lib/utils";
import type { Design, PrintInventory } from "@/lib/types";

export function PrintInventoryActions({ onChange }: { onChange?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Приёмка принтов
      </Button>
      <ReceivePrintDialog open={open} onOpenChange={setOpen} onDone={onChange} />
    </div>
  );
}

function ReceivePrintDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const [warehouseId, setWarehouseId] = useState("");
  const [notes, setNotes] = useState("");
  const [qtyByDesign, setQtyByDesign] = useState<Record<string, string>>({});
  const [designs, setDesigns] = useState<Design[]>([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    (async () => {
      const [d, ws] = await Promise.all([
        api.listDesigns({ type: "print" }),
        api.listWarehouses(),
      ]);
      setDesigns(d);
      // Принты хранятся только на своём складе — цех вышивки в селекторе скрыт.
      setWarehouseId((prev) => prev || ws.find((w) => w.type === "own")?.id || "");
    })();
  }, [open]);

  function reset() { setNotes(""); setQtyByDesign({}); setSearch(""); }

  const totals = useMemo(() => {
    let units = 0, designsCount = 0;
    for (const k of Object.keys(qtyByDesign)) {
      const n = parseInt(qtyByDesign[k] || "0", 10);
      if (n > 0) { units += n; designsCount += 1; }
    }
    return { units, designsCount };
  }, [qtyByDesign]);

  const filtered = useMemo(() => {
    if (!search) return designs;
    const q = search.toLowerCase();
    return designs.filter((d) => `${d.name} ${d.description ?? ""}`.toLowerCase().includes(q));
  }, [designs, search]);

  const canSubmit = !!warehouseId && totals.units > 0;

  async function submit() {
    if (!canSubmit) return toast.error("Выберите склад и введите хотя бы одно количество");
    setBusy(true);
    try {
      let total = 0;
      for (const [designId, vStr] of Object.entries(qtyByDesign)) {
        const n = parseInt(vStr || "0", 10);
        if (!n) continue;
        await api.receivePrint({ designId, warehouseId, quantity: n, notes });
        total += n;
      }
      toast.success(`Принято ${total} принтов · ${totals.designsCount} дизайнов`);
      reset();
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Приёмка принтов</DialogTitle>
          <DialogDescription>Поступление готовых принтов на склад. Введите количество только тем дизайнам, которые пришли.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Склад</Label>
              <WarehouseSelect value={warehouseId} onChange={setWarehouseId} filterType="own" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Комментарий (необязательно)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Поставщик, накладная…" />
            </div>
          </div>

          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по дизайну…" />

          <div className="max-h-[50vh] overflow-y-auto -mx-2 px-2">
            {filtered.length === 0 ? (
              <div className="text-sm text-muted-foreground p-4 text-center">Нет принт-дизайнов. Добавь их в разделе «Дизайны».</div>
            ) : (
              <div className="grid gap-1.5">
                {filtered.map((d) => {
                  const v = qtyByDesign[d.id] ?? "";
                  return (
                    <div key={d.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/30 border">
                      {d.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.image_url} alt={d.name} className="h-10 w-10 rounded object-cover border shrink-0" />
                      ) : (
                        <div className="h-10 w-10 rounded border bg-muted flex items-center justify-center shrink-0">
                          <ImageIcon className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{d.name}</div>
                        {d.description && <div className="text-xs text-muted-foreground truncate">{d.description}</div>}
                      </div>
                      <Input
                        type="number"
                        min="0"
                        value={v}
                        onChange={(e) => setQtyByDesign((m) => ({ ...m, [d.id]: e.target.value }))}
                        className="h-9 w-20 text-center tabular-nums"
                        placeholder="0"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {totals.units > 0 ? <>Итого: <span className="font-semibold text-foreground tabular-nums">{totals.units} шт</span> по {totals.designsCount} дизайнам</> : "Введите количества"}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
            <Button onClick={submit} disabled={busy || !canSubmit}>{busy ? "..." : "Принять"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdjustPrintInline({ item, onDone }: { item: PrintInventory; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const n = parseInt(delta);
    if (!n) return toast.error("Введите число (отрицательное или положительное)");
    setBusy(true);
    try {
      await api.adjustPrint({ designId: item.design_id, warehouseId: item.warehouse_id, delta: n, notes });
      toast.success("Корректировка применена");
      setDelta(""); setNotes(""); setOpen(false);
      onDone?.();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function writeoff(amount: number) {
    setBusy(true);
    try {
      await api.writeoffPrint({ designId: item.design_id, warehouseId: item.warehouse_id, quantity: amount, notes: "брак" });
      toast.success(`Списано ${amount} шт`);
      setOpen(false);
      onDone?.();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Settings className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Корректировка остатка</DialogTitle>
            <div className="space-y-1 text-sm text-muted-foreground">
              <div className="font-medium text-foreground">{item.design?.name}</div>
              <div>Склад «{item.warehouse?.name}» · сейчас {item.quantity} шт</div>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Изменение количества (+/−)</Label>
              <Input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="Например: -2 или +5" />
            </div>
            <div className="space-y-1.5">
              <Label>Причина</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Пересчёт, ошибка учёта…" />
            </div>
            <div className="flex items-center gap-2 pt-2 border-t">
              <span className="text-sm text-muted-foreground">Быстрое списание брака:</span>
              <Button size="sm" variant="outline" onClick={() => writeoff(1)} disabled={item.quantity < 1}>
                <MinusCircle className="h-3.5 w-3.5" /> 1
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Закрыть</Button>
            <Button onClick={submit} disabled={busy}>{busy ? "..." : "Применить"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
