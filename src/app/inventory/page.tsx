"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductDisplay } from "@/components/product-display";
import { InventoryActions, AdjustInline } from "@/components/inventory-actions";
import { PrintInventoryActions, AdjustPrintInline } from "@/components/print-inventory-actions";
import { InventoryDashboard } from "@/components/inventory-dashboard";
import { api } from "@/lib/api";
import type { Inventory, PrintInventory, Product, Size, Warehouse } from "@/lib/types";
import { Warehouse as WarehouseIcon, Search, Image as ImageIcon, LayoutGrid } from "lucide-react";
import { formatDate } from "@/lib/utils";

type Mode = "dashboard" | "products" | "prints";

export default function InventoryPage() {
  const [mode, setMode] = useState<Mode>("dashboard");
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inv, setInv] = useState<Inventory[]>([]);
  const [prints, setPrints] = useState<PrintInventory[]>([]);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "blank" | "finished">("all");
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    const [w, i, p, s, prods] = await Promise.all([
      api.listWarehouses(),
      api.listInventory(),
      api.listPrintInventory(),
      api.listSizes(),
      api.listProducts(),
    ]);
    setWarehouses(w);
    setInv(i);
    setPrints(p);
    setSizes(s);
    setProducts(prods);
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    return inv.filter((i) => {
      if (filter === "blank" && !i.product?.is_blank) return false;
      if (filter === "finished" && i.product?.is_blank) return false;
      if (search) {
        const haystack = [
          i.product?.sku,
          i.product?.category?.name,
          i.product?.fabric?.name,
          i.product?.color?.name,
          i.product?.size?.name,
          i.product?.design?.name,
          i.product?.decoration_type?.name,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [inv, filter, search]);

  const filteredPrints = useMemo(() => {
    return prints.filter((p) => {
      if (search) {
        const hay = [p.design?.name, p.design?.description, p.warehouse?.name].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [prints, search]);

  return (
    <div>
      <PageHeader
        title="Остатки на складах"
        description={mode === "dashboard"
          ? "Сводка по складам, дефициты и готовность активных заказов"
          : mode === "products"
          ? "Все позиции с положительным остатком. Быстрые действия — приёмка, перемещение, продажа, производство"
          : "Запас готовых принтов на складе. При производстве с типом «принт» система автоматически списывает 1 принт на изделие."}
        action={mode === "dashboard" ? (
          <div className="flex gap-2">
            <InventoryActions onChange={reload} />
          </div>
        ) : mode === "products" ? <InventoryActions onChange={reload} /> : <PrintInventoryActions onChange={reload} />}
      />

      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="mb-4">
        <TabsList>
          <TabsTrigger value="dashboard"><LayoutGrid className="h-3.5 w-3.5 mr-1.5" />Дашборд</TabsTrigger>
          <TabsTrigger value="products">Изделия</TabsTrigger>
          <TabsTrigger value="prints">Принты</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode !== "dashboard" && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={mode === "products" ? "Поиск по SKU, цвету, дизайну…" : "Поиск по дизайну…"}
                  className="pl-8"
                />
              </div>
              {mode === "products" && (
                <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "blank" | "finished")}>
                  <TabsList>
                    <TabsTrigger value="all">Все</TabsTrigger>
                    <TabsTrigger value="blank">Пустые</TabsTrigger>
                    <TabsTrigger value="finished">Готовые</TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {mode === "dashboard" ? (
        <InventoryDashboard inv={inv} prints={prints} warehouses={warehouses} sizes={sizes} products={products} loading={loading} />
      ) : mode === "products" ? (
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">Все склады</TabsTrigger>
            {warehouses.map((w) => (
              <TabsTrigger key={w.id} value={w.id}>
                <span className="inline-flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${w.type === "own" ? "bg-emerald-500" : "bg-amber-500"}`} />
                  {w.name}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="all">
            <InvTable items={filtered} loading={loading} onChange={reload} showWarehouse />
          </TabsContent>

          {warehouses.map((w) => (
            <TabsContent key={w.id} value={w.id}>
              <InvTable items={filtered.filter((i) => i.warehouse_id === w.id)} loading={loading} onChange={reload} />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">Все склады</TabsTrigger>
            {warehouses.map((w) => (
              <TabsTrigger key={w.id} value={w.id}>
                <span className="inline-flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${w.type === "own" ? "bg-emerald-500" : "bg-amber-500"}`} />
                  {w.name}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="all">
            <PrintTable items={filteredPrints} loading={loading} onChange={reload} showWarehouse />
          </TabsContent>

          {warehouses.map((w) => (
            <TabsContent key={w.id} value={w.id}>
              <PrintTable items={filteredPrints.filter((i) => i.warehouse_id === w.id)} loading={loading} onChange={reload} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

function InvTable({ items, loading, onChange, showWarehouse }: { items: Inventory[]; loading: boolean; onChange: () => void; showWarehouse?: boolean }) {
  if (loading) {
    return (
      <Card className="mt-4"><CardContent className="p-10 text-center text-muted-foreground">Загрузка…</CardContent></Card>
    );
  }
  if (items.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent>
          <EmptyState
            icon={WarehouseIcon}
            title="На этом складе пока пусто"
            description="Используй кнопку «Приёмка» сверху, чтобы добавить первое поступление"
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Товар</TableHead>
              {showWarehouse && <TableHead>Склад</TableHead>}
              <TableHead className="text-right">Количество</TableHead>
              <TableHead className="hidden md:table-cell">Обновлено</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={i.id}>
                <TableCell><ProductDisplay p={i.product} /></TableCell>
                {showWarehouse && (
                  <TableCell>
                    <Badge variant="outline">
                      <span className={`h-2 w-2 rounded-full mr-1.5 ${i.warehouse?.type === "own" ? "bg-emerald-500" : "bg-amber-500"}`} />
                      {i.warehouse?.name}
                    </Badge>
                  </TableCell>
                )}
                <TableCell className="text-right font-semibold tabular-nums">{i.quantity} шт</TableCell>
                <TableCell className="hidden md:table-cell text-muted-foreground text-xs">{formatDate(i.updated_at)}</TableCell>
                <TableCell className="text-right">
                  <AdjustInline item={i} onDone={onChange} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PrintTable({ items, loading, onChange, showWarehouse }: { items: PrintInventory[]; loading: boolean; onChange: () => void; showWarehouse?: boolean }) {
  if (loading) {
    return <Card className="mt-4"><CardContent className="p-10 text-center text-muted-foreground">Загрузка…</CardContent></Card>;
  }
  if (items.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent>
          <EmptyState
            icon={ImageIcon}
            title="Принтов на складе пока нет"
            description="Нажми «Приёмка принтов», чтобы добавить поступление."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Дизайн</TableHead>
              {showWarehouse && <TableHead>Склад</TableHead>}
              <TableHead className="text-right">Количество</TableHead>
              <TableHead className="hidden md:table-cell">Обновлено</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  <div className="flex items-center gap-3 min-w-0">
                    {i.design?.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={i.design.image_url} alt={i.design.name} className="h-9 w-9 rounded object-cover border" />
                    ) : (
                      <div className="h-9 w-9 rounded border bg-muted flex items-center justify-center">
                        <ImageIcon className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="font-medium truncate">{i.design?.name ?? "—"}</div>
                      {i.design?.description && (
                        <div className="text-xs text-muted-foreground truncate">{i.design.description}</div>
                      )}
                    </div>
                  </div>
                </TableCell>
                {showWarehouse && (
                  <TableCell>
                    <Badge variant="outline">
                      <span className={`h-2 w-2 rounded-full mr-1.5 ${i.warehouse?.type === "own" ? "bg-emerald-500" : "bg-amber-500"}`} />
                      {i.warehouse?.name}
                    </Badge>
                  </TableCell>
                )}
                <TableCell className="text-right font-semibold tabular-nums">{i.quantity} шт</TableCell>
                <TableCell className="hidden md:table-cell text-muted-foreground text-xs">{formatDate(i.updated_at)}</TableCell>
                <TableCell className="text-right">
                  <AdjustPrintInline item={i} onDone={onChange} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
