"use client";

import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pill } from "@/components/ui/pill";
import { ProductPicker } from "@/components/product-picker";
import { WarehouseSelect } from "@/components/warehouse-select";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Plus, ArrowLeftRight, ShoppingCart, Wrench, Settings, MinusCircle, Trash2 } from "lucide-react";
import type { Product, Inventory, ProductCategory, FabricType, Color, Size, Design, DecorationType, DesignType } from "@/lib/types";
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

interface BulkRow {
  id: string;
  colorId: string;
  decorationTypeId: string;
  designId: string;
  qty: Record<string, string>; // sizeId -> qty string
}

function newRow(): BulkRow {
  return { id: Math.random().toString(36).slice(2), colorId: "", decorationTypeId: "", designId: "", qty: {} };
}

function ReceiveDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const [blank, setBlank] = useState(true);
  const [warehouseId, setWarehouseId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [fabricId, setFabricId] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<BulkRow[]>([newRow()]);
  const [busy, setBusy] = useState(false);

  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [fabrics, setFabrics] = useState<FabricType[]>([]);
  const [colors, setColors] = useState<Color[]>([]);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [decorationTypes, setDecorationTypes] = useState<DecorationType[]>([]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const [c, f, col, s, d, dt, w] = await Promise.all([
        api.listCategories(),
        api.listFabrics(),
        api.listColors(),
        api.listSizes(),
        api.listDesigns(),
        api.listDecorationTypes(),
        api.listWarehouses(),
      ]);
      setCategories(c); setFabrics(f); setColors(col); setSizes(s); setDesigns(d); setDecorationTypes(dt);

      setWarehouseId((prev) => prev || w.find((x) => x.type === "own")?.id || w[0]?.id || "");
      setCategoryId((prev) => prev || c.find((x) => x.slug === "tshirt" || /^футболк/i.test(x.name))?.id || c[0]?.id || "");
      setFabricId((prev) => prev || f.find((x) => x.slug === "regular" || /^обычн/i.test(x.name))?.id || f[0]?.id || "");
    })();
  }, [open]);

  function reset() {
    setRows([newRow()]); setNotes(""); setCategoryId(""); setFabricId(""); setWarehouseId("");
  }

  function updateRow(i: number, patch: Partial<BulkRow>) {
    setRows((xs) => xs.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function updateRowQty(i: number, sizeId: string, val: string) {
    setRows((xs) => xs.map((x, idx) => (idx === i ? { ...x, qty: { ...x.qty, [sizeId]: val } } : x)));
  }
  function addRow() { setRows((xs) => [...xs, newRow()]); }
  function removeRow(i: number) { setRows((xs) => xs.filter((_, idx) => idx !== i)); }

  const totals = useMemo(() => {
    let units = 0, skus = 0;
    for (const r of rows) {
      for (const sid of Object.keys(r.qty)) {
        const n = parseInt(r.qty[sid] || "0", 10);
        if (n > 0) { units += n; skus += 1; }
      }
    }
    return { units, skus };
  }, [rows]);

  const canSubmit = warehouseId && categoryId && fabricId && totals.units > 0 &&
    rows.every((r) => {
      const anyQty = Object.values(r.qty).some((v) => parseInt(v || "0", 10) > 0);
      if (!anyQty) return true; // empty row OK
      if (!r.colorId) return false;
      if (!blank && (!r.decorationTypeId || !r.designId)) return false;
      return true;
    });

  async function submit() {
    if (!canSubmit) return toast.error("Заполните склад, тип, ткань и хотя бы одно количество");
    setBusy(true);
    try {
      // Собираем все задачи в плоский список — параллелим все приёмки
      const tasks: { colorId: string; sizeId: string; designId: string | null; decorationTypeId: string | null; qty: number }[] = [];
      for (const r of rows) {
        if (!r.colorId) continue;
        for (const [sizeId, vStr] of Object.entries(r.qty)) {
          const n = parseInt(vStr || "0", 10);
          if (n <= 0) continue;
          tasks.push({
            colorId: r.colorId,
            sizeId,
            designId: blank ? null : r.designId,
            decorationTypeId: blank ? null : r.decorationTypeId,
            qty: n,
          });
        }
      }

      const results = await Promise.all(
        tasks.map(async (t) => {
          const product = await api.findOrCreateProduct({
            category_id: categoryId,
            fabric_id: fabricId,
            color_id: t.colorId,
            size_id: t.sizeId,
            design_id: t.designId,
            decoration_type_id: t.decorationTypeId,
          });
          await api.receive({ productId: product.id, warehouseId, quantity: t.qty, notes });
          return t.qty;
        })
      );
      const count = results.reduce((s, n) => s + n, 0);
      toast.success(`Принято ${count} шт по ${tasks.length} SKU`);
      reset();
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Приёмка товара</DialogTitle>
          <DialogDescription>Сразу несколько цветов и размеров. Каждая ячейка с количеством → отдельный SKU.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Pill shape="square" active={blank} onClick={() => setBlank(true)}>Пустые</Pill>
            <Pill shape="square" active={!blank} onClick={() => setBlank(false)}>Готовые с дизайном</Pill>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Склад</Label>
              <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Тип</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger><SelectValue placeholder="Футболка / худи" /></SelectTrigger>
                <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Ткань</Label>
              <Select value={fabricId} onValueChange={setFabricId}>
                <SelectTrigger><SelectValue placeholder="Обычная / варёнка" /></SelectTrigger>
                <SelectContent>{fabrics.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            {rows.map((r, idx) => (
              <BulkRowEditor
                key={r.id}
                row={r}
                blank={blank}
                colors={colors}
                sizes={sizes}
                designs={designs}
                decorationTypes={decorationTypes}
                onChange={(p) => updateRow(idx, p)}
                onChangeQty={(sid, v) => updateRowQty(idx, sid, v)}
                onRemove={rows.length > 1 ? () => removeRow(idx) : undefined}
              />
            ))}
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="h-4 w-4" /> Ещё {blank ? "цвет" : "цвет / дизайн"}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Комментарий (необязательно)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Поставщик, накладная и т.д." />
          </div>
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {totals.units > 0 ? <>Итого: <span className="font-semibold text-foreground tabular-nums">{totals.units} шт</span> по {totals.skus} SKU</> : "Введите количества"}
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

function BulkRowEditor({
  row, blank, colors, sizes, designs, decorationTypes, onChange, onChangeQty, onRemove,
}: {
  row: BulkRow;
  blank: boolean;
  colors: Color[];
  sizes: Size[];
  designs: Design[];
  decorationTypes: DecorationType[];
  onChange: (p: Partial<BulkRow>) => void;
  onChangeQty: (sizeId: string, val: string) => void;
  onRemove?: () => void;
}) {
  const selectedDecoration = decorationTypes.find((d) => d.id === row.decorationTypeId);
  const designType: DesignType | null =
    selectedDecoration?.slug === "embroidery" ? "embroidery" :
    selectedDecoration?.slug === "print" ? "print" : null;
  const filteredDesigns = designType ? designs.filter((d) => d.type === designType) : designs;

  return (
    <div className="rounded-lg border p-3 bg-muted/20 space-y-3">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="space-y-1.5 flex-1 min-w-[150px]">
          <Label className="text-xs">Цвет</Label>
          <Select value={row.colorId} onValueChange={(v) => onChange({ colorId: v })}>
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {colors.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full border" style={{ backgroundColor: c.hex_code ?? "#999" }} />
                    {c.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!blank && (
          <>
            <div className="space-y-1.5 flex-1 min-w-[140px]">
              <Label className="text-xs">Украшение</Label>
              <Select value={row.decorationTypeId} onValueChange={(v) => onChange({ decorationTypeId: v, designId: "" })}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>{decorationTypes.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 flex-1 min-w-[160px]">
              <Label className="text-xs">Дизайн</Label>
              <Select value={row.designId} onValueChange={(v) => onChange({ designId: v })}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {filteredDesigns.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-2">Нет дизайнов</div>
                  ) : filteredDesigns.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        {onRemove && (
          <Button size="icon" variant="ghost" className="h-9 w-9" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div>
        <Label className="text-xs mb-1.5 block">Количество по размерам</Label>
        <div className="flex flex-wrap gap-2">
          {sizes.map((s) => (
            <label key={s.id} className="flex flex-col items-center gap-1">
              <span className="text-[11px] text-muted-foreground font-medium">{s.name}</span>
              <Input
                type="number"
                min="0"
                value={row.qty[s.id] ?? ""}
                onChange={(e) => onChangeQty(s.id, e.target.value)}
                className="h-9 w-16 text-center tabular-nums"
                placeholder="0"
              />
            </label>
          ))}
        </div>
      </div>
    </div>
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
  // Заготовка задаёт тип/ткань/цвет/размер. Готовое изделие — та же комбинация
  // плюс украшение, поэтому эти атрибуты выбираем один раз (у заготовки), а
  // финальный SKU выводим автоматически из заготовки + выбранного украшения.
  const [blank, setBlank] = useState<Product | null>(null);
  const [decorationTypeId, setDecorationTypeId] = useState("");
  const [designId, setDesignId] = useState("");
  const [finished, setFinished] = useState<Product | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [qty, setQty] = useState("1");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [printStock, setPrintStock] = useState<number | null>(null);

  const [decorationTypes, setDecorationTypes] = useState<DecorationType[]>([]);
  const [designs, setDesigns] = useState<Design[]>([]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const [dt, d, w] = await Promise.all([api.listDecorationTypes(), api.listDesigns(), api.listWarehouses()]);
      setDecorationTypes(dt); setDesigns(d);
      setWarehouseId((prev) => prev || w.find((x) => x.type === "own")?.id || w[0]?.id || "");
    })();
  }, [open]);

  // Готовое = заготовка (тип/ткань/цвет/размер) + украшение. Берём атрибуты из
  // выбранной заготовки, второй раз вводить их не нужно.
  useEffect(() => {
    if (!blank || !decorationTypeId || !designId) { setFinished(null); return; }
    let cancelled = false;
    api.findOrCreateProduct({
      category_id: blank.category_id,
      fabric_id: blank.fabric_id,
      color_id: blank.color_id,
      size_id: blank.size_id,
      design_id: designId,
      decoration_type_id: decorationTypeId,
    })
      .then((p) => { if (!cancelled) setFinished(p); })
      .catch((e) => { if (!cancelled) { setFinished(null); toast.error(errorMessage(e)); } });
    return () => { cancelled = true; };
  }, [blank, decorationTypeId, designId]);

  const selectedDecoration = decorationTypes.find((d) => d.id === decorationTypeId);
  const designType: DesignType | null =
    selectedDecoration?.slug === "embroidery" ? "embroidery" :
    selectedDecoration?.slug === "print" ? "print" : null;
  const filteredDesigns = designType ? designs.filter((d) => d.type === designType) : designs;

  const isPrint = finished?.decoration_type?.slug === "print" && !!finished?.design_id;

  useEffect(() => {
    if (!open || !isPrint || !finished?.design_id || !warehouseId) {
      setPrintStock(null);
      return;
    }
    api.getPrintInventoryFor(finished.design_id, warehouseId).then(setPrintStock).catch(() => setPrintStock(null));
  }, [open, isPrint, finished?.design_id, warehouseId]);

  const need = parseInt(qty || "0", 10);
  const printShortfall = isPrint && printStock != null && need > 0 && printStock < need;

  function reset() {
    setBlank(null); setDecorationTypeId(""); setDesignId(""); setFinished(null);
    setWarehouseId(""); setQty("1"); setNotes("");
  }

  async function submit() {
    if (!blank || !finished || !warehouseId || +qty <= 0) return toast.error("Выберите заготовку, украшение, склад и количество");
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
          <DialogTitle>Производство (нанесение принта)</DialogTitle>
          <DialogDescription>Превратить пустой товар в готовый. Тип, ткань, цвет и размер берутся у заготовки — выбираешь их один раз и добавляешь украшение.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-sm font-semibold">Заготовка (из чего)</div>
            <ProductPicker blankOnly withDefaults onChange={setBlank} />
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Нанести украшение</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Тип украшения</Label>
                <Select value={decorationTypeId} onValueChange={(v) => { setDecorationTypeId(v); setDesignId(""); }}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>{decorationTypes.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Дизайн</Label>
                <Select value={designId} onValueChange={setDesignId}>
                  <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {filteredDesigns.length === 0 ? (
                      <div className="text-xs text-muted-foreground p-2">Добавьте дизайн в разделе «Дизайны»</div>
                    ) : filteredDesigns.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {finished && (
            <div className="rounded-md border bg-muted/30 p-2.5 text-sm flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground shrink-0">Получится:</span>
              <ProductDisplay p={finished} compact />
            </div>
          )}

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
            {isPrint && printStock != null && (
              <div className={`text-sm rounded-md border p-2.5 ${printShortfall ? "border-red-300 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200" : "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200"}`}>
                Принт <span className="font-medium">{finished?.design?.name}</span> на этом складе: <span className="font-semibold tabular-nums">{printStock} шт</span>
                {printShortfall && <> · не хватает {need - printStock} шт для производства</>}
                {!printShortfall && need > 0 && <> · останется {printStock - need} после производства</>}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy || !finished || printShortfall}>{busy ? "..." : "Произвести"}</Button>
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
            <div className="space-y-1 text-sm text-muted-foreground">
              <ProductDisplay p={item.product} />
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
