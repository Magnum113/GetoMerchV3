"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Design, DesignType, Product } from "@/lib/types";
import { Palette, Plus, Trash2, Pencil, Link2, Search } from "lucide-react";
import { formatDate, errorMessage } from "@/lib/utils";

const DESIGN_TYPE_LABELS: Record<DesignType, string> = {
  print: "Принт",
  embroidery: "Вышивка",
};

export default function DesignsPage() {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<Design | null>(null);
  const [binding, setBinding] = useState<Design | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  async function reload() {
    const [d, p] = await Promise.all([api.listDesigns(), api.listProducts({ is_blank: false })]);
    setDesigns(d);
    setProducts(p);
    setLoading(false);
  }
  useEffect(() => { reload(); }, []);

  const countByDesign = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) {
      if (!p.design_id) continue;
      m.set(p.design_id, (m.get(p.design_id) ?? 0) + 1);
    }
    return m;
  }, [products]);

  return (
    <div>
      <PageHeader
        title="Дизайны"
        description="Все дизайны для принтов и вышивок"
        action={<Button onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4" /> Добавить дизайн</Button>}
      />

      {loading ? (
        <div className="p-10 text-center text-muted-foreground">Загрузка…</div>
      ) : designs.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={Palette} title="Пока нет дизайнов" description="Добавь первый дизайн — название, описание и (опционально) ссылка на превью"
            action={<Button onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4" /> Добавить</Button>} />
        </CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {designs.map((d) => (
            <Card key={d.id} className="overflow-hidden group">
              <div className="aspect-square bg-muted relative">
                {d.image_url ? (
                  <Image src={d.image_url} alt={d.name} fill className="object-cover" unoptimized />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                    <Palette className="h-10 w-10 opacity-30" />
                  </div>
                )}
                <div className="absolute top-2 right-2 flex gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition">
                  <Button size="icon" variant="secondary" className="h-7 w-7" title="Привязанные SKU" onClick={() => setBinding(d)}>
                    <Link2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="secondary" className="h-7 w-7" title="Редактировать" onClick={() => setEdit(d)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="secondary" className="h-7 w-7" title="Удалить" onClick={async () => {
                    if (!confirm("Удалить дизайн?")) return;
                    try { await api.deleteDesign(d.id); toast.success("Удалено"); reload(); }
                    catch (e) { toast.error(errorMessage(e)); }
                  }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium truncate">{d.name}</div>
                  <Badge variant="outline" className="shrink-0">{DESIGN_TYPE_LABELS[d.type]}</Badge>
                </div>
                {d.description && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{d.description}</div>}
                <button
                  onClick={() => setBinding(d)}
                  className="text-[11px] text-muted-foreground mt-2 inline-flex items-center gap-1 hover:text-foreground transition"
                >
                  <Link2 className="h-3 w-3" />
                  {countByDesign.get(d.id) ?? 0} SKU
                </button>
                <div className="text-[10px] text-muted-foreground mt-1">{formatDate(d.created_at)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <DesignDialog open={openCreate} onOpenChange={setOpenCreate} onDone={reload} />
      <DesignDialog design={edit ?? undefined} open={!!edit} onOpenChange={(v) => !v && setEdit(null)} onDone={reload} />
      <DesignSkuDialog
        design={binding}
        products={products}
        designs={designs}
        open={!!binding}
        onOpenChange={(v) => !v && setBinding(null)}
        onDone={reload}
      />
    </div>
  );
}

function DesignSkuDialog({
  design,
  products,
  designs,
  open,
  onOpenChange,
  onDone,
}: {
  design: Design | null;
  products: Product[];
  designs: Design[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setSearch(""); setSelected(new Set()); }
  }, [open, design]);

  const linked = useMemo(
    () => products.filter((p) => p.design_id === design?.id),
    [products, design],
  );

  // Кандидаты на привязку: готовые SKU с тем же типом украшения (принт→print,
  // вышивка→embroidery), у которых сейчас другой дизайн. Меняем им design_id.
  const candidates = useMemo(() => {
    if (!design) return [];
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (p.design_id === design.id) return false;
      if (p.decoration_type?.slug !== design.type) return false;
      if (!q) return true;
      const h = [p.sku, p.category?.name, p.color?.name, p.size?.name, p.fabric?.name, p.design?.name]
        .filter(Boolean).join(" ").toLowerCase();
      return h.includes(q);
    });
  }, [products, design, search]);

  // Дизайны того же типа — для перепривязки уже связанного SKU на другой дизайн.
  const sameTypeDesigns = useMemo(
    () => designs.filter((d) => d.type === design?.type),
    [designs, design],
  );

  if (!design) return null;

  function toggle(id: string) {
    setSelected((s) => {
      const ns = new Set(s);
      if (ns.has(id)) ns.delete(id); else ns.add(id);
      return ns;
    });
  }

  async function attach() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      await Promise.all([...selected].map((id) => api.updateProduct(id, { design_id: design!.id })));
      toast.success(`Привязано SKU: ${selected.size}`);
      setSelected(new Set());
      onDone();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function reassign(productId: string, newDesignId: string) {
    if (newDesignId === design!.id) return;
    setBusy(true);
    try {
      await api.updateProduct(productId, { design_id: newDesignId });
      toast.success("SKU перепривязан");
      onDone();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            SKU дизайна «{design.name}»
            <Badge variant="outline">{DESIGN_TYPE_LABELS[design.type]}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
          {/* Привязанные SKU */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Привязанные SKU ({linked.length})
            </Label>
            {linked.length === 0 ? (
              <div className="text-sm text-muted-foreground rounded-md border border-dashed p-3">
                Пока ни один SKU не привязан к этому дизайну.
              </div>
            ) : (
              <div className="divide-y rounded-md border">
                {linked.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 p-2.5">
                    <div className="min-w-0">
                      <ProductDisplay p={p} compact />
                      {p.sku && <div className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">{p.sku}</div>}
                    </div>
                    <Select value={design.id} onValueChange={(v) => reassign(p.id, v)}>
                      <SelectTrigger className="h-8 w-[150px] shrink-0 text-xs" title="Перепривязать на другой дизайн">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sameTypeDesigns.map((d) => (
                          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Привязать ещё SKU */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Привязать SKU</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по артикулу, цвету, размеру…" className="pl-8" />
            </div>
            {candidates.length === 0 ? (
              <div className="text-sm text-muted-foreground rounded-md border border-dashed p-3">
                Нет готовых SKU типа «{DESIGN_TYPE_LABELS[design.type].toLowerCase()}» для привязки.
                Создайте новый SKU в каталоге товаров.
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto divide-y rounded-md border">
                {candidates.map((p) => (
                  <label key={p.id} className="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-muted/40">
                    <Checkbox checked={selected.has(p.id)} onCheckedChange={() => toggle(p.id)} />
                    <div className="min-w-0 flex-1">
                      <ProductDisplay p={p} compact />
                      {p.sku && <div className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">{p.sku}</div>}
                    </div>
                  </label>
                ))}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              Показаны только готовые SKU с украшением «{DESIGN_TYPE_LABELS[design.type].toLowerCase()}» и другим дизайном. Привязка меняет дизайн SKU — историю продаж и транзакций это не затронет.
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <div className="text-sm text-muted-foreground self-center">
            {selected.size > 0 ? <>Выбрано: <span className="font-semibold text-foreground">{selected.size}</span></> : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Закрыть</Button>
            <Button onClick={attach} disabled={busy || selected.size === 0}>
              {busy ? "..." : `Привязать${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DesignDialog({ design, open, onOpenChange, onDone }: { design?: Design; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<DesignType>("print");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(design?.name ?? "");
      setType(design?.type ?? "print");
      setDescription(design?.description ?? "");
      setImageUrl(design?.image_url ?? "");
    }
  }, [open, design]);

  async function submit() {
    if (!name.trim()) return toast.error("Введите название");
    setBusy(true);
    try {
      if (design) {
        await api.updateDesign(design.id, { name, type, description: description || null, image_url: imageUrl || null });
        toast.success("Сохранено");
      } else {
        await api.createDesign({ name, type, description: description || undefined, image_url: imageUrl || undefined });
        toast.success("Дизайн добавлен");
      }
      onOpenChange(false);
      onDone();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{design ? "Редактирование" : "Новый"} дизайн</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Название</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Логотип, Геометрия 1…" />
          </div>
          <div className="space-y-1.5">
            <Label>Тип</Label>
            <Select value={type} onValueChange={(v) => setType(v as DesignType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="print">Принт</SelectItem>
                <SelectItem value="embroidery">Вышивка</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Описание</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Ссылка на изображение</Label>
            <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
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
