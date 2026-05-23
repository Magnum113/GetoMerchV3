"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ProductPicker } from "@/components/product-picker";
import { WarehouseSelect } from "@/components/warehouse-select";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Plus, ArrowLeftRight, ShoppingCart, Wrench, Settings, MinusCircle } from "lucide-react";
import type { Product, Inventory } from "@/lib/types";
import { ProductDisplay } from "@/components/product-display";

export function InventoryActions({ onChange }: { onChange?: () => void }) {
  const [openReceive, setOpenReceive] = useState(false);
  const [openTransfer, setOpenTransfer] = useState(false);
  const [openSale, setOpenSale] = useState(false);
  const [openProduce, setOpenProduce] = useState(false);

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setOpenReceive(true)}>
        <Plus className="h-4 w-4" /> Приёмка
      </Button>
      <Button variant="outline" onClick={() => setOpenTransfer(true)}>
        <ArrowLeftRight className="h-4 w-4" /> Переместить
      </Button>
      <Button variant="outline" onClick={() => setOpenProduce(true)}>
        <Wrench className="h-4 w-4" /> Произвести
      </Button>
      <Button variant="outline" onClick={() => setOpenSale(true)}>
        <ShoppingCart className="h-4 w-4" /> Продажа
      </Button>

      <ReceiveDialog open={openReceive} onOpenChange={setOpenReceive} onDone={onChange} />
      <TransferDialog open={openTransfer} onOpenChange={setOpenTransfer} onDone={onChange} />
      <ProduceDialog open={openProduce} onOpenChange={setOpenProduce} onDone={onChange} />
      <SaleDialog open={openSale} onOpenChange={setOpenSale} onDone={onChange} />
    </div>
  );
}

function ReceiveDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [qty, setQty] = useState("1");
  const [notes, setNotes] = useState("");
  const [blank, setBlank] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!product || !warehouseId || +qty <= 0) return toast.error("Заполните все поля");
    setBusy(true);
    try {
      await api.receive({ productId: product.id, warehouseId, quantity: +qty, notes });
      toast.success(`Принято ${qty} шт`);
      setProduct(null); setQty("1"); setNotes("");
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Приёмка товара</DialogTitle>
          <DialogDescription>Поступление новых пустых или готовых товаров на склад</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2 text-sm">
            <button type="button" onClick={() => setBlank(true)} className={`px-3 py-1.5 rounded-md border ${blank ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}>Пустые</button>
            <button type="button" onClick={() => setBlank(false)} className={`px-3 py-1.5 rounded-md border ${!blank ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}>Готовые с дизайном</button>
          </div>

          <ProductPicker blankOnly={blank} finishedOnly={!blank} onChange={setProduct} />

          <div className="space-y-1.5">
            <Label>Склад поступления</Label>
            <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
          </div>

          <div className="space-y-1.5">
            <Label>Количество</Label>
            <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Комментарий</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Источник, поставщик и т.д." />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Принять"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [qty, setQty] = useState("1");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!product || !fromId || !toId || +qty <= 0) return toast.error("Заполните все поля");
    if (fromId === toId) return toast.error("Склады должны различаться");
    setBusy(true);
    try {
      await api.transfer({ productId: product.id, fromWarehouseId: fromId, toWarehouseId: toId, quantity: +qty, notes });
      toast.success(`Перемещено ${qty} шт`);
      setProduct(null); setQty("1"); setNotes("");
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Перемещение между складами</DialogTitle>
          <DialogDescription>Например, отправка в цех или возврат из цеха</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ProductPicker onChange={setProduct} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Откуда</Label>
              <WarehouseSelect value={fromId} onChange={setFromId} />
            </div>
            <div className="space-y-1.5">
              <Label>Куда</Label>
              <WarehouseSelect value={toId} onChange={setToId} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Количество</Label>
            <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Комментарий</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Переместить"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SaleDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [qty, setQty] = useState("1");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!product || !warehouseId || +qty <= 0) return toast.error("Заполните все поля");
    setBusy(true);
    try {
      await api.sale({ productId: product.id, warehouseId, quantity: +qty, notes });
      toast.success(`Списано ${qty} шт`);
      setProduct(null); setQty("1"); setNotes("");
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Продажа</DialogTitle>
          <DialogDescription>Списание готового товара со склада</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ProductPicker finishedOnly onChange={setProduct} />
          <div className="space-y-1.5">
            <Label>Склад</Label>
            <WarehouseSelect value={warehouseId} onChange={setWarehouseId} filterType="own" />
          </div>
          <div className="space-y-1.5">
            <Label>Количество</Label>
            <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Комментарий</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Покупатель, канал и т.д." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Продать"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProduceDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const [blank, setBlank] = useState<Product | null>(null);
  const [finished, setFinished] = useState<Product | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [qty, setQty] = useState("1");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!blank || !finished || !warehouseId || +qty <= 0) return toast.error("Заполните все поля");
    setBusy(true);
    try {
      await api.produce({
        blankProductId: blank.id,
        finishedProductId: finished.id,
        warehouseId,
        quantity: +qty,
        notes,
      });
      toast.success(`Произведено ${qty} шт`);
      setBlank(null); setFinished(null); setQty("1"); setNotes("");
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Производство (нанесение принта)</DialogTitle>
          <DialogDescription>Превратить пустой товар в готовый. Используется для принтов, которые делаешь сам.</DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="text-sm font-semibold">Из чего (пустой)</div>
            <ProductPicker blankOnly onChange={setBlank} />
          </div>
          <div className="space-y-2">
            <div className="text-sm font-semibold">Что получится (готовый)</div>
            <ProductPicker finishedOnly onChange={setFinished} />
          </div>
        </div>
        <div className="space-y-4 pt-4 border-t">
          <div className="space-y-1.5">
            <Label>Склад производства</Label>
            <WarehouseSelect value={warehouseId} onChange={setWarehouseId} filterType="own" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Количество</Label>
              <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Комментарий</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Произвести"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Inline adjust on existing inventory row
export function AdjustInline({ item, onDone }: { item: Inventory; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const n = parseInt(delta);
    if (!n) return toast.error("Введите число (отрицательное или положительное)");
    setBusy(true);
    try {
      await api.adjust({ productId: item.product_id, warehouseId: item.warehouse_id, delta: n, notes });
      toast.success("Корректировка применена");
      setDelta(""); setNotes(""); setOpen(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  async function writeoff(amount: number) {
    setBusy(true);
    try {
      await api.writeoff({ productId: item.product_id, warehouseId: item.warehouse_id, quantity: amount, notes: "брак" });
      toast.success(`Списано ${amount} шт`);
      setOpen(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
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
            <DialogDescription>
              <ProductDisplay p={item.product} /> · склад «{item.warehouse?.name}» · сейчас {item.quantity} шт
            </DialogDescription>
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
