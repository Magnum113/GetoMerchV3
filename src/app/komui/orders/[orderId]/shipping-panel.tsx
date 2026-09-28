"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OrderShipping, OrderShippingEvent, OrderEffect } from "@/lib/komui/types";
import { formatDate, errorMessage } from "@/lib/utils";
import { ShippingBadge } from "../status-badges";

const labels: Record<string, string> = {
  approve: "Подтвердить готовность",
  sync: "Обновить статус Ozon",
  retry: "Повторить операцию",
  cancel: "Отменить отправление",
  label: "Скачать этикетку PDF",
};
const effectLabels: Record<string, string> = {
  pending: "В очереди", processing: "Выполняется", retry: "Ожидает повтора",
  completed: "Выполнено", needs_review: "Нужна проверка", canceled: "Отменено",
};

export function ShippingPanel({ orderId, shipping, events, effects, onUpdated }: {
  orderId: string;
  shipping?: OrderShipping | null;
  events?: OrderShippingEvent[];
  effects?: OrderEffect[];
  onUpdated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const base = `/api/komui/storefront/orders/${encodeURIComponent(orderId)}/shipping/`;

  async function run(action: string) {
    if (busy) return;
    setBusy(action);
    try {
      const response = await fetch(base + action, action === "label" ? { cache: "no-store" } : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        throw new Error(typeof value?.error === "string" ? value.error : value?.error?.message || "Не удалось выполнить действие. Обновите статус и повторите.");
      }
      if (action === "label") {
        if (!response.headers.get("content-type")?.includes("application/pdf")) throw new Error("Этикетка пока недоступна");
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url; link.download = `komui-ozon-${orderId}.pdf`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } else {
        toast.success(action === "sync" ? "Запрос обновления принят" : "Запрос принят. Результат появится в статусе доставки.");
        setConfirmation(null);
        await onUpdated();
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally { setBusy(null); }
  }

  return <Card><CardContent className="p-4 space-y-4">
    <div className="flex flex-wrap items-center gap-3"><h2 className="text-sm font-medium">Доставка Ozon</h2><ShippingBadge shipping={shipping} /></div>
    <dl className="grid grid-cols-2 gap-3 text-xs">
      <div><dt className="text-muted-foreground">Заказ доставки</dt><dd className="font-mono">{shipping?.orderNumber || "Создаётся"}</dd></div>
      <div><dt className="text-muted-foreground">Номер отправления</dt><dd className="font-mono">{shipping?.number || "—"}</dd></div>
      <div><dt className="text-muted-foreground">Обновлено</dt><dd>{shipping?.updatedAt ? formatDate(shipping.updatedAt) : "—"}</dd></div>
      {shipping?.package && <div><dt className="text-muted-foreground">Посылка по расчёту</dt><dd>{shipping.package.length_mm} × {shipping.package.width_mm} × {shipping.package.height_mm} мм · {shipping.package.weight_g} г</dd></div>}
    </dl>
    {shipping?.error && <p role="alert" className="text-sm text-state-danger-fg">{shipping.error}</p>}
    <p className="text-xs text-muted-foreground">Сверьте вес и габариты собранной посылки с расчётом. При расхождении не подтверждайте готовность — сначала уточните параметры в кабинете Ozon. После подтверждения скачайте и распечатайте этикетку. Приёмка Ozon отобразится отдельно после передачи посылки.</p>
    <div className="flex flex-wrap gap-2">
      {(shipping?.availableActions || []).filter(action => labels[action]).map(action => <Button key={action} variant="outline" disabled={!!busy} onClick={() => {
        if (action === "approve" || action === "cancel") setConfirmation(action);
        else void run(action);
      }}>{busy === action ? "Выполняется…" : labels[action]}</Button>)}
    </div>
    {!!events?.length && <div><h3 className="mb-2 text-xs font-medium">История доставки</h3><ul className="max-h-48 overflow-y-auto space-y-2 text-xs">{events.map((event, index) => <li key={event.id ?? index}>
      {event.statusName || event.status || "Обновление"} {event.statusAt || event.receivedAt ? <span className="text-muted-foreground"> · {formatDate((event.statusAt || event.receivedAt)!)}</span> : null}
    </li>)}</ul></div>}
    {!!effects?.length && <div><h3 className="mb-2 text-xs font-medium">Обработка доставки</h3><ul className="space-y-2 text-xs">{effects.filter(effect => effect.type.startsWith("ozon")).map((effect, index) => <li key={effect.id ?? index}>
      {effectLabels[effect.status] || effect.status} · попыток: {effect.attempts}
      {effect.lastError && <p className="text-state-danger-fg">{effect.lastError}</p>}
    </li>)}</ul></div>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{labels[confirmation || ""]}</DialogTitle><DialogDescription>
        {confirmation === "approve" ? "Подтвердите, что товары собраны и параметры упаковки верны. Ozon проверит баланс и подготовит отправление к отгрузке. После этого получите этикетку." : "Отправим запрос на отмену в Ozon. Если посылка уже передана, она может пойти обратно. Возврат оплаты покупателю выполняется отдельно."}
      </DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setConfirmation(null)}>Назад</Button><Button disabled={!!busy} onClick={() => confirmation && void run(confirmation)}>{busy ? "Выполняется…" : "Подтвердить"}</Button></DialogFooter></DialogContent>
    </Dialog>
  </CardContent></Card>;
}
