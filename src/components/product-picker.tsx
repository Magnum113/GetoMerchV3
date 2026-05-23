"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { toast } from "sonner";
import type {
  Color, Design, DecorationType, DesignType, FabricType, ProductCategory, Size, Product,
} from "@/lib/types";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ProductPickerProps {
  /** Если true, разрешает только пустые товары */
  blankOnly?: boolean;
  /** Если true, разрешает только готовые товары (с дизайном) */
  finishedOnly?: boolean;
  onChange: (product: Product | null) => void;
  className?: string;
}

export function ProductPicker({ blankOnly = false, finishedOnly = false, onChange, className }: ProductPickerProps) {
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [fabrics, setFabrics] = useState<FabricType[]>([]);
  const [colors, setColors] = useState<Color[]>([]);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [designs, setDesigns] = useState<Design[]>([]);
  const [decorationTypes, setDecorationTypes] = useState<DecorationType[]>([]);

  const [categoryId, setCategoryId] = useState<string>("");
  const [fabricId, setFabricId] = useState<string>("");
  const [colorId, setColorId] = useState<string>("");
  const [sizeId, setSizeId] = useState<string>("");
  const [designId, setDesignId] = useState<string>("");
  const [decorationTypeId, setDecorationTypeId] = useState<string>("");

  useEffect(() => {
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
    })();
  }, []);

  useEffect(() => {
    const wantsFinished = !blankOnly && (finishedOnly || (designId && decorationTypeId));
    if (!categoryId || !fabricId || !colorId || !sizeId) {
      onChange(null);
      return;
    }
    if (wantsFinished && (!designId || !decorationTypeId)) {
      onChange(null);
      return;
    }
    (async () => {
      try {
        const p = await api.findOrCreateProduct({
          category_id: categoryId,
          fabric_id: fabricId,
          color_id: colorId,
          size_id: sizeId,
          design_id: blankOnly ? null : designId || null,
          decoration_type_id: blankOnly ? null : decorationTypeId || null,
        });
        onChange(p);
      } catch (e) {
        const msg = errorMessage(e);
        console.warn("ProductPicker findOrCreateProduct failed:", msg);
        toast.error(`Не удалось создать SKU: ${msg}`);
        onChange(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, fabricId, colorId, sizeId, designId, decorationTypeId]);

  const showDesignFields = !blankOnly;
  const selectedDecorationType = decorationTypes.find((d) => d.id === decorationTypeId);
  const selectedDesignType: DesignType | null =
    selectedDecorationType?.slug === "embroidery" ? "embroidery" :
    selectedDecorationType?.slug === "print" ? "print" :
    null;
  const filteredDesigns = selectedDesignType ? designs.filter((d) => d.type === selectedDesignType) : designs;

  return (
    <div className={className ?? "grid grid-cols-2 gap-3"}>
      <div className="space-y-1.5">
        <Label className="text-xs">Тип</Label>
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger><SelectValue placeholder="Футболка / худи" /></SelectTrigger>
          <SelectContent>
            {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Ткань</Label>
        <Select value={fabricId} onValueChange={setFabricId}>
          <SelectTrigger><SelectValue placeholder="Обычная / варёнка" /></SelectTrigger>
          <SelectContent>
            {fabrics.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Цвет</Label>
        <Select value={colorId} onValueChange={setColorId}>
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

      <div className="space-y-1.5">
        <Label className="text-xs">Размер</Label>
        <Select value={sizeId} onValueChange={setSizeId}>
          <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            {sizes.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {showDesignFields && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">Тип украшения</Label>
            <Select value={decorationTypeId} onValueChange={(v) => { setDecorationTypeId(v); setDesignId(""); }}>
              <SelectTrigger><SelectValue placeholder={finishedOnly ? "—" : "(пустая, если не нужен дизайн)"} /></SelectTrigger>
              <SelectContent>
                {decorationTypes.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Дизайн</Label>
            <Select value={designId} onValueChange={setDesignId}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                {filteredDesigns.length === 0 ? (
                  <div className="text-xs text-muted-foreground p-2">Добавьте дизайн в разделе «Дизайны»</div>
                ) : (
                  filteredDesigns.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)
                )}
              </SelectContent>
            </Select>
          </div>
        </>
      )}
    </div>
  );
}
