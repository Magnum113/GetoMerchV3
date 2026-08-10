"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, PackagePlus, RefreshCw, Settings2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { postMarkingMutation } from "@/lib/marking/client";
import type { SuzCodeOrder, SuzPoolForecast } from "@/lib/marking/repositories/suz-orders";
import { formatDate } from "@/lib/utils";

type Workspace = {
  forecasts: SuzPoolForecast[];
  orders: SuzCodeOrder[];
  runtime: {
    enabled: boolean;
    draftEnabled: boolean;
    writeEnabled: boolean;
    signerEnabled: boolean;
    contour: "sandbox" | "production";
    omsConfigured: boolean;
  };
};

const EMPTY: Workspace = {
  forecasts: [],
  orders: [],
  runtime: {
    enabled: false,
    draftEnabled: false,
    writeEnabled: false,
    signerEnabled: false,
    contour: "sandbox",
    omsConfigured: false,
  },
};

export function SuzOrdersPanel() {
  const [workspace, setWorkspace] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [policy, setPolicy] = useState<SuzPoolForecast | null>(null);
  const [draft, setDraft] = useState<SuzPoolForecast | null>(null);
  const [approval, setApproval] = useState<SuzCodeOrder | null>(null);
  const [cancellation, setCancellation] = useState<SuzCodeOrder | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/admin/marking/suz", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: Workspace;
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.ok || !payload.data) {
        throw new Error(payload?.error?.message ?? "Не удалось загрузить заказы КМ");
      }
      setWorkspace(payload.data);
    } catch (error) {
      if (!silent) toast.error(message(error, "Не удалось загрузить заказы КМ"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function mutate(operation: string, body: Record<string, unknown>, success: string) {
    setAction(`${operation}:${String(body.orderId ?? body.tradeItemId ?? "global")}`);
    try {
      await postMarkingMutation("/api/admin/marking/suz", { operation, ...body });
      toast.success(success);
      setPolicy(null);
      setDraft(null);
      setApproval(null);
      setCancellation(null);
      setCancelReason("");
      await load(true);
    } catch (error) {
      toast.error(message(error, "Операция СУЗ не выполнена"));
    } finally {
      setAction(null);
    }
  }

  if (loading) {
    return <div className="flex min-h-48 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 animate-spin" />Загрузка заказов КМ</div>;
  }

  const lowCount = workspace.forecasts.filter((item) => item.poolLow).length;
  const reviewCount = workspace.orders.filter((item) => item.status === "manual_review").length;
  const openCount = workspace.orders.filter((item) => !["completed", "cancelled", "rejected"].includes(item.status)).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Metric label="GTIN ниже порога" value={lowCount} alert={lowCount > 0} />
          <Metric label="Открытые заказы" value={openCount} />
          <Metric label="Ручная сверка" value={reviewCount} alert={reviewCount > 0} />
          <span className="text-muted-foreground">
            Контур: <span className="font-medium text-foreground">{workspace.runtime.contour === "production" ? "боевой" : "песочница"}</span>
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw />Обновить
        </Button>
      </div>

      {!workspace.runtime.writeEnabled && (
        <div className="flex items-start gap-2 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Прогноз и черновики доступны, но отправка в СУЗ выключена.
            {!workspace.runtime.signerEnabled ? " Signer не включён." : ""}
            {!workspace.runtime.omsConfigured ? " OMS ID или OMS connection не настроены." : ""}
          </span>
        </div>
      )}

      <section>
        <div className="mb-2">
          <h2 className="text-base font-semibold">Прогноз пула по GTIN</h2>
          <p className="text-sm text-muted-foreground">Карантин и КМ без подтверждённого REPORT_UTILIZE не считаются доступным остатком.</p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>GTIN</TableHead>
                <TableHead>Пул</TableHead>
                <TableHead>Потребность</TableHead>
                <TableHead>Политика</TableHead>
                <TableHead>Рекомендация</TableHead>
                <TableHead className="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspace.forecasts.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">Нет включённых проверенных GTIN</TableCell></TableRow>
              ) : workspace.forecasts.map((item) => (
                <TableRow key={item.tradeItemId}>
                  <TableCell>
                    <div className="font-mono text-xs">{item.gtin}</div>
                    <Badge variant={item.policyEnabled ? "secondary" : "outline"} className="mt-1">
                      {item.policyEnabled ? "Автопрогноз включён" : "Политика выключена"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className={item.poolLow ? "font-semibold text-red-700" : "font-semibold"}>{item.available} доступно</div>
                    <div className="text-xs text-muted-foreground">{item.pendingUtilisation} ждут отчёт · {item.quarantined} карантин</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div>{item.activeDemand} активных заказов</div>
                    <div className="text-xs text-muted-foreground">{item.inbound} уже заказано · {item.averageDailyUse}/день</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div>мин. {item.minimum} · цель {item.target}</div>
                    <div className="text-xs text-muted-foreground">срок {item.leadTimeHours} ч · лимит {item.orderLimit}</div>
                  </TableCell>
                  <TableCell>
                    <span className={item.recommendedQuantity > 0 ? "text-lg font-semibold" : "text-muted-foreground"}>{item.recommendedQuantity}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" title="Настроить политику" onClick={() => setPolicy(item)}>
                        <Settings2 />
                      </Button>
                      <Button size="sm" disabled={!workspace.runtime.draftEnabled || Boolean(action)} onClick={() => setDraft(item)}>
                        <PackagePlus />Черновик
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <div className="mb-2">
          <h2 className="text-base font-semibold">Заказы кодов маркировки</h2>
          <p className="text-sm text-muted-foreground">Отправка выполняется только после явного подтверждения черновика.</p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Создан</TableHead>
                <TableHead>GTIN</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Количество</TableHead>
                <TableHead>СУЗ</TableHead>
                <TableHead className="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspace.orders.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">Заказов КМ ещё нет</TableCell></TableRow>
              ) : workspace.orders.map((item) => (
                <TableRow key={item.orderId}>
                  <TableCell className="whitespace-nowrap text-sm">{formatDate(item.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{item.gtin}</TableCell>
                  <TableCell className="max-w-64">
                    <SuzStatus status={item.status} />
                    {item.alertCodes.length > 0 && <div className="mt-1 text-xs text-red-700">{item.alertCodes.map(alertLabel).join(", ")}</div>}
                    {item.manualReviewReason && <div className="mt-1 text-xs text-red-700">{item.manualReviewReason}</div>}
                    {item.errorMessage && <div className="mt-1 text-xs text-muted-foreground">{item.errorMessage}</div>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div>{item.availableQuantity} доступно из {item.requestedQuantity}</div>
                    <div className="text-xs text-muted-foreground">получено {item.receivedQuantity} · загружено {item.ingestedQuantity}</div>
                  </TableCell>
                  <TableCell className="max-w-56 text-xs">
                    <div>{item.remoteOrderStatus ?? "Не отправлен"}</div>
                    <div className="text-muted-foreground">{item.externalOrderId ?? "—"}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {item.status === "draft" && (
                        <Button size="sm" disabled={!workspace.runtime.writeEnabled || Boolean(action)} onClick={() => setApproval(item)}>
                          <Check />Подтвердить
                        </Button>
                      )}
                      {["draft", "approved"].includes(item.status) && (
                        <Button size="icon" variant="ghost" title="Отменить черновик" disabled={Boolean(action)} onClick={() => setCancellation(item)}>
                          <X />
                        </Button>
                      )}
                      {["submitted", "ready", "receiving", "awaiting_utilisation"].includes(item.status) && (
                        <Button size="icon" variant="ghost" title="Проверить СУЗ" disabled={!workspace.runtime.writeEnabled || Boolean(action)} onClick={() => void mutate("poll", { orderId: item.orderId }, "Проверка СУЗ поставлена в очередь")}>
                          <RefreshCw className={action === `poll:${item.orderId}` ? "animate-spin" : ""} />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <PolicyDialog item={policy} busy={Boolean(action)} onOpenChange={(open) => !open && setPolicy(null)} onSave={(values) => policy && mutate("update_policy", {
        tradeItemId: policy.tradeItemId,
        expectedRevision: policy.policyRevision,
        ...values,
      }, "Политика пула обновлена")} />
      <DraftDialog item={draft} busy={Boolean(action)} onOpenChange={(open) => !open && setDraft(null)} onCreate={(quantity) => draft && mutate("create_draft", {
        tradeItemId: draft.tradeItemId,
        quantity,
      }, "Черновик заказа КМ создан")} />
      <Dialog open={Boolean(approval)} onOpenChange={(open) => !open && setApproval(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Отправить заказ КМ в СУЗ?</DialogTitle><DialogDescription>Будет создан внешний заказ на {approval?.requestedQuantity ?? 0} кодов. Автоматического повтора при неизвестном результате отправки не будет.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproval(null)}>Отмена</Button>
            <Button disabled={Boolean(action)} onClick={() => approval && void mutate("approve", { orderId: approval.orderId, expectedRevision: approval.revision }, "Заказ КМ поставлен на отправку")}>Подтвердить и отправить</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(cancellation)} onOpenChange={(open) => !open && setCancellation(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Отменить заказ КМ</DialogTitle><DialogDescription>Отмена доступна только до начала внешней отправки.</DialogDescription></DialogHeader>
          <div><Label htmlFor="suz-cancel-reason">Причина</Label><Textarea id="suz-cancel-reason" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancellation(null)}>Назад</Button>
            <Button variant="destructive" disabled={cancelReason.trim().length === 0 || Boolean(action)} onClick={() => cancellation && void mutate("cancel", { orderId: cancellation.orderId, expectedRevision: cancellation.revision, reason: cancelReason.trim() }, "Заказ КМ отменён")}>Отменить заказ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PolicyDialog({ item, busy, onOpenChange, onSave }: {
  item: SuzPoolForecast | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (value: { enabled: boolean; minimum: number; target: number; leadTimeHours: number; averageWindowDays: number; orderLimit: number }) => void;
}) {
  const [values, setValues] = useState({ enabled: false, minimum: 5, target: 20, leadTimeHours: 24, averageWindowDays: 30, orderLimit: 1000 });
  useEffect(() => {
    if (item) setValues({ enabled: item.policyEnabled, minimum: item.minimum, target: item.target, leadTimeHours: item.leadTimeHours, averageWindowDays: item.averageWindowDays, orderLimit: item.orderLimit });
  }, [item]);
  const number = (key: keyof Omit<typeof values, "enabled">, value: string) => setValues((state) => ({ ...state, [key]: Number(value) }));
  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Политика пула КМ</DialogTitle><DialogDescription className="font-mono">{item?.gtin}</DialogDescription></DialogHeader>
        <div className="flex items-center gap-2"><Checkbox id="suz-policy-enabled" checked={values.enabled} onCheckedChange={(checked) => setValues((state) => ({ ...state, enabled: checked === true }))} /><Label htmlFor="suz-policy-enabled">Учитывать в прогнозе пополнения</Label></div>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Минимум" value={values.minimum} onChange={(value) => number("minimum", value)} />
          <NumberField label="Целевой остаток" value={values.target} onChange={(value) => number("target", value)} />
          <NumberField label="Срок пополнения, ч" value={values.leadTimeHours} onChange={(value) => number("leadTimeHours", value)} />
          <NumberField label="Окно расхода, дней" value={values.averageWindowDays} onChange={(value) => number("averageWindowDays", value)} />
          <NumberField label="Лимит одного заказа" value={values.orderLimit} onChange={(value) => number("orderLimit", value)} />
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button><Button disabled={busy || values.target < values.minimum} onClick={() => onSave(values)}>Сохранить</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftDialog({ item, busy, onOpenChange, onCreate }: { item: SuzPoolForecast | null; busy: boolean; onOpenChange: (open: boolean) => void; onCreate: (quantity: number) => void }) {
  const [quantity, setQuantity] = useState(1);
  useEffect(() => { if (item) setQuantity(Math.max(1, item.recommendedQuantity)); }, [item]);
  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Создать черновик заказа КМ</DialogTitle><DialogDescription>GTIN {item?.gtin}. Черновик не отправляется в СУЗ до отдельного подтверждения.</DialogDescription></DialogHeader>
        <NumberField label={`Количество, максимум ${item?.orderLimit ?? 0}`} value={quantity} onChange={(value) => setQuantity(Number(value))} />
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button><Button disabled={busy || quantity < 1 || quantity > (item?.orderLimit ?? 0)} onClick={() => onCreate(quantity)}>Создать черновик</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  const id = `suz-${label.replace(/[^A-Za-zА-Яа-я0-9]+/g, "-").toLowerCase()}`;
  return <div><Label htmlFor={id}>{label}</Label><Input id={id} type="number" min={0} step={1} value={Number.isFinite(value) ? value : ""} onChange={(event) => onChange(event.target.value)} /></div>;
}

function Metric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return <span className="text-muted-foreground">{label}: <span className={alert ? "font-semibold text-red-700" : "font-semibold text-foreground"}>{value}</span></span>;
}

function SuzStatus({ status }: { status: string }) {
  const terminal = status === "completed";
  const warning = status === "manual_review" || status === "rejected";
  return <Badge variant={warning ? "destructive" : terminal ? "default" : "secondary"}>{statusLabel(status)}</Badge>;
}

function statusLabel(status: string) {
  return ({ draft: "Черновик", approved: "Подтверждён", submitting: "Отправляется", submitted: "Формируется", ready: "Готов к получению", receiving: "Получение блоков", awaiting_utilisation: "Ждёт REPORT_UTILIZE", completed: "Коды доступны", rejected: "Отклонён", manual_review: "Ручная сверка", cancelled: "Отменён" } as Record<string, string>)[status] ?? status;
}

function alertLabel(code: string) {
  return ({ quantity_mismatch: "расхождение количества", order_stuck: "заказ долго формируется", utilisation_stuck: "нет отчёта о нанесении" } as Record<string, string>)[code] ?? code;
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
