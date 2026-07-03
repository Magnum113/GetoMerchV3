"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Link2, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn, errorMessage, formatMoney } from "@/lib/utils";
import { InfoTip } from "./info-tip";
import type {
  LinkOffersResponse,
  PreviewItem,
  PreviewResponse,
  StorefrontListResponse,
  StorefrontProduct,
} from "@/lib/komui/types";

// Несматченные offer-ы, которые нужно вручную привязать к существующей
// карточке сайта (исторические несовпадения design_key). Групповать удобно по
// inferredProduct.designKey — обычно это один дизайн в разных размерах.
export function LinkOffersSection({
  preview,
  updatePrices,
  syncSizes,
  onLinked,
}: {
  preview: PreviewResponse;
  updatePrices: boolean;
  syncSizes: boolean;
  onLinked: () => void;
}) {
  const unmatched = useMemo(
    () =>
      preview.items.filter(
        (it) => !it.targetProduct?.id && it.status === "unmatched",
      ),
    [preview],
  );

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);

  if (unmatched.length === 0) return null;

  const checkedItems = unmatched.filter((it) => checked.has(it.itemId));
  const checkedOfferIds = checkedItems.map((it) => it.offerId);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Группировка по предполагаемому дизайну для читаемости.
  const groups = new Map<string, PreviewItem[]>();
  for (const it of unmatched) {
    const key = it.inferredProduct?.designKey ?? it.inferredProduct?.slug ?? "—";
    const list = groups.get(key);
    if (list) list.push(it);
    else groups.set(key, [it]);
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Привязка</span>
            <Badge variant="secondary" className="tabular-nums">
              {unmatched.length}
            </Badge>
            <InfoTip text="Offer-ы Ozon, которые не сматчились с карточками сайта автоматически (исторические артикулы). Отметь нужные, нажми «Привязать» и выбери карточку — offer-ы добавятся в неё." />
          </div>
          <Button
            onClick={() => setDialogOpen(true)}
            disabled={checkedOfferIds.length === 0}
          >
            <Link2 className="h-4 w-4" /> Привязать выбранные
            {checkedOfferIds.length > 0 && ` (${checkedOfferIds.length})`}
          </Button>
        </div>
        <Separator />
        <div className="space-y-3">
          {Array.from(groups.entries()).map(([key, items]) => (
            <div key={key} className="space-y-1">
              <div className="text-[11px] text-muted-foreground font-mono">
                {key}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {items.map((it) => (
                  <label
                    key={it.itemId}
                    className={cn(
                      "flex items-center gap-1.5 border rounded-md px-2 py-1 text-xs cursor-pointer",
                      checked.has(it.itemId)
                        ? "bg-primary/10 border-primary"
                        : "hover:bg-accent",
                    )}
                  >
                    <Checkbox
                      checked={checked.has(it.itemId)}
                      onCheckedChange={() => toggle(it.itemId)}
                    />
                    <span className="font-mono">{it.offerId}</span>
                    {it.size && (
                      <Badge variant="outline" className="text-[10px]">
                        {it.size}
                      </Badge>
                    )}
                    {it.price != null && (
                      <span className="text-muted-foreground tabular-nums">
                        {formatMoney(it.price)}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <LinkDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        previewId={preview.previewId}
        offerIds={checkedOfferIds}
        updatePrices={updatePrices}
        syncSizes={syncSizes}
        onLinked={() => {
          setChecked(new Set());
          setDialogOpen(false);
          onLinked();
        }}
      />
    </Card>
  );
}

function LinkDialog({
  open,
  onOpenChange,
  previewId,
  offerIds,
  updatePrices,
  syncSizes,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  previewId: string;
  offerIds: string[];
  updatePrices: boolean;
  syncSizes: boolean;
  onLinked: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StorefrontProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<StorefrontProduct | null>(null);
  const [linking, setLinking] = useState(false);

  async function search() {
    setSearching(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "20");
      params.set("active", "all");
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(
        `/api/komui/storefront/products?${params.toString()}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as
        | StorefrontListResponse
        | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setResults(data.products);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  async function link() {
    if (!selected || linking) return;
    setLinking(true);
    try {
      const res = await fetch("/api/komui/link-offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewId,
          productId: selected.id,
          offerIds,
          updatePrices,
          syncSizes: syncSizes ? "add" : "off",
        }),
      });
      const data = (await res.json()) as
        | LinkOffersResponse
        | { error: string | { message?: string } };
      if (!res.ok) {
        const errVal = "error" in data ? data.error : null;
        const msg =
          typeof errVal === "string"
            ? errVal
            : (errVal && typeof errVal === "object" && errVal.message) ||
              `Ошибка ${res.status}`;
        throw new Error(msg);
      }
      const ok = data as LinkOffersResponse;
      toast.success(
        `Привязано offer-ов: ${ok.applied ?? offerIds.length} — обновляю preview`,
      );
      setSelected(null);
      setQuery("");
      setResults([]);
      onLinked();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLinking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Привязка offer-ов к товару</DialogTitle>
          <DialogDescription>
            {offerIds.length} offer-ов будут добавлены в выбранную карточку
            сайта (offers, SKU, размеры{syncSizes ? " — новые добавятся" : ""}).
            {updatePrices
              ? " Цены сайта будут заменены Ozon-ценами."
              : " Цены сайта не изменятся."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="название, slug, design key"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <Button type="submit" variant="outline" disabled={searching}>
              {searching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Найти
            </Button>
          </form>

          <div className="max-h-72 overflow-y-auto space-y-1">
            {results.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-4">
                {searching ? "Ищем…" : "Введи запрос и нажми «Найти»"}
              </div>
            )}
            {results.map((p) => {
              const active = selected?.id === p.id;
              const thumb =
                p.mainImagePath || p.primaryImageUrl || p.imageUrls?.[0];
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelected(active ? null : p)}
                  className={cn(
                    "w-full flex items-center gap-2 border rounded-md p-2 text-left transition-colors",
                    active ? "bg-primary/10 border-primary" : "hover:bg-accent",
                  )}
                >
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt=""
                      className="h-9 w-9 rounded object-cover border bg-muted shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="h-9 w-9 rounded border bg-muted shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {p.designKey ?? p.slug}
                    </div>
                  </div>
                  <div className="text-xs tabular-nums shrink-0">
                    {formatMoney(p.salePrice)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={link} disabled={!selected || linking}>
            {linking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            Привязать к «{selected?.name ?? "…"}»
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
