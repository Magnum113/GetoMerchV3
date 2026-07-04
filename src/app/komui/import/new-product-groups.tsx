"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ImageIcon, Loader2, PackagePlus } from "lucide-react";

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
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, formatMoney } from "@/lib/utils";
import { InfoTip } from "./info-tip";
import type {
  CreateProductFromGroupResponse,
  NewProductGroup,
  PreviewResponse,
} from "@/lib/komui/types";

// Простая транслитерация для слагов из русских названий; латиница проходит
// как есть. Backend требует slug-пары для title/character/collection.
const RU_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya",
};

function slugify(value: string): string {
  const lower = value.trim().toLowerCase();
  let out = "";
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (RU_MAP[ch] !== undefined) out += RU_MAP[ch];
    else if (/[\s._/-]/.test(ch)) out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function ozonDesignSlug(group: NewProductGroup): string {
  const fromOffer = group.offerIds
    .map((offerId) => /^D(\d+)-/i.exec(offerId)?.[1])
    .find(Boolean);
  if (fromOffer) return `d${fromOffer}`;

  const fromVariant = /^var(\d+)$/i.exec(group.ozonVariant ?? "")?.[1];
  if (fromVariant) return `d${fromVariant}`;

  return "";
}

function defaultSiteSlug(group: NewProductGroup): string {
  const base = slugify(group.suggestedName ?? "");
  const design = ozonDesignSlug(group);
  if (base && design && !base.endsWith(`-${design}`)) return `${base}-${design}`;
  if (base) return base;

  // Fallback для старых preview: не показываем пользователю varXX как будто это
  // артикул. Это только URL slug, реальные Ozon offer_id сохраняются отдельно.
  const fallback = (group.slug ?? "").replace(/^var(\d+)-/i, "d$1-");
  return fallback || design;
}

export function NewProductGroupsSection({
  preview,
  onCreated,
}: {
  preview: PreviewResponse;
  onCreated: () => void;
}) {
  const groups = preview.newProductGroups ?? [];
  const [openGroup, setOpenGroup] = useState<NewProductGroup | null>(null);

  if (groups.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Новые карточки</span>
          <Badge variant="secondary" className="tabular-nums">
            {groups.length}
          </Badge>
          <InfoTip text="Новые дизайны из Ozon, для которых на сайте ещё нет карточек. Размеры, фото и цвет возьмутся из Ozon автоматически; название, цену сайта и описание нужно задать вручную." />
        </div>
        <Separator />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const thumb = g.primaryImageUrl ?? g.imageUrls?.[0];
            const key = g.designKey ?? g.slug ?? g.offerIds[0];
            return (
              <div
                key={key}
                className="border rounded-md p-3 flex gap-3 items-start"
              >
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt=""
                    className="h-16 w-16 rounded object-cover border bg-muted shrink-0"
                    loading="lazy"
                  />
                ) : (
                  <div className="h-16 w-16 rounded border bg-muted shrink-0 flex items-center justify-center text-muted-foreground">
                    <ImageIcon className="h-5 w-5" />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-sm font-medium truncate">
                    {g.suggestedName ?? g.designKey ?? "Без названия"}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono truncate">
                    {g.designKey}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {g.sizes.map((s) => (
                      <Badge key={s} variant="outline" className="text-[10px] font-mono">
                        {s}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    Ozon: {formatMoney(g.minOzonPrice ?? 0)}
                    {g.maxOzonPrice != null && g.maxOzonPrice !== g.minOzonPrice
                      ? ` – ${formatMoney(g.maxOzonPrice)}`
                      : ""}
                    {" · "}
                    {g.offerIds.length} SKU
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpenGroup(g)}
                  >
                    <PackagePlus className="h-3.5 w-3.5" /> Создать карточку
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>

      {openGroup && (
        <CreateProductDialog
          group={openGroup}
          previewId={preview.previewId}
          onClose={() => setOpenGroup(null)}
          onCreated={() => {
            setOpenGroup(null);
            onCreated();
          }}
        />
      )}
    </Card>
  );
}

function CreateProductDialog({
  group,
  previewId,
  onClose,
  onCreated,
}: {
  group: NewProductGroup;
  previewId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState(group.suggestedName ?? "");
  const [slug, setSlug] = useState(defaultSiteSlug(group));
  const [salePrice, setSalePrice] = useState("");
  const [regularPrice, setRegularPrice] = useState("");
  const [shortDescription, setShortDescription] = useState("");
  const [description, setDescription] = useState("");
  const [collectionName, setCollectionName] = useState("");
  const [characterName, setCharacterName] = useState("");
  const [animeTitle, setAnimeTitle] = useState("");
  const [designName, setDesignName] = useState("");
  const [tags, setTags] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [sortOrder, setSortOrder] = useState("50");
  const [creating, setCreating] = useState(false);

  const saleNum = Number(salePrice);
  const regularNum = regularPrice === "" ? null : Number(regularPrice);
  const priceInvalid =
    !Number.isFinite(saleNum) ||
    saleNum <= 0 ||
    (regularNum !== null &&
      (!Number.isFinite(regularNum) || regularNum <= saleNum));
  const formInvalid =
    !name.trim() || !description.trim() || priceInvalid || creating;

  async function create() {
    if (formInvalid) return;
    setCreating(true);
    try {
      const product: Record<string, unknown> = {
        name: name.trim(),
        slug: slug.trim() || undefined,
        designKey: group.designKey,
        salePrice: saleNum,
        regularPrice: regularNum,
        shortDescription: shortDescription.trim() || undefined,
        description: description.trim(),
        isActive,
        sortOrder: Number(sortOrder) || 0,
      };
      if (collectionName.trim()) {
        product.collectionName = collectionName.trim();
        const s = slugify(collectionName);
        if (s) product.collectionSlug = s;
      }
      if (characterName.trim()) {
        product.characterName = characterName.trim();
        const s = slugify(characterName);
        if (s) product.characterSlug = s;
      }
      if (animeTitle.trim()) {
        product.animeTitle = animeTitle.trim();
        product.titleName = animeTitle.trim();
        const s = slugify(animeTitle);
        if (s) {
          product.animeSlug = s;
          product.titleSlug = s;
        }
      }
      if (designName.trim()) {
        product.designName = designName.trim();
        const s = slugify(designName);
        if (s) product.designSlug = s;
      }
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tagList.length > 0) product.tags = tagList;

      const res = await fetch("/api/komui/create-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewId,
          offerItemIds: group.itemIds,
          product,
        }),
      });
      const data = (await res.json()) as
        | CreateProductFromGroupResponse
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
      const ok = data as CreateProductFromGroupResponse;
      toast.success(
        `Карточка «${ok.product.name ?? name}» создана — обновляю preview`,
      );
      onCreated();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Новая карточка сайта</DialogTitle>
          <DialogDescription>
            {group.designKey} · размеры {group.sizes.join(", ")} ·{" "}
            {group.offerIds.length} SKU. Цвет, категория, размеры и фото
            возьмутся из Ozon-группы; цена сайта — твоя.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="np-name" className="text-xs">
              Название*
            </Label>
            <Input
              id="np-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="np-slug" className="text-xs">
                URL slug, не артикул
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setSlug(defaultSiteSlug({ ...group, suggestedName: name }))}
              >
                Сгенерировать из названия
              </Button>
            </div>
            <Input
              id="np-slug"
              value={slug}
              onChange={(e) => setSlug(slugify(e.target.value))}
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              Это адрес страницы вида /p/slug. Ozon offer_id/SKU сохраняются
              отдельно и не должны подменяться этим полем.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-sale" className="text-xs">
              Цена сайта, ₽* (Ozon: {formatMoney(group.minOzonPrice ?? 0)})
            </Label>
            <Input
              id="np-sale"
              type="number"
              min={1}
              value={salePrice}
              onChange={(e) => setSalePrice(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-reg" className="text-xs">
              Старая цена (зачёркнутая)
            </Label>
            <Input
              id="np-reg"
              type="number"
              min={1}
              value={regularPrice}
              onChange={(e) => setRegularPrice(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="np-short" className="text-xs">
              Короткое описание
            </Label>
            <Textarea
              id="np-short"
              rows={2}
              value={shortDescription}
              onChange={(e) => setShortDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="np-desc" className="text-xs">
              Полное описание*
            </Label>
            <Textarea
              id="np-desc"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-anime" className="text-xs">
              Аниме / тайтл
            </Label>
            <Input
              id="np-anime"
              value={animeTitle}
              onChange={(e) => setAnimeTitle(e.target.value)}
              placeholder="Jujutsu Kaisen"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-char" className="text-xs">
              Персонаж
            </Label>
            <Input
              id="np-char"
              value={characterName}
              onChange={(e) => setCharacterName(e.target.value)}
              placeholder="Ryomen Sukuna"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-coll" className="text-xs">
              Коллекция
            </Label>
            <Input
              id="np-coll"
              value={collectionName}
              onChange={(e) => setCollectionName(e.target.value)}
              placeholder="Sukuna"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-design" className="text-xs">
              Название дизайна
            </Label>
            <Input
              id="np-design"
              value={designName}
              onChange={(e) => setDesignName(e.target.value)}
              placeholder="Sukuna Tongue"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="np-tags" className="text-xs">
              Теги (через запятую)
            </Label>
            <Input
              id="np-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="anime, jujutsu-kaisen, sukuna, print"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Витрина</Label>
            <label className="flex items-center gap-2 text-sm h-9">
              <Checkbox
                checked={isActive}
                onCheckedChange={(v) => setIsActive(v === true)}
              />
              Активен сразу
            </label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-sort" className="text-xs">
              Порядок сортировки
            </Label>
            <Input
              id="np-sort"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
        </div>

        {priceInvalid && salePrice !== "" && (
          <div className="text-xs text-state-danger-fg">
            Цена сайта должна быть &gt; 0, старая цена — больше цены сайта или
            пустая.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={create} disabled={formInvalid}>
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PackagePlus className="h-4 w-4" />
            )}
            Создать карточку
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
