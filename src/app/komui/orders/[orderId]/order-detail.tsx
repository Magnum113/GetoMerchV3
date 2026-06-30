"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  MapPin,
  PackageCheck,
  Phone,
  Receipt,
  RefreshCcw,
  Truck,
  User,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn, errorMessage, formatDate, formatMoney } from "@/lib/utils";
import {
  canMarkShipped,
  FULFILLMENT_STATUSES,
  fulfillmentStatusLabel,
  moneyFromKopecks,
  type FulfillmentStatus,
  type StorefrontOrderDetailResponse,
  type StorefrontOrderSummary,
} from "@/lib/komui/types";
import {
  CdekBadge,
  FulfillmentBadge,
  PaymentBadge,
} from "../status-badges";

export function OrderDetail({ orderId }: { orderId: string }) {
  const [data, setData] = useState<StorefrontOrderDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [shipOpen, setShipOpen] = useState(false);
  const [shipNote, setShipNote] = useState("");
  const [shipBusy, setShipBusy] = useState(false);

  const [statusOpen, setStatusOpen] = useState<FulfillmentStatus | null>(null);
  const [statusNote, setStatusNote] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/komui/storefront/orders/${encodeURIComponent(orderId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as
        | StorefrontOrderDetailResponse
        | { error: string };
      if (!res.ok || "error" in json) {
        throw new Error(("error" in json && json.error) || `Ошибка ${res.status}`);
      }
      setData(json);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  async function markShipped() {
    if (shipBusy) return;
    setShipBusy(true);
    try {
      const res = await fetch(
        `/api/komui/storefront/orders/${encodeURIComponent(orderId)}/mark-shipped`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(shipNote.trim() ? { note: shipNote.trim() } : {}),
        },
      );
      const json = (await res.json()) as
        | { order: StorefrontOrderSummary }
        | { error: string | { message?: string } };
      if (!res.ok) {
        const errVal = "error" in json ? json.error : null;
        const msg =
          typeof errVal === "string"
            ? errVal
            : (errVal && typeof errVal === "object" && errVal.message) ||
              `Ошибка ${res.status}`;
        throw new Error(msg);
      }
      const ok = json as { order: StorefrontOrderSummary };
      setData((d) => (d ? { ...d, order: { ...d.order, ...ok.order } } : d));
      toast.success("Заказ отмечен как отправленный");
      setShipOpen(false);
      setShipNote("");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setShipBusy(false);
    }
  }

  async function changeStatus(status: FulfillmentStatus) {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      const res = await fetch(
        `/api/komui/storefront/orders/${encodeURIComponent(orderId)}/fulfillment`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            statusNote.trim()
              ? { status, note: statusNote.trim() }
              : { status },
          ),
        },
      );
      const json = (await res.json()) as
        | { order: StorefrontOrderSummary }
        | { error: string | { message?: string } };
      if (!res.ok) {
        const errVal = "error" in json ? json.error : null;
        const msg =
          typeof errVal === "string"
            ? errVal
            : (errVal && typeof errVal === "object" && errVal.message) ||
              `Ошибка ${res.status}`;
        throw new Error(msg);
      }
      const ok = json as { order: StorefrontOrderSummary };
      setData((d) => (d ? { ...d, order: { ...d.order, ...ok.order } } : d));
      toast.success(`Статус: ${fulfillmentStatusLabel(status)}`);
      setStatusOpen(null);
      setStatusNote("");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStatusBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Загружаем заказ…
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={Receipt}
            title="Не удалось загрузить заказ"
            description={error || "Backend не вернул заказ"}
            action={
              <div className="flex gap-2">
                <Button variant="outline" asChild>
                  <Link href="/komui/orders">
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

  const { order, items, paymentAttempts, paymentEvents, cdekShipment, cdekEvents } =
    data;
  const canShip = canMarkShipped(order);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="outline" asChild>
            <Link href="/komui/orders">
              <ArrowLeft className="h-4 w-4" /> К списку
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="text-base font-mono font-semibold">
              {order.orderNumber}
            </div>
            <div className="text-xs text-muted-foreground">
              создан {order.createdAt ? formatDate(order.createdAt) : "—"}
              {order.paidAt && (
                <> · оплачен {formatDate(order.paidAt)}</>
              )}
              {order.shippedAt && (
                <> · отправлен {formatDate(order.shippedAt)}</>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <PaymentBadge status={order.paymentStatus} />
          <FulfillmentBadge status={order.fulfillmentStatus} />
          <Button variant="outline" onClick={load}>
            <RefreshCcw className="h-4 w-4" /> Обновить
          </Button>
          <Button onClick={() => setShipOpen(true)} disabled={!canShip}>
            <PackageCheck className="h-4 w-4" /> Отправил заказ
          </Button>
        </div>
      </div>

      {!canShip && order.paymentStatus !== "paid" &&
        order.fulfillmentStatus !== "shipped" &&
        order.fulfillmentStatus !== "delivered" && (
          <Card>
            <CardContent className="p-3 text-sm flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-state-warning-fg mt-0.5 shrink-0" />
              <span>
                Кнопка «Отправил» включится, когда платёж будет{" "}
                <code className="font-mono">paid</code> или{" "}
                <code className="font-mono">authorized</code>. Сейчас:{" "}
                <code className="font-mono">{order.paymentStatus}</code>.
              </span>
            </CardContent>
          </Card>
        )}

      <div className="grid lg:grid-cols-[1fr_360px] gap-5">
        <div className="space-y-5">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Состав заказа</div>
                <div className="text-xs text-muted-foreground">
                  {order.itemCount ?? items?.length ?? 0} шт ·{" "}
                  {order.lineCount ?? items?.length ?? 0} позиций
                </div>
              </div>
              <Separator />
              {!items || items.length === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-4">
                  Backend не вернул items
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Товар</TableHead>
                      <TableHead className="w-16">Размер</TableHead>
                      <TableHead className="w-16 text-right">Кол-во</TableHead>
                      <TableHead className="w-28 text-right">Цена</TableHead>
                      <TableHead className="w-28 text-right">Сумма</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((it, idx) => {
                      const unit = moneyFromKopecks(it.unitPrice);
                      const totalLine = moneyFromKopecks(it.totalPrice);
                      return (
                        <TableRow key={it.id ?? idx}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {it.imageUrl && (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  src={it.imageUrl}
                                  alt=""
                                  className="h-10 w-10 rounded object-cover border bg-muted"
                                  loading="lazy"
                                />
                              )}
                              <div className="min-w-0">
                                <div className="text-sm truncate max-w-[280px]">
                                  {it.name ?? "—"}
                                </div>
                                {it.slug && (
                                  <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[280px]">
                                    {it.slug}
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono">
                            {it.size ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {it.quantity ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {unit != null ? formatMoney(unit) : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {totalLine != null ? formatMoney(totalLine) : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm font-medium">Платёж</div>
              <Separator />
              <div className="grid grid-cols-2 gap-3 text-xs">
                <Field label="Статус">
                  <PaymentBadge status={order.paymentStatus} />
                </Field>
                <Field label="Последняя ошибка">
                  {order.latestPayment?.errorMessage ? (
                    <span className="text-state-danger-fg">
                      {order.latestPayment.errorMessage}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Field>
                <Field label="Провайдер">
                  <span className="font-mono">
                    {order.latestPayment?.providerStatus ?? "—"}
                  </span>
                </Field>
                <Field label="Оплачен">
                  {order.paidAt ? formatDate(order.paidAt) : "—"}
                </Field>
              </div>

              {paymentAttempts && paymentAttempts.length > 0 && (
                <>
                  <div className="text-xs font-medium text-muted-foreground mt-2">
                    Попытки оплаты
                  </div>
                  <ul className="text-xs space-y-1">
                    {paymentAttempts.map((a, i) => (
                      <li
                        key={a.id ?? i}
                        className="flex flex-wrap gap-2 items-center"
                      >
                        <span className="font-mono">{a.status ?? "?"}</span>
                        {a.amount != null && (
                          <span className="tabular-nums">
                            {formatMoney(moneyFromKopecks(a.amount) ?? 0)}
                          </span>
                        )}
                        {a.errorMessage && (
                          <span className="text-state-danger-fg">
                            {a.errorMessage}
                          </span>
                        )}
                        {a.updatedAt && (
                          <span className="text-muted-foreground">
                            {formatDate(a.updatedAt)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {paymentEvents && paymentEvents.length > 0 && (
                <>
                  <div className="text-xs font-medium text-muted-foreground mt-2">
                    Webhook-события
                  </div>
                  <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
                    {paymentEvents.map((ev, i) => (
                      <li
                        key={ev.id ?? i}
                        className="flex flex-wrap gap-2 items-center"
                      >
                        <span className="font-mono">{ev.type ?? "?"}</span>
                        {ev.status && (
                          <span className="text-muted-foreground">
                            {ev.status}
                          </span>
                        )}
                        {ev.receivedAt && (
                          <span className="text-muted-foreground tabular-nums">
                            {formatDate(ev.receivedAt)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm font-medium flex items-center gap-2">
                <Truck className="h-4 w-4" /> СДЭК
              </div>
              <Separator />
              {!cdekShipment && !order.cdek?.number ? (
                <div className="text-xs text-muted-foreground">
                  Накладная не создана
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <Field label="Статус">
                    <CdekBadge status={cdekShipment?.status ?? order.cdek?.status} />
                  </Field>
                  <Field label="Номер">
                    <span className="font-mono">
                      {cdekShipment?.number ?? order.cdek?.number ?? "—"}
                    </span>
                  </Field>
                  <Field label="UUID">
                    <span className="font-mono truncate block">
                      {cdekShipment?.uuid ?? order.cdek?.uuid ?? "—"}
                    </span>
                  </Field>
                  <Field label="Ошибка">
                    {cdekShipment?.errorMessage ?? order.cdek?.errorMessage ? (
                      <span className="text-state-danger-fg">
                        {cdekShipment?.errorMessage ?? order.cdek?.errorMessage}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Field>
                </div>
              )}

              {cdekEvents && cdekEvents.length > 0 && (
                <>
                  <div className="text-xs font-medium text-muted-foreground mt-2">
                    События СДЭК
                  </div>
                  <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
                    {cdekEvents.map((ev, i) => (
                      <li
                        key={ev.id ?? i}
                        className="flex flex-wrap gap-2 items-center"
                      >
                        <span className="font-mono">{ev.type ?? "?"}</span>
                        {ev.status && (
                          <span className="text-muted-foreground">
                            {ev.status}
                          </span>
                        )}
                        {ev.receivedAt && (
                          <span className="text-muted-foreground tabular-nums">
                            {formatDate(ev.receivedAt)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm font-medium">Сумма</div>
              <Separator />
              <SumRow label="Товары" v={order.amounts?.subtotal} />
              {order.amounts?.discount ? (
                <SumRow label="Скидка" v={-Math.abs(order.amounts.discount)} negative />
              ) : null}
              <SumRow label="Доставка" v={order.amounts?.delivery} />
              <Separator />
              <SumRow label="Итого" v={order.amounts?.total} strong />
              {order.promoCode && (
                <div className="text-[11px] text-muted-foreground">
                  Промокод:{" "}
                  <span className="font-mono">{order.promoCode}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm font-medium flex items-center gap-2">
                <User className="h-4 w-4" /> Клиент
              </div>
              <Separator />
              <Field label="Имя">
                {[order.customer?.firstName, order.customer?.lastName]
                  .filter(Boolean)
                  .join(" ") || (
                  <span className="text-muted-foreground italic">—</span>
                )}
              </Field>
              <Field label="Телефон">
                {order.customer?.phone ? (
                  <a
                    href={`tel:${order.customer.phone}`}
                    className="font-mono inline-flex items-center gap-1 hover:underline"
                  >
                    <Phone className="h-3 w-3" /> {order.customer.phone}
                  </a>
                ) : (
                  "—"
                )}
              </Field>
              {order.customer?.email && (
                <Field label="Email">
                  <span className="font-mono">{order.customer.email}</span>
                </Field>
              )}
              <Field label="Маркетинг">
                {order.customer?.marketingConsent ? (
                  <Badge
                    variant="outline"
                    className="border-transparent bg-state-success text-state-success-fg text-[10px]"
                  >
                    согласие
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">нет</span>
                )}
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm font-medium flex items-center gap-2">
                <MapPin className="h-4 w-4" /> Доставка
              </div>
              <Separator />
              <Field label="Способ">
                <span className="font-mono uppercase">
                  {order.delivery?.provider ?? "—"}
                </span>
              </Field>
              <Field label="Город">{order.delivery?.city ?? "—"}</Field>
              <Field label="Адрес / ПВЗ">
                <div className="text-xs">
                  {order.delivery?.address ?? "—"}
                </div>
                {order.delivery?.pointCode && (
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {order.delivery.pointCode}
                  </div>
                )}
              </Field>
              {order.delivery?.hours && (
                <Field label="Часы работы">{order.delivery.hours}</Field>
              )}
              {order.delivery?.eta && (
                <Field label="ETA">{order.delivery.eta}</Field>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm font-medium">Статус обработки</div>
              <Separator />
              <div className="flex flex-wrap gap-1.5">
                {FULFILLMENT_STATUSES.map((s) => (
                  <Pill
                    key={s}
                    shape="square"
                    active={order.fulfillmentStatus === s}
                    onClick={() => {
                      if (order.fulfillmentStatus === s) return;
                      setStatusNote(order.fulfillmentNote ?? "");
                      setStatusOpen(s);
                    }}
                  >
                    {fulfillmentStatusLabel(s)}
                  </Pill>
                ))}
              </div>
              {order.fulfillmentNote && (
                <div className="text-[11px] text-muted-foreground bg-muted/40 rounded p-2">
                  Заметка: {order.fulfillmentNote}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">
                Клик по статусу спросит подтверждение и заметку.{" "}
                <span className="font-medium">paymentStatus</span> отсюда не
                трогается — им управляет Т-Банк webhook.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={shipOpen} onOpenChange={setShipOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Отметить как отправленный</DialogTitle>
            <DialogDescription>
              Поставлю <code className="font-mono">fulfillment_status = shipped</code>{" "}
              и <code className="font-mono">shipped_at = now()</code>. paymentStatus
              не трогается.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="komui-ship-note" className="text-xs">
              Заметка (необязательно)
            </Label>
            <Textarea
              id="komui-ship-note"
              value={shipNote}
              onChange={(e) => setShipNote(e.target.value)}
              rows={3}
              placeholder="Передано в СДЭК, трек-номер ..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShipOpen(false)}>
              Отмена
            </Button>
            <Button onClick={markShipped} disabled={shipBusy}>
              {shipBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PackageCheck className="h-4 w-4" />
              )}
              Подтвердить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={statusOpen !== null}
        onOpenChange={(open) => {
          if (!open) setStatusOpen(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Сменить статус на{" "}
              {statusOpen ? fulfillmentStatusLabel(statusOpen) : ""}
            </DialogTitle>
            <DialogDescription>
              {statusOpen === "shipped" || statusOpen === "delivered"
                ? "Заполню shipped_at / delivered_at, если ещё пусто."
                : "paymentStatus не трогается — он принадлежит Т-Банк webhook."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="komui-status-note" className="text-xs">
              Заметка (попадёт в audit log)
            </Label>
            <Textarea
              id="komui-status-note"
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusOpen(null)}>
              Отмена
            </Button>
            <Button
              onClick={() => statusOpen && changeStatus(statusOpen)}
              disabled={statusBusy}
            >
              {statusBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Подтвердить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xs">{children}</div>
    </div>
  );
}

function SumRow({
  label,
  v,
  strong,
  negative,
}: {
  label: string;
  v?: number | null;
  strong?: boolean;
  negative?: boolean;
}) {
  const money = moneyFromKopecks(v ?? null);
  return (
    <div
      className={cn(
        "flex items-center justify-between text-xs",
        strong && "text-sm font-semibold",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tabular-nums",
          negative && "text-state-danger-fg",
        )}
      >
        {money != null ? formatMoney(money) : "—"}
      </span>
    </div>
  );
}
