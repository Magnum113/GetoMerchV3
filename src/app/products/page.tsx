"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { ProductPicker } from "@/components/product-picker";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Product } from "@/lib/types";
import { Package, Plus, Search, Trash2, Pencil, RefreshCw } from "lucide-react";
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (product) {
      setSku(product.sku ?? "");
      setCost(product.cost_price?.toString() ?? "");
      setSale(product.sale_price?.toString() ?? "");
    }
  }, [product]);

  if (!product) return null;

  async function submit() {
    if (!product) return;
    setBusy(true);
    try {
      await api.updateProduct(product.id, {
        sku: sku.trim() || null,
        cost_price: cost === "" ? null : parseFloat(cost),
        sale_price: sale === "" ? null : parseFloat(sale),
      });
      toast.success("Сохранено");
      onDone();
      onClose();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={!!product} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Редактирование SKU</DialogTitle>
          <DialogDescription>
            <ProductDisplay p={product} compact />
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Артикул (SKU)</Label>
            <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="var2-Hoodie-Black-L" className="font-mono" />
            <div className="text-[11px] text-muted-foreground">Артикул должен быть уникальным. Можно использовать offer_id из Ozon.</div>
          </div>

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

function CreateSkuDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [blank, setBlank] = useState(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Создание SKU</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2 text-sm">
            <button type="button" onClick={() => setBlank(true)} className={`px-3 py-1.5 rounded-md border ${blank ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}>Пустой</button>
            <button type="button" onClick={() => setBlank(false)} className={`px-3 py-1.5 rounded-md border ${!blank ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}>Готовый (с дизайном)</button>
          </div>
          <ProductPicker blankOnly={blank} finishedOnly={!blank} onChange={setProduct} />
          {product && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <Label className="text-xs">Будет создан / найден SKU:</Label>
              <div className="mt-1 font-mono">{product.sku}</div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button disabled={!product} onClick={() => { toast.success(`SKU «${product?.sku}» создан/найден`); onDone(); onOpenChange(false); }}>Готово</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
