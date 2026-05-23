"use client";

import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Warehouse, Color, Size } from "@/lib/types";
import { Plus, Trash2, Pencil } from "lucide-react";

export default function SettingsPage() {
  return (
    <div>
      <PageHeader title="Справочники" description="Склады, цвета, размеры — базовые сущности учёта" />

      <div className="grid lg:grid-cols-2 gap-6">
        <WarehousesCard />
        <ColorsCard />
        <SizesCard />
      </div>
    </div>
  );
}

// ============= WAREHOUSES =============

function WarehousesCard() {
  const [items, setItems] = useState<Warehouse[]>([]);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  async function reload() { setItems(await api.listWarehouses()); }
  useEffect(() => { reload(); }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Склады</CardTitle>
        <Button size="sm" onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4" /> Добавить</Button>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {items.length === 0 && <div className="text-sm text-muted-foreground text-center py-6">Складов нет</div>}
          {items.map((w) => (
            <div key={w.id} className="flex items-center justify-between gap-2 p-3 rounded-lg border hover:bg-muted/30 transition">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${w.type === "own" ? "bg-emerald-500" : "bg-amber-500"}`} />
                  <span className="font-medium truncate">{w.name}</span>
                  <Badge variant="outline" className="text-[10px]">{w.type === "own" ? "свой" : "цех"}</Badge>
                </div>
                {(w.address || w.contact) && (
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {[w.address, w.contact].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="icon" variant="ghost" title="Редактировать" onClick={() => setEditing(w)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" title="Удалить" onClick={async () => {
                  if (!confirm(`Удалить склад «${w.name}»? Это удалит все его остатки.`)) return;
                  try { await api.deleteWarehouse(w.id); toast.success("Удалено"); reload(); }
                  catch (e) { toast.error(errorMessage(e)); }
                }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <WarehouseDialog open={openCreate} onOpenChange={setOpenCreate} onDone={reload} />
      <WarehouseDialog warehouse={editing} open={!!editing} onOpenChange={(v) => !v && setEditing(null)} onDone={reload} />
    </Card>
  );
}

function WarehouseDialog({ warehouse, open, onOpenChange, onDone }: { warehouse?: Warehouse | null; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"own" | "workshop">("own");
  const [address, setAddress] = useState("");
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(warehouse?.name ?? "");
      setType(warehouse?.type ?? "own");
      setAddress(warehouse?.address ?? "");
      setContact(warehouse?.contact ?? "");
      setNotes(warehouse?.notes ?? "");
    }
  }, [open, warehouse]);

  async function submit() {
    if (!name.trim()) return toast.error("Название обязательно");
    setBusy(true);
    try {
      if (warehouse) {
        await api.updateWarehouse(warehouse.id, {
          name, type,
          address: address || null,
          contact: contact || null,
          notes: notes || null,
        });
        toast.success("Сохранено");
      } else {
        await api.createWarehouse({ name, type, address: address || undefined, contact: contact || undefined });
        toast.success("Склад добавлен");
      }
      onOpenChange(false);
      onDone();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{warehouse ? "Редактирование склада" : "Новый склад"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Название</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Цех №2" />
            </div>
            <div className="space-y-1.5">
              <Label>Тип</Label>
              <Select value={type} onValueChange={(v) => setType(v as "own" | "workshop")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="own">Свой склад</SelectItem>
                  <SelectItem value="workshop">Цех (внешний)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Адрес</Label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Город, улица…" />
          </div>
          <div className="space-y-1.5">
            <Label>Контакт</Label>
            <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Имя, телефон, почта…" />
          </div>
          <div className="space-y-1.5">
            <Label>Заметки</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Что хранится, особенности…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Сохранить"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============= COLORS =============

function ColorsCard() {
  const [items, setItems] = useState<Color[]>([]);
  const [editing, setEditing] = useState<Color | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  async function reload() { setItems(await api.listColors()); }
  useEffect(() => { reload(); }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Цвета</CardTitle>
        <Button size="sm" onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4" /> Добавить</Button>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {items.length === 0 && <div className="text-sm text-muted-foreground text-center py-6">Цветов нет</div>}
          {items.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 p-3 rounded-lg border hover:bg-muted/30 transition">
              <div className="flex items-center gap-3 min-w-0">
                <span className="h-6 w-6 rounded-md border shrink-0" style={{ backgroundColor: c.hex_code ?? "#999" }} />
                <div>
                  <div className="font-medium">{c.name}</div>
                  {c.hex_code && <div className="text-[11px] text-muted-foreground font-mono">{c.hex_code}</div>}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="icon" variant="ghost" title="Редактировать" onClick={() => setEditing(c)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" title="Удалить" onClick={async () => {
                  if (!confirm(`Удалить цвет «${c.name}»?`)) return;
                  try { await api.deleteColor(c.id); toast.success("Удалено"); reload(); }
                  catch (e) { toast.error(errorMessage(e)); }
                }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <ColorDialog open={openCreate} onOpenChange={setOpenCreate} onDone={reload} />
      <ColorDialog color={editing} open={!!editing} onOpenChange={(v) => !v && setEditing(null)} onDone={reload} />
    </Card>
  );
}

function ColorDialog({ color, open, onOpenChange, onDone }: { color?: Color | null; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#000000");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(color?.name ?? "");
      setHex(color?.hex_code ?? "#000000");
    }
  }, [open, color]);

  async function submit() {
    if (!name.trim()) return toast.error("Введите название");
    setBusy(true);
    try {
      if (color) {
        await api.updateColor(color.id, { name, hex_code: hex });
        toast.success("Сохранено");
      } else {
        await api.createColor({ name, hex_code: hex });
        toast.success("Цвет добавлен");
      }
      onOpenChange(false);
      onDone();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{color ? "Редактирование цвета" : "Новый цвет"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Название</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Розовый" />
          </div>
          <div className="space-y-1.5">
            <Label>Цвет (HEX)</Label>
            <div className="flex gap-2 items-center">
              <Input type="color" value={hex} onChange={(e) => setHex(e.target.value)} className="h-10 w-16 p-1" />
              <Input value={hex} onChange={(e) => setHex(e.target.value)} className="font-mono flex-1" />
              <div className="h-10 w-10 rounded-md border shrink-0" style={{ backgroundColor: hex }} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Сохранить"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============= SIZES =============

function SizesCard() {
  const [items, setItems] = useState<Size[]>([]);
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("100");
  async function reload() { setItems(await api.listSizes()); }
  useEffect(() => { reload(); }, []);

  return (
    <Card>
      <CardHeader><CardTitle>Размеры</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-1 mb-4">
          {items.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 p-2 rounded border">
              <div>
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted-foreground ml-2">порядок: {s.sort_order}</span>
              </div>
              <Button size="icon" variant="ghost" onClick={async () => {
                if (!confirm(`Удалить размер «${s.name}»?`)) return;
                try { await api.deleteSize(s.id); toast.success("Удалено"); reload(); } catch (e) { toast.error(errorMessage(e)); }
              }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <div className="border-t pt-4 flex gap-2 items-end">
          <div className="flex-1">
            <Label className="text-xs">Размер</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="3XL" />
          </div>
          <div className="w-24">
            <Label className="text-xs">Порядок</Label>
            <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </div>
          <Button onClick={async () => {
            if (!name.trim()) return toast.error("Введите размер");
            try { await api.createSize({ name, sort_order: +sortOrder || 100 }); toast.success("Добавлено"); setName(""); reload(); }
            catch (e) { toast.error(errorMessage(e)); }
          }}><Plus className="h-4 w-4" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}
