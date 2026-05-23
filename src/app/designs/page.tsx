"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { Design } from "@/lib/types";
import { Palette, Plus, Trash2, Pencil } from "lucide-react";
import { formatDate, errorMessage } from "@/lib/utils";

export default function DesignsPage() {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<Design | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  async function reload() { setDesigns(await api.listDesigns()); setLoading(false); }
  useEffect(() => { reload(); }, []);

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
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition">
                  <Button size="icon" variant="secondary" className="h-7 w-7" onClick={() => setEdit(d)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="secondary" className="h-7 w-7" onClick={async () => {
                    if (!confirm("Удалить дизайн?")) return;
                    try { await api.deleteDesign(d.id); toast.success("Удалено"); reload(); }
                    catch (e) { toast.error(errorMessage(e)); }
                  }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <CardContent className="p-3">
                <div className="font-medium truncate">{d.name}</div>
                {d.description && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{d.description}</div>}
                <div className="text-[10px] text-muted-foreground mt-2">{formatDate(d.created_at)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <DesignDialog open={openCreate} onOpenChange={setOpenCreate} onDone={reload} />
      <DesignDialog design={edit ?? undefined} open={!!edit} onOpenChange={(v) => !v && setEdit(null)} onDone={reload} />
    </div>
  );
}

function DesignDialog({ design, open, onOpenChange, onDone }: { design?: Design; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(design?.name ?? "");
      setDescription(design?.description ?? "");
      setImageUrl(design?.image_url ?? "");
    }
  }, [open, design]);

  async function submit() {
    if (!name.trim()) return toast.error("Введите название");
    setBusy(true);
    try {
      if (design) {
        await api.updateDesign(design.id, { name, description: description || null, image_url: imageUrl || null });
        toast.success("Сохранено");
      } else {
        await api.createDesign({ name, description: description || undefined, image_url: imageUrl || undefined });
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
