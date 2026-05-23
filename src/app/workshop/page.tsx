"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { ProductPicker } from "@/components/product-picker";
import { WarehouseSelect } from "@/components/warehouse-select";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { WorkshopOrder, WorkshopOrderStatus, Product, Design, DecorationType, Warehouse } from "@/lib/types";
import { WORKSHOP_STATUS_LABELS, WORKSHOP_STATUS_COLORS } from "@/lib/types";
import { Hammer, Plus, Send, CheckCircle2, X, ArrowRight, Trash2 } from "lucide-react";
import { formatDate, errorMessage } from "@/lib/utils";

const FLOW: WorkshopOrderStatus[] = ["pending", "sent", "in_progress", "ready", "received"];

export default function WorkshopPage() {
  const [orders, setOrders] = useState<WorkshopOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);

  async function reload() {
    setLoading(true);
    const [o, w] = await Promise.all([api.listWorkshopOrders(), api.listWarehouses()]);
    setOrders(o);
    setWarehouses(w);
    setLoading(false);
  }
  useEffect(() => { reload(); }, []);

  const ownWarehouse = warehouses.find((w) => w.type === "own");

  return (
    <div>
      <PageHeader
        title="Заказы в цех"
        description="Отправка пустых товаров на вышивку. При получении автоматически создаются готовые SKU и переводятся к тебе на склад"
        action={<Button onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4" /> Новый заказ</Button>}
      />

      {loading ? (
        <div className="p-10 text-center text-muted-foreground">Загрузка…</div>
      ) : orders.length === 0 ? (
        <Card><CardContent>
          <EmptyState
            icon={Hammer}
            title="Заказов в цех ещё нет"
            description="Создай первый заказ — выбери цех, дизайн и список пустых товаров. Система автоматически переместит их в цех."
            action={<Button onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4" /> Новый заказ</Button>}
          />
        </CardContent></Card>
      ) : (
        <div className="grid gap-4">
          {orders.map((o) => <OrderCard key={o.id} order={o} ownWarehouseId={ownWarehouse?.id ?? null} onChange={reload} />)}
        </div>
      )}

      <CreateOrderDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        onDone={reload}
        defaultWorkshopId={warehouses.find((w) => w.type === "workshop")?.id ?? ""}
      />
    </div>
  );
}

function OrderCard({ order, ownWarehouseId, onChange }: { order: WorkshopOrder; ownWarehouseId: string | null; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  async function moveTo(status: WorkshopOrderStatus) {
    setBusy(true);
    try {
      await api.updateWorkshopOrderStatus(order.id, status, { ownWarehouseId: ownWarehouseId ?? undefined });
      toast.success(`Статус: ${WORKSHOP_STATUS_LABELS[status]}`);
      onChange();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  const idx = FLOW.indexOf(order.status);
  const next = idx >= 0 && idx < FLOW.length - 1 ? FLOW[idx + 1] : null;
  const canCancel = ["pending", "sent"].includes(order.status);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base font-mono">{order.order_number}</CardTitle>
              <Badge className={WORKSHOP_STATUS_COLORS[order.status]}>{WORKSHOP_STATUS_LABELS[order.status]}</Badge>
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              Цех: <span className="font-medium text-foreground">{order.workshop?.name}</span> · создан {formatDate(order.created_at)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {next && (
              <Button size="sm" onClick={() => moveTo(next)} disabled={busy}>
                {next === "sent" && <><Send className="h-3.5 w-3.5" /> Отправить</>}
                {next === "in_progress" && <><ArrowRight className="h-3.5 w-3.5" /> В работу</>}
                {next === "ready" && <><CheckCircle2 className="h-3.5 w-3.5" /> Готово</>}
                {next === "received" && <><CheckCircle2 className="h-3.5 w-3.5" /> Получено</>}
              </Button>
            )}
            {canCancel && (
              <Button size="sm" variant="ghost" onClick={() => moveTo("cancelled")} disabled={busy}>
                <X className="h-3.5 w-3.5" /> Отмена
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="rounded-md border bg-muted/30">
          {order.items?.map((it, idx) => (
            <div key={it.id} className={`flex items-center justify-between gap-3 p-3 ${idx > 0 ? "border-t" : ""}`}>
              <div className="flex-1 min-w-0">
                <ProductDisplay p={it.blank_product} compact />
                <div className="text-xs text-muted-foreground mt-1">
                  → {it.decoration_type?.name}: <span className="font-medium text-foreground">{it.design?.name}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-semibold tabular-nums">{it.quantity} шт</div>
              </div>
            </div>
          ))}
        </div>
        {order.notes && (
          <div className="text-xs text-muted-foreground mt-3 p-2 bg-muted/30 rounded">
            {order.notes}
          </div>
        )}
        <div className="flex gap-4 text-xs text-muted-foreground mt-3">
          {order.sent_at && <span>Отправлен: {formatDate(order.sent_at)}</span>}
          {order.completed_at && <span>Готов: {formatDate(order.completed_at)}</span>}
          {order.received_at && <span>Получен: {formatDate(order.received_at)}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

interface ItemDraft {
  blank: Product | null;
  designId: string;
  decorationTypeId: string;
  quantity: string;
  notes: string;
}

function CreateOrderDialog({ open, onOpenChange, onDone, defaultWorkshopId }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void; defaultWorkshopId: string }) {
  const [workshopId, setWorkshopId] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([{ blank: null, designId: "", decorationTypeId: "", quantity: "1", notes: "" }]);
  const [busy, setBusy] = useState(false);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [decorationTypes, setDecorationTypes] = useState<DecorationType[]>([]);

  useEffect(() => {
    if (open) {
      setWorkshopId(defaultWorkshopId);
      api.listDesigns({ type: "embroidery" }).then(setDesigns);
      api.listDecorationTypes().then((dts) => setDecorationTypes(dts.filter((d) => d.made_at === "workshop")));
    }
  }, [open, defaultWorkshopId]);

  function update(i: number, patch: Partial<ItemDraft>) {
    setItems((xs) => xs.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function addItem() {
    setItems((xs) => [...xs, { blank: null, designId: "", decorationTypeId: "", quantity: "1", notes: "" }]);
  }
  function removeItem(i: number) {
    setItems((xs) => xs.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (!workshopId) return toast.error("Выберите цех");
    const valid = items.filter((it) => it.blank && it.designId && it.decorationTypeId && +it.quantity > 0);
    if (valid.length === 0) return toast.error("Добавьте хотя бы одну позицию");
    setBusy(true);
    try {
      await api.createWorkshopOrder({
        workshopId,
        notes,
        items: valid.map((it) => ({
          blankProductId: it.blank!.id,
          designId: it.designId,
          decorationTypeId: it.decorationTypeId,
          quantity: +it.quantity,
          notes: it.notes,
        })),
      });
      toast.success("Заказ создан");
      setItems([{ blank: null, designId: "", decorationTypeId: "", quantity: "1", notes: "" }]);
      setNotes("");
      onOpenChange(false);
      onDone();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Новый заказ в цех</DialogTitle>
          <DialogDescription>Список пустых товаров и дизайнов для вышивки. После отправки система автоматически переместит товары в цех (если их недостаточно — со своего склада).</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Цех</Label>
              <WarehouseSelect value={workshopId} onChange={setWorkshopId} filterType="workshop" />
            </div>
            <div className="space-y-1.5">
              <Label>Общий комментарий</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Срочно, для выставки и т.д." />
            </div>
          </div>

          <div className="space-y-3">
            <Label>Позиции заказа</Label>
            {items.map((it, idx) => (
              <div key={idx} className="rounded-lg border p-3 space-y-3 relative">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Позиция {idx + 1}</span>
                  {items.length > 1 && (
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => removeItem(idx)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                <div>
                  <Label className="text-xs mb-1.5 block">Пустой товар</Label>
                  <ProductPicker blankOnly onChange={(p) => update(idx, { blank: p })} />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label className="text-xs mb-1.5 block">Тип украшения</Label>
                    <Select value={it.decorationTypeId} onValueChange={(v) => update(idx, { decorationTypeId: v })}>
                      <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {decorationTypes.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs mb-1.5 block">Дизайн</Label>
                    <Select value={it.designId} onValueChange={(v) => update(idx, { designId: v })}>
                      <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {designs.length === 0 ? (
                          <div className="text-xs text-muted-foreground p-2">Создай дизайн</div>
                        ) : designs.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs mb-1.5 block">Кол-во</Label>
                    <Input type="number" min="1" value={it.quantity} onChange={(e) => update(idx, { quantity: e.target.value })} />
                  </div>
                </div>
              </div>
            ))}
            <Button variant="outline" onClick={addItem}><Plus className="h-4 w-4" /> Ещё позиция</Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Создать заказ"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
