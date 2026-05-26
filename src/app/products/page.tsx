"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pill } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Color, DecorationType, Design, DesignType, FabricType, Product, ProductCategory, Size } from "@/lib/types";
import { Package, Plus, Search, Trash2, Pencil, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney, errorMessage } from "@/lib/utils";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "blank" | "finished">("all");
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function syncOzonPrices() {
    setSyncing(true);
    const t = toast.loading("Синхронизация цен с Ozon…");
    try {
      const res = await fetch("/api/ozon/sync-prices", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Ошибка синхронизации");
      toast.success(
        `Цены обновлены: ${data.updated} изменено, ${data.unchanged} без изменений${data.notFound ? `, ${data.notFound} без цены` : ""}`,
        { id: t },
      );
      await reload();
    } catch (e) {
      toast.error(`Ошибка: ${errorMessage(e)}`, { id: t });
    } finally {
      setSyncing(false);
    }
  }

  async function reload() {
    setLoading(true);
    setProducts(await api.listProducts());
    setLoading(false);
  }
  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    return products.filter((p) => {
      if (filter === "blank" && !p.is_blank) return false;
      if (filter === "finished" && p.is_blank) return false;
      if (search) {
        const h = [p.sku, p.category?.name, p.color?.name, p.size?.name, p.fabric?.name, p.design?.name, p.decoration_type?.name].filter(Boolean).join(" ").toLowerCase();
        if (!h.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [products, filter, search]);

  return (
    <div>
      <PageHeader
        title="Каталог SKU"
        description="Все уникальные комбинации товаров (футболка/худи × ткань × цвет × размер × дизайн × тип украшения)"
        action={
          <>
            <Button variant="outline" onClick={syncOzonPrices} disabled={syncing}>
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">
                {syncing ? "Синхронизация…" : "Синхронизировать цены с Ozon"}
              </span>
              <span className="sm:hidden">{syncing ? "…" : "Цены Ozon"}</span>
            </Button>
            <Button onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Создать SKU</span>
              <span className="sm:hidden">Новый</span>
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по артикулу, цвету, дизайну…" className="pl-8" />
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "blank" | "finished")}>
            <TabsList>
              <TabsTrigger value="all">Все ({products.length})</TabsTrigger>
              <TabsTrigger value="blank">Пустые ({products.filter((p) => p.is_blank).length})</TabsTrigger>
              <TabsTrigger value="finished">Готовые ({products.filter((p) => !p.is_blank).length})</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center text-muted-foreground">Загрузка…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Package}
              title="Каталог пуст"
              description="SKU создаются автоматически при первой приёмке или вручную здесь"
              action={<Button onClick={() => setOpenCreate(true)}><Plus className="h-4 w-4" /> Создать SKU</Button>}
            />
          ) : (
            <>
              {/* Desktop / tablet table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Товар</TableHead>
                      <TableHead>Артикул</TableHead>
                      <TableHead className="text-right">Себестоимость</TableHead>
                      <TableHead className="text-right">Цена продажи</TableHead>
                      <TableHead className="text-right w-24">Действия</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell><ProductDisplay p={p} compact /></TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{p.sku ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          <PriceCell productId={p.id} field="cost_price" value={p.cost_price} onSaved={reload} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <PriceCell productId={p.id} field="sale_price" value={p.sale_price} onSaved={reload} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" title="Редактировать" onClick={() => setEditing(p)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" title="Удалить" onClick={async () => {
                              if (!confirm("Удалить SKU? Это удалит и все остатки.")) return;
                              try { await api.deleteProduct(p.id); toast.success("Удалено"); reload(); }
                              catch (e) { toast.error(errorMessage(e)); }
                            }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile card list */}
              <div className="md:hidden divide-y">
                {filtered.map((p) => (
                  <div key={p.id} className="p-4 space-y-2">
                    <ProductDisplay p={p} compact />
                    <div className="font-mono text-[11px] text-muted-foreground break-all">{p.sku ?? "—"}</div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Себестоимость</div>
                        <PriceCell productId={p.id} field="cost_price" value={p.cost_price} onSaved={reload} />
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Цена</div>
                        <PriceCell productId={p.id} field="sale_price" value={p.sale_price} onSaved={reload} />
                      </div>
                    </div>
                    <div className="flex justify-end gap-1 pt-1">
                      <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                        <Pencil className="h-3.5 w-3.5" /> Изменить
                      </Button>
                      <Button size="sm" variant="ghost" onClick={async () => {
                        if (!confirm("Удалить SKU? Это удалит и все остатки.")) return;
                        try { await api.deleteProduct(p.id); toast.success("Удалено"); reload(); }
                        catch (e) { toast.error(errorMessage(e)); }
                      }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <CreateSkuDialog open={openCreate} onOpenChange={setOpenCreate} onDone={reload} />
      <EditProductDialog product={editing} onClose={() => setEditing(null)} onDone={reload} />
    </div>
  );
}

function PriceCell({ productId, field, value, onSaved }: { productId: string; field: "cost_price" | "sale_price"; value: number | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value?.toString() ?? "");

  if (!editing) {
    return (
      <button onClick={() => { setV(value?.toString() ?? ""); setEditing(true); }} className="hover:bg-muted/50 px-2 py-1 rounded">
        {formatMoney(value)}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 justify-end">
      <Input value={v} onChange={(e) => setV(e.target.value)} className="h-7 w-24 text-right" autoFocus />
      <Button size="sm" variant="ghost" onClick={async () => {
        try {
          await api.updateProductPrices(productId, { [field]: v === "" ? null : parseFloat(v) });
          toast.success("Сохранено");
          setEditing(false);
          onSaved();
        } catch (e) { toast.error(errorMessage(e)); }
      }}>✓</Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>×</Button>
    </div>
  );
}

function EditProductDialog({ product, onClose, onDone }: { product: Product | null; onClose: () => void; onDone: () => void }) {
  const [sku, setSku] = useState("");
  const [cost, setCost] = useState("");
  const [sale, setSale] = useState("");
  const [designId, setDesignId] = useState<string>("");
  const [designs, setDesigns] = useState<Design[]>([]);
  const [busy, setBusy] = useState(false);

  // Готовые SKU имеют дизайн — даём возможность поменять его на другой
  // того же типа украшения (print → print, embroidery → embroidery).
  const canChangeDesign = !!product && !product.is_blank && !!product.decoration_type;
  const decorationSlug = product?.decoration_type?.slug;
  const designType: DesignType | null =
    decorationSlug === "print" ? "print" : decorationSlug === "embroidery" ? "embroidery" : null;
  const filteredDesigns = useMemo(() => {
    if (!designType) return designs;
    return designs.filter((d) => d.type === designType);
  }, [designs, designType]);

  useEffect(() => {
    if (product) {
      setSku(product.sku ?? "");
      setCost(product.cost_price?.toString() ?? "");
      setSale(product.sale_price?.toString() ?? "");
      setDesignId(product.design_id ?? "");
    }
  }, [product]);

  useEffect(() => {
    if (!canChangeDesign || !designType) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await api.listDesigns({ type: designType });
        if (!cancelled) setDesigns(d);
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      }
    })();
    return () => { cancelled = true; };
  }, [canChangeDesign, designType]);

  if (!product) return null;

  async function submit() {
    if (!product) return;
    setBusy(true);
    try {
      const patch: { sku: string | null; cost_price: number | null; sale_price: number | null; design_id?: string | null } = {
        sku: sku.trim() || null,
        cost_price: cost === "" ? null : parseFloat(cost),
        sale_price: sale === "" ? null : parseFloat(sale),
      };
      if (canChangeDesign && designId !== (product.design_id ?? "")) {
        patch.design_id = designId || null;
      }
      await api.updateProduct(product.id, patch);
      toast.success("Сохранено");
      onDone();
      onClose();
    } catch (e) {
      const msg = errorMessage(e);
      // Дружелюбное сообщение, если уже есть SKU с такой же комбинацией
      if (/duplicate|unique/i.test(msg)) {
        toast.error("Такой SKU уже существует (та же комбинация цвет/размер/дизайн/тип украшения). Удалите дубликат или поменяйте другие поля.");
      } else {
        toast.error(msg);
      }
    }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={!!product} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Редактирование SKU</DialogTitle>
          <div className="text-sm text-muted-foreground">
            <ProductDisplay p={product} compact />
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Артикул (SKU)</Label>
            <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="var2-Hoodie-Black-L" className="font-mono" />
            <div className="text-[11px] text-muted-foreground">Артикул должен быть уникальным. Можно использовать offer_id из Ozon.</div>
          </div>

          {canChangeDesign && (
            <div className="space-y-1.5">
              <Label>Дизайн ({product.decoration_type?.name?.toLowerCase()})</Label>
              <Select value={designId} onValueChange={setDesignId}>
                <SelectTrigger>
                  <SelectValue placeholder="Выбрать дизайн" />
                </SelectTrigger>
                <SelectContent>
                  {filteredDesigns.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-2">Нет дизайнов</div>
                  ) : filteredDesigns.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-[11px] text-muted-foreground">
                Показываются только дизайны с типом «{designType === "print" ? "принт" : "вышивка"}». Историю продаж и транзакций смена дизайна не затронет — изменится только описание SKU и автомэтчинг с Ozon.
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Себестоимость, ₽</Label>
              <Input type="number" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="1300" />
            </div>
            <div className="space-y-1.5">
              <Label>Цена продажи, ₽</Label>
              <Input type="number" value={sale} onChange={(e) => setSale(e.target.value)} placeholder="4600" />
            </div>
          </div>

          {cost && sale && parseFloat(sale) > parseFloat(cost) && (
            <div className="text-sm rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 p-3">
              Маржа: <span className="font-semibold">{formatMoney(parseFloat(sale) - parseFloat(cost))}</span>{" "}
              <span className="text-muted-foreground">
                ({Math.round(((parseFloat(sale) - parseFloat(cost)) / parseFloat(sale)) * 100)}%)
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "..." : "Сохранить"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SkuRow {
  id: string;
  colorId: string;
  decorationTypeId: string;
  designId: string;
  sizes: Set<string>;
}

function newSkuRow(): SkuRow {
  return { id: Math.random().toString(36).slice(2), colorId: "", decorationTypeId: "", designId: "", sizes: new Set() };
}

function CreateSkuDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [blank, setBlank] = useState(true);
  const [categoryId, setCategoryId] = useState("");
  const [fabricId, setFabricId] = useState("");
  const [rows, setRows] = useState<SkuRow[]>([newSkuRow()]);
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
      const [c, f, col, s, d, dt] = await Promise.all([
        api.listCategories(),
        api.listFabrics(),
        api.listColors(),
        api.listSizes(),
        api.listDesigns(),
        api.listDecorationTypes(),
      ]);
      setCategories(c); setFabrics(f); setColors(col); setSizes(s); setDesigns(d); setDecorationTypes(dt);
      setCategoryId((prev) => prev || c.find((x) => x.slug === "tshirt" || /^футболк/i.test(x.name))?.id || c[0]?.id || "");
      setFabricId((prev) => prev || f.find((x) => x.slug === "regular" || /^обычн/i.test(x.name))?.id || f[0]?.id || "");
    })();
  }, [open]);

  function reset() {
    setRows([newSkuRow()]); setCategoryId(""); setFabricId("");
  }

  function updateRow(i: number, patch: Partial<SkuRow>) {
    setRows((xs) => xs.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function toggleSize(i: number, sizeId: string) {
    setRows((xs) => xs.map((x, idx) => {
      if (idx !== i) return x;
      const ns = new Set(x.sizes);
      if (ns.has(sizeId)) ns.delete(sizeId); else ns.add(sizeId);
      return { ...x, sizes: ns };
    }));
  }
  function addRow() { setRows((xs) => [...xs, newSkuRow()]); }
  function removeRow(i: number) { setRows((xs) => xs.filter((_, idx) => idx !== i)); }

  const sortedSizes = useMemo(() => [...sizes].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), [sizes]);

  const totalCount = useMemo(
    () => rows.reduce((s, r) => s + (r.colorId && (blank || (r.decorationTypeId && r.designId)) ? r.sizes.size : 0), 0),
    [rows, blank]
  );

  const canSubmit = !!categoryId && !!fabricId && totalCount > 0 &&
    rows.every((r) => {
      if (r.sizes.size === 0) return true; // пустая строка ОК
      if (!r.colorId) return false;
      if (!blank && (!r.decorationTypeId || !r.designId)) return false;
      return true;
    });

  async function submit() {
    if (!canSubmit) return toast.error("Заполните тип, ткань и выберите размеры");
    setBusy(true);
    try {
      const tasks: { colorId: string; sizeId: string; designId: string | null; decorationTypeId: string | null }[] = [];
      for (const r of rows) {
        if (!r.colorId || r.sizes.size === 0) continue;
        for (const sizeId of r.sizes) {
          tasks.push({
            colorId: r.colorId,
            sizeId,
            designId: blank ? null : r.designId,
            decorationTypeId: blank ? null : r.decorationTypeId,
          });
        }
      }
      const created = await Promise.all(
        tasks.map((t) => api.findOrCreateProduct({
          category_id: categoryId,
          fabric_id: fabricId,
          color_id: t.colorId,
          size_id: t.sizeId,
          design_id: t.designId,
          decoration_type_id: t.decorationTypeId,
        }))
      );
      toast.success(`Готово: ${created.length} SKU создано / найдено`);
      reset();
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Создание SKU</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Pill shape="square" active={blank} onClick={() => setBlank(true)}>Пустой</Pill>
            <Pill shape="square" active={!blank} onClick={() => setBlank(false)}>Готовый (с дизайном)</Pill>
          </div>

          <div className="grid grid-cols-2 gap-3">
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
              <SkuRowEditor
                key={r.id}
                row={r}
                blank={blank}
                colors={colors}
                sizes={sortedSizes}
                designs={designs}
                decorationTypes={decorationTypes}
                onChange={(p) => updateRow(idx, p)}
                onToggleSize={(sid) => toggleSize(idx, sid)}
                onRemove={rows.length > 1 ? () => removeRow(idx) : undefined}
              />
            ))}
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="h-4 w-4" /> Ещё {blank ? "цвет" : "цвет / дизайн"}
            </Button>
          </div>
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {totalCount > 0 ? <>Итого: <span className="font-semibold text-foreground tabular-nums">{totalCount}</span> SKU</> : "Выберите размеры"}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
            <Button onClick={submit} disabled={busy || !canSubmit}>{busy ? "..." : "Создать"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkuRowEditor({
  row, blank, colors, sizes, designs, decorationTypes, onChange, onToggleSize, onRemove,
}: {
  row: SkuRow;
  blank: boolean;
  colors: Color[];
  sizes: Size[];
  designs: Design[];
  decorationTypes: DecorationType[];
  onChange: (p: Partial<SkuRow>) => void;
  onToggleSize: (sizeId: string) => void;
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
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
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
        <Label className="text-xs mb-1.5 block">Размеры (клик — выбрать / снять)</Label>
        <div className="flex flex-wrap gap-1.5">
          {sizes.map((s) => {
            const active = row.sizes.has(s.id);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onToggleSize(s.id)}
                className={cn(
                  "h-9 min-w-[2.5rem] px-2.5 rounded-md border text-sm font-medium tabular-nums transition-colors",
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background hover:bg-accent",
                )}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
