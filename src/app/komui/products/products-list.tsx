"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  EyeOff,
  ImageIcon,
  Loader2,
  RefreshCcw,
  Search,
  Shirt,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn, errorMessage, formatMoney } from "@/lib/utils";
import {
  STOREFRONT_ACTIVE_LABELS,
  type StorefrontActiveFilter,
  type StorefrontListResponse,
  type StorefrontProduct,
} from "@/lib/komui/types";

const PAGE_SIZE = 50;

function thumbUrl(p: StorefrontProduct): string | null {
  return (
    p.mainImagePath ||
    p.primaryImageUrl ||
    (p.imageUrls && p.imageUrls.length > 0 ? p.imageUrls[0] : null)
  );
}

export function ProductsList() {
  const [items, setItems] = useState<StorefrontProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<StorefrontActiveFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      params.set("active", active);
      if (q) params.set("q", q);
      const res = await fetch(`/api/komui/storefront/products?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as StorefrontListResponse | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setItems(data.products);
      setTotal(data.pagination.total);
    } catch (e) {
      toast.error(errorMessage(e));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [offset, active, q]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  const filters: StorefrontActiveFilter[] = useMemo(
    () => ["all", "active", "inactive"],
    [],
  );

  function applySearch() {
    setOffset(0);
    setQ(searchInput.trim());
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="flex flex-wrap gap-1.5">
              {filters.map((f) => (
                <Pill
                  key={f}
                  shape="square"
                  active={active === f}
                  onClick={() => {
                    setActive(f);
                    setOffset(0);
                  }}
                >
                  {STOREFRONT_ACTIVE_LABELS[f]}
                </Pill>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  applySearch();
                }}
                className="relative"
              >
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="название, slug, design key, коллекция"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-8 w-80"
                />
              </form>
              <Button variant="outline" onClick={load} disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
                Обновить
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {items.length === 0 && !loading ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Shirt}
              title="Товары не найдены"
              description={q ? `По запросу "${q}" ничего не нашли` : "Витрина пуста или фильтр скрывает всё"}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14"></TableHead>
                    <TableHead>Название</TableHead>
                    <TableHead className="w-32 text-right">Цена</TableHead>
                    <TableHead className="w-32 text-right">Старая</TableHead>
                    <TableHead className="w-40">Размеры</TableHead>
                    <TableHead className="w-28">Статус</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((p) => {
                    const thumb = thumbUrl(p);
                    return (
                      <TableRow
                        key={p.id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => {
                          window.location.href = `/komui/products/${p.id}`;
                        }}
                      >
                        <TableCell>
                          {thumb ? (
                            // Внешние Ozon-изображения — обычный <img>, чтобы
                            // не настраивать domains в next.config.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={thumb}
                              alt=""
                              className="h-10 w-10 rounded object-cover border bg-muted"
                              loading="lazy"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded border bg-muted flex items-center justify-center text-muted-foreground">
                              <ImageIcon className="h-4 w-4" />
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Link
                            href={`/komui/products/${p.id}`}
                            className="font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {p.name}
                          </Link>
                          <div className="text-xs text-muted-foreground font-mono truncate max-w-[420px]">
                            {p.slug}
                            {p.collectionName && (
                              <>
                                {" · "}
                                <span className="opacity-70">
                                  {p.collectionName}
                                </span>
                              </>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(p.salePrice)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.regularPrice ? (
                            <span className="line-through text-muted-foreground">
                              {formatMoney(p.regularPrice)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {p.sizes && p.sizes.length > 0 ? (
                              p.sizes.map((s) => (
                                <Badge
                                  key={s}
                                  variant="outline"
                                  className="text-[10px] font-mono"
                                >
                                  {s}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                —
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {p.isActive ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "border-transparent bg-state-success text-state-success-fg",
                              )}
                            >
                              активен
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className={cn(
                                "border-transparent bg-state-neutral text-state-neutral-fg inline-flex items-center gap-1",
                              )}
                            >
                              <EyeOff className="h-3 w-3" /> скрыт
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          Всего: <span className="tabular-nums text-foreground">{total}</span>
          {total > 0 && (
            <>
              {" · "}
              Страница{" "}
              <span className="tabular-nums text-foreground">{currentPage}</span>{" "}
              из{" "}
              <span className="tabular-nums text-foreground">{totalPages}</span>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!canPrev || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft className="h-4 w-4" /> Назад
          </Button>
          <Button
            variant="outline"
            disabled={!canNext || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Вперёд <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
