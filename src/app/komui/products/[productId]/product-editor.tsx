"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ImageIcon,
  Loader2,
  Plus,
  Save,
  Star,
  StarOff,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn, errorMessage, formatDate, formatMoney } from "@/lib/utils";
import type {
  StorefrontPatch,
  StorefrontProduct,
  StorefrontProductResponse,
} from "@/lib/komui/types";

type Draft = {
  name: string;
  description: string;
  shortDescription: string;
  salePrice: string;
  regularPrice: string;
  sizes: string[];
  imageUrls: string[];
  mainImagePath: string | null;
  isActive: boolean;
  sortOrder: string;
};

function draftFrom(p: StorefrontProduct): Draft {
  return {
    name: p.name ?? "",
    description: p.description ?? "",
    shortDescription: p.shortDescription ?? "",
    salePrice: String(p.salePrice ?? ""),
    regularPrice: p.regularPrice != null ? String(p.regularPrice) : "",
    sizes: [...(p.sizes ?? [])],
    imageUrls: [...(p.imageUrls ?? [])],
    mainImagePath: p.mainImagePath ?? null,
    isActive: !!p.isActive,
    sortOrder: p.sortOrder != null ? String(p.sortOrder) : "0",
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buildPatch(orig: StorefrontProduct, d: Draft): StorefrontPatch {
  const patch: StorefrontPatch = {};
  if (d.name.trim() !== (orig.name ?? "")) patch.name = d.name.trim();

  const descNorm = d.description.trim() === "" ? null : d.description;
  if ((orig.description ?? null) !== descNorm) patch.description = descNorm;

  const shortNorm = d.shortDescription.trim() === "" ? null : d.shortDescription;
  if ((orig.shortDescription ?? null) !== shortNorm)
    patch.shortDescription = shortNorm;

  const saleNum = Number(d.salePrice);
  if (Number.isFinite(saleNum) && saleNum !== orig.salePrice)
    patch.salePrice = saleNum;

  const regularNum = d.regularPrice === "" ? null : Number(d.regularPrice);
  const regularOrig = orig.regularPrice ?? null;
  if (regularNum === null) {
    if (regularOrig !== null) patch.regularPrice = null;
  } else if (Number.isFinite(regularNum) && regularNum !== regularOrig) {
    patch.regularPrice = regularNum;
  }

  if (!arraysEqual(d.sizes, orig.sizes ?? [])) patch.sizes = d.sizes;
  if (!arraysEqual(d.imageUrls, orig.imageUrls ?? []))
    patch.imageUrls = d.imageUrls;

  if ((orig.mainImagePath ?? null) !== d.mainImagePath)
    patch.mainImagePath = d.mainImagePath;

  if (orig.isActive !== d.isActive) patch.isActive = d.isActive;

  const sortNum = Number(d.sortOrder);
  if (Number.isFinite(sortNum) && sortNum !== (orig.sortOrder ?? 0))
    patch.sortOrder = sortNum;

  return patch;
}

export function ProductEditor({ productId }: { productId: string }) {
  const [product, setProduct] = useState<StorefrontProduct | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastChanged, setLastChanged] = useState<string[] | null>(null);

  // Локальные поля для chip-input размеров и добавления URL.
  const [sizeInput, setSizeInput] = useState("");
  const [urlInput, setUrlInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/komui/storefront/products/${encodeURIComponent(productId)}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as
        | StorefrontProductResponse
        | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setProduct(data.product);
      setDraft(draftFrom(data.product));
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useMemo(
    () => (product && draft ? buildPatch(product, draft) : {}),
    [product, draft],
  );
  const patchKeys = Object.keys(patch);
  const dirty = patchKeys.length > 0;

  function update<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  }

  function addSize() {
    const raw = sizeInput.trim().toUpperCase();
    if (!raw || !draft) return;
    if (draft.sizes.includes(raw)) {
      setSizeInput("");
      return;
    }
    update("sizes", [...draft.sizes, raw]);
    setSizeInput("");
  }

  function removeSize(s: string) {
    if (!draft) return;
    update(
      "sizes",
      draft.sizes.filter((x) => x !== s),
    );
  }

  function addImage() {
    const raw = urlInput.trim();
    if (!raw || !draft) return;
    if (!/^https?:\/\//i.test(raw)) {
      toast.error("URL должен начинаться с http:// или https://");
      return;
    }
    if (draft.imageUrls.includes(raw)) {
      setUrlInput("");
      return;
    }
    update("imageUrls", [...draft.imageUrls, raw]);
    setUrlInput("");
  }

  function removeImage(idx: number) {
    if (!draft) return;
    const next = draft.imageUrls.filter((_, i) => i !== idx);
    const removed = draft.imageUrls[idx];
    setDraft({
      ...draft,
      imageUrls: next,
      mainImagePath:
        draft.mainImagePath === removed ? null : draft.mainImagePath,
    });
  }

  function moveImage(idx: number, dir: -1 | 1) {
    if (!draft) return;
    const target = idx + dir;
    if (target < 0 || target >= draft.imageUrls.length) return;
    const next = [...draft.imageUrls];
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    update("imageUrls", next);
  }

  function setMain(url: string | null) {
    if (!draft) return;
    update("mainImagePath", url);
  }

  function clearRegularPrice() {
    if (!draft) return;
    update("regularPrice", "");
  }

  async function save() {
    if (!product || !draft || !dirty || saving) return;
    const builtPatch = buildPatch(product, draft);

    // Локальная валидация regularPrice > salePrice, чтобы не гонять зря 400.
    if (
      builtPatch.regularPrice != null &&
      typeof builtPatch.regularPrice === "number"
    ) {
      const sale =
        builtPatch.salePrice != null
          ? builtPatch.salePrice
          : product.salePrice;
      if (builtPatch.regularPrice <= sale) {
        toast.error("Старая цена должна быть больше текущей или пустая");
        return;
      }
    }

    setSaving(true);
    setLastChanged(null);
    try {
      const res = await fetch(
        `/api/komui/storefront/products/${encodeURIComponent(productId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(builtPatch),
        },
      );
      const data = (await res.json()) as
        | StorefrontProductResponse
        | { error: string | { message?: string; code?: string } };
      if (!res.ok) {
        const errVal = "error" in data ? data.error : null;
        const msg =
          typeof errVal === "string"
            ? errVal
            : (errVal && typeof errVal === "object" && errVal.message) ||
              `Ошибка ${res.status}`;
        throw new Error(msg);
      }
      const ok = data as StorefrontProductResponse;
      setProduct(ok.product);
      setDraft(draftFrom(ok.product));
      setLastChanged(ok.changedFields ?? []);
      toast.success(
        ok.changedFields && ok.changedFields.length > 0
          ? `Сохранено · обновлено полей: ${ok.changedFields.length}`
          : "Сохранено",
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Загружаем товар…
      </div>
    );
  }

  if (error || !product || !draft) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={ImageIcon}
            title="Не удалось загрузить товар"
            description={error || "Backend не вернул товар"}
            action={
              <div className="flex gap-2">
                <Button variant="outline" asChild>
                  <Link href="/komui/products">
                    <ArrowLeft className="h-4 w-4" /> К списку
                  </Link>
                </Button>
                <Button onClick={load}>Повторить</Button>
              </div>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="outline" asChild>
            <Link href="/komui/products">
              <ArrowLeft className="h-4 w-4" /> К списку
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate max-w-[60ch]">
              {product.name}
            </div>
            <div className="text-xs text-muted-foreground font-mono truncate max-w-[60ch]">
              {product.slug} · {product.id}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {product.updatedAt && (
            <span className="text-xs text-muted-foreground">
              обновлён {formatDate(product.updatedAt)}
            </span>
          )}
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Сохранить{dirty ? ` (${patchKeys.length})` : ""}
          </Button>
        </div>
      </div>

      {lastChanged && (
        <Card>
          <CardContent className="p-3 text-xs space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-state-success-fg font-medium">
                Сохранено
              </span>
              {lastChanged.length > 0 ? (
                <>
                  <span className="text-muted-foreground">обновлены поля:</span>
                  {lastChanged.map((f) => (
                    <Badge
                      key={f}
                      variant="outline"
                      className="font-mono text-[10px]"
                    >
                      {f}
                    </Badge>
                  ))}
                </>
              ) : (
                <span className="text-muted-foreground">без изменений</span>
              )}
            </div>
            <p className="text-muted-foreground">
              Изменения записаны в Komui API. Публичные статические страницы
              сайта обновятся после prod deploy/rebuild.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid lg:grid-cols-[1fr_360px] gap-5">
        <div className="space-y-5">
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="text-sm font-medium">Текст</div>
              <Separator />
              <div className="space-y-1.5">
                <Label htmlFor="komui-name" className="text-xs">
                  Название
                </Label>
                <Input
                  id="komui-name"
                  value={draft.name}
                  onChange={(e) => update("name", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="komui-short" className="text-xs">
                  Короткое описание
                </Label>
                <Textarea
                  id="komui-short"
                  value={draft.shortDescription}
                  onChange={(e) => update("shortDescription", e.target.value)}
                  rows={2}
                />
                <p className="text-[11px] text-muted-foreground">
                  Используется в листинге и meta-описании. Пусто → null.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="komui-desc" className="text-xs">
                  Полное описание
                </Label>
                <Textarea
                  id="komui-desc"
                  value={draft.description}
                  onChange={(e) => update("description", e.target.value)}
                  rows={6}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="text-sm font-medium">Фото</div>
              <Separator />
              <p className="text-[11px] text-muted-foreground -mt-2">
                Первое фото становится главным, если ниже явно не выбрано
                другое. Меняй порядок стрелками.
              </p>

              {draft.imageUrls.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-6">
                  Пока нет фотографий
                </div>
              )}

              <ul className="space-y-2">
                {draft.imageUrls.map((url, idx) => {
                  const isMain = draft.mainImagePath
                    ? draft.mainImagePath === url
                    : idx === 0;
                  return (
                    <li
                      key={url}
                      className="flex items-center gap-2 border rounded-md p-2"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt=""
                        className="h-14 w-14 object-cover rounded border bg-muted shrink-0"
                        loading="lazy"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono truncate" title={url}>
                          {url}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span>#{idx + 1}</span>
                          {isMain && (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-state-success text-state-success-fg border-transparent"
                            >
                              главное
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => moveImage(idx, -1)}
                          disabled={idx === 0}
                          aria-label="Вверх"
                          title="Поднять"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => moveImage(idx, 1)}
                          disabled={idx === draft.imageUrls.length - 1}
                          aria-label="Вниз"
                          title="Опустить"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => setMain(isMain ? null : url)}
                          aria-label={
                            isMain ? "Снять как главное" : "Сделать главным"
                          }
                          title={
                            isMain
                              ? "Снять как главное (откатить к первому)"
                              : "Сделать главным"
                          }
                        >
                          {isMain ? (
                            <StarOff className="h-3.5 w-3.5" />
                          ) : (
                            <Star className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6 text-state-danger-fg hover:bg-state-danger"
                          onClick={() => removeImage(idx)}
                          aria-label="Удалить"
                          title="Удалить фото"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addImage();
                }}
                className="flex gap-2"
              >
                <Input
                  placeholder="https://ir.ozone.ru/s3/..."
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                />
                <Button type="submit" variant="outline">
                  <Plus className="h-4 w-4" /> Добавить
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="text-sm font-medium">Цена</div>
              <Separator />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="komui-sale" className="text-xs">
                    Текущая
                  </Label>
                  <Input
                    id="komui-sale"
                    type="number"
                    min={0}
                    value={draft.salePrice}
                    onChange={(e) => update("salePrice", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="komui-reg" className="text-xs">
                    Старая (зачёркнутая)
                  </Label>
                  <div className="flex gap-1">
                    <Input
                      id="komui-reg"
                      type="number"
                      min={0}
                      value={draft.regularPrice}
                      onChange={(e) => update("regularPrice", e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={clearRegularPrice}
                      title="Убрать акцию"
                      aria-label="Очистить старую цену"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Цена для чекаута:{" "}
                <span className="font-mono">
                  {formatMoney(Number(draft.salePrice) || 0)}
                </span>
                . Старая цена должна быть больше текущей или пустая.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="text-sm font-medium">Размеры</div>
              <Separator />
              <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                {draft.sizes.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    Размеров нет — чекаут не пропустит
                  </span>
                )}
                {draft.sizes.map((s) => (
                  <Badge
                    key={s}
                    variant="outline"
                    className="font-mono pr-1 gap-1"
                  >
                    {s}
                    <button
                      type="button"
                      onClick={() => removeSize(s)}
                      className="hover:text-state-danger-fg"
                      aria-label={`Удалить ${s}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addSize();
                }}
                className="flex gap-2"
              >
                <Input
                  placeholder="например XL"
                  value={sizeInput}
                  onChange={(e) => setSizeInput(e.target.value)}
                  className="font-mono uppercase"
                />
                <Button type="submit" variant="outline">
                  <Plus className="h-4 w-4" /> Добавить
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="text-sm font-medium">Витрина</div>
              <Separator />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.isActive}
                  onCheckedChange={(v) => update("isActive", v === true)}
                />
                Активен на сайте
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="komui-sort" className="text-xs">
                  Порядок сортировки
                </Label>
                <Input
                  id="komui-sort"
                  type="number"
                  value={draft.sortOrder}
                  onChange={(e) => update("sortOrder", e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Меньше = выше в каталоге.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-2 text-xs">
              <div className="text-sm font-medium">Изменения</div>
              <Separator />
              {dirty ? (
                <div className="flex flex-wrap gap-1">
                  {patchKeys.map((k) => (
                    <Badge
                      key={k}
                      variant="outline"
                      className={cn(
                        "font-mono text-[10px] border-transparent bg-state-info text-state-info-fg",
                      )}
                    >
                      {k}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">
                  Чтобы кнопка «Сохранить» проснулась, поменяй что-нибудь.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
