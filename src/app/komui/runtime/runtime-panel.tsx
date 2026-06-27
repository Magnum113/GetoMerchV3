"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  RefreshCcw,
  Server,
  ServerOff,
  XCircle,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn, errorMessage, formatDate } from "@/lib/utils";
import {
  runtimeModeLabel,
  runtimeStateLabel,
  type RuntimeMode,
  type RuntimeStatus,
  type RuntimeSwitchResponse,
} from "@/lib/komui/types";

type SwitchOutcome =
  | { kind: "applied"; message: string }
  | { kind: "prepared"; message: string }
  | { kind: "pending"; message: string }
  | { kind: "failed"; message: string };

// Достаём код ошибки из ответа backend независимо от формы (строка,
// {error:{code}}, {code}). Нужно чтобы поймать legacy_origin_unreachable.
function extractErrorCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.error === "string") return d.error;
  if (d.error && typeof d.error === "object") {
    const code = (d.error as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  if (typeof d.code === "string") return d.code;
  return null;
}

const LEGACY_UNREACHABLE_MESSAGE =
  "Сервер не может достучаться до Vercel напрямую — нужен ручной DNS rollback или нужно починить egress/VPN на сервере.";

export function RuntimePanel() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dialogMode, setDialogMode] = useState<RuntimeMode | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [switching, setSwitching] = useState(false);

  const [outcome, setOutcome] = useState<SwitchOutcome | null>(null);
  // Если backend ответил legacy_origin_unreachable — держим legacy кнопку
  // выключенной и показываем красное предупреждение, пока статус не обновится.
  const [legacyUnreachable, setLegacyUnreachable] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStop = useRef<number>(0);

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/komui/runtime", { cache: "no-store" });
      const data = (await res.json()) as RuntimeStatus | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setStatus(data);
      setError(null);
      // Свежий статус с сервера может означать что egress починили — снимаем
      // блокировку legacy кнопки. Если ошибка вернётся снова — снова заблокируем.
      setLegacyUnreachable(false);
      return data;
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg);
      if (!silent) toast.error(msg);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [loadStatus]);

  function stopPolling() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }

  function pollRuntime() {
    stopPolling();
    if (Date.now() >= pollStop.current) {
      // Окно polling кончилось — оставляем последний загруженный статус.
      return;
    }
    pollTimer.current = setTimeout(async () => {
      const s = await loadStatus(true);
      if (s && s.trafficSwitch?.state === "applied") {
        setOutcome({
          kind: "applied",
          message: s.trafficSwitch?.message || "Production switched",
        });
        return;
      }
      pollRuntime();
    }, 2000);
  }

  function openDialog(mode: RuntimeMode) {
    setDialogMode(mode);
    setConfirmText("");
    setReason("");
  }

  async function performSwitch() {
    if (!dialogMode) return;
    if (confirmText.trim().toUpperCase() !== "CONFIRM") return;
    setSwitching(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/komui/runtime/fallback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: dialogMode,
          confirm: true,
          reason: reason.trim() || undefined,
        }),
      });
      const data = (await res.json()) as RuntimeSwitchResponse | { error: string };
      const errorCode = extractErrorCode(data);
      if (!res.ok && res.status !== 202) {
        if (dialogMode === "legacy" && errorCode === "legacy_origin_unreachable") {
          setLegacyUnreachable(true);
          setDialogMode(null);
          setOutcome({ kind: "failed", message: LEGACY_UNREACHABLE_MESSAGE });
          toast.error("Legacy origin недоступен с сервера");
          return;
        }
        const msg =
          ("error" in data && typeof data.error === "string" && data.error) ||
          (data && "error" in data &&
          typeof data.error === "object" && data.error?.message) ||
          (data && "message" in data && typeof (data as { message: unknown }).message === "string"
            ? (data as { message: string }).message
            : null) ||
          `Ошибка ${res.status}`;
        throw new Error(msg);
      }
      const body = data as RuntimeSwitchResponse;
      setDialogMode(null);

      if (res.status === 202 || body.status === "pending") {
        setOutcome({
          kind: "pending",
          message: body.message || "Запрос принят, ждём applied…",
        });
        pollStop.current = Date.now() + 30_000;
        pollRuntime();
        toast.success("Запрос отправлен — опрашиваем статус");
      } else if (body.status === "applied") {
        setOutcome({
          kind: "applied",
          message: body.message || "Production switched",
        });
        toast.success("Production переключён");
        loadStatus(true);
      } else if (body.status === "prepared") {
        setOutcome({
          kind: "prepared",
          message:
            body.message ||
            "Runtime подготовлен, но production vhost ещё не включён",
        });
        toast.warning("Runtime подготовлен, но не применён к live komui.ru");
        loadStatus(true);
      } else {
        setOutcome({
          kind: "failed",
          message: body.message || `Backend вернул статус ${body.status}`,
        });
        toast.error("Переключение не выполнено");
      }
    } catch (e) {
      const msg = errorMessage(e);
      setOutcome({ kind: "failed", message: msg });
      toast.error(msg);
    } finally {
      setSwitching(false);
    }
  }

  const ts = status?.trafficSwitch;
  const trafficSwitchEnabled =
    status?.trafficSwitchEnabled ?? ts?.enabled ?? false;
  const legacyConfigured = ts?.legacyOriginConfigured ?? false;
  const productionVhost = ts?.productionVhostEnabled ?? false;
  const currentMode = ts?.currentMode ?? status?.runtimeMode;

  const switchToServerDisabled =
    switching || !trafficSwitchEnabled || currentMode === "server";
  const switchToLegacyDisabled =
    switching ||
    !trafficSwitchEnabled ||
    !legacyConfigured ||
    legacyUnreachable ||
    currentMode === "legacy";

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="space-y-1">
              <div className="text-sm font-medium">Состояние production</div>
              <div className="text-xs text-muted-foreground">
                {status?.service ?? "komui-backend"} ·{" "}
                {ts?.updatedAt
                  ? `обновлено ${formatDate(ts.updatedAt)}`
                  : "—"}
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => loadStatus()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
              Обновить статус
            </Button>
          </div>

          {error && (
            <div className="text-sm text-state-danger-fg">{error}</div>
          )}

          {status && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatField
                label="Текущий режим"
                value={runtimeModeLabel(currentMode)}
                tone={
                  currentMode === "server"
                    ? "text-state-success-fg"
                    : currentMode === "legacy"
                      ? "text-state-warning-fg"
                      : undefined
                }
              />
              <StatField
                label="State"
                value={runtimeStateLabel(ts?.state)}
                tone={
                  ts?.state === "applied"
                    ? "text-state-success-fg"
                    : ts?.state === "prepared"
                      ? "text-state-warning-fg"
                      : ts?.state === "failed" || ts?.state === "rejected"
                        ? "text-state-danger-fg"
                        : undefined
                }
              />
              <BoolField
                label="Production vhost"
                value={productionVhost}
                trueLabel="включён"
                falseLabel="выключен"
              />
              <BoolField
                label="Legacy origin"
                value={legacyConfigured}
                trueLabel="настроен"
                falseLabel="не настроен"
              />
            </div>
          )}

          {ts?.message && (
            <div className="text-xs text-muted-foreground italic">
              backend: {ts.message}
            </div>
          )}

          {ts?.nginxTest && (
            <div className="text-xs">
              <span className="text-muted-foreground">nginx -t: </span>
              <span
                className={cn(
                  "font-mono",
                  ts.nginxTest === "passed"
                    ? "text-state-success-fg"
                    : "text-state-danger-fg",
                )}
              >
                {ts.nginxTest}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {!productionVhost && status && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-state-warning-fg shrink-0 mt-0.5" />
            <div className="text-sm">
              Production vhost ещё не включён на сервере. Переключение режима
              только подготавливает runtime snippet и{" "}
              <span className="font-medium">не меняет</span> live komui.ru,
              пока DNS не направит сюда трафик.
            </div>
          </CardContent>
        </Card>
      )}

      {legacyUnreachable && (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 bg-state-danger">
            <XCircle className="h-5 w-5 text-state-danger-fg shrink-0 mt-0.5" />
            <div className="text-sm text-state-danger-fg">
              <div className="font-medium">Legacy origin недоступен</div>
              <div className="opacity-90 mt-0.5">{LEGACY_UNREACHABLE_MESSAGE}</div>
            </div>
          </CardContent>
        </Card>
      )}

      {ts?.constraints && ts.constraints.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="text-sm font-medium">Ограничения</div>
            <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-1">
              {ts.constraints.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="text-sm font-medium">Действия</div>
          <Separator />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => openDialog("server")}
              disabled={switchToServerDisabled}
            >
              <Server className="h-4 w-4" />
              Переключить production на сервер
            </Button>
            <Button
              variant="outline"
              onClick={() => openDialog("legacy")}
              disabled={switchToLegacyDisabled}
            >
              <ServerOff className="h-4 w-4" />
              Вернуть на Vercel/Supabase
            </Button>
          </div>
          {!trafficSwitchEnabled && (
            <div className="text-xs text-state-danger-fg">
              traffic switch отключён на сервере
            </div>
          )}
          {trafficSwitchEnabled && !legacyConfigured && (
            <div className="text-xs text-muted-foreground">
              «Вернуть на Vercel/Supabase» доступно после настройки LEGACY_ORIGIN
              на сервере и успешной проверки доступности legacy origin.
            </div>
          )}
          {trafficSwitchEnabled && legacyConfigured && legacyUnreachable && (
            <div className="text-xs text-state-danger-fg">
              Переключение на legacy заблокировано — backend сообщил
              <code className="font-mono"> legacy_origin_unreachable</code>.
              Обновите статус, когда egress/VPN восстановят.
            </div>
          )}
        </CardContent>
      </Card>

      {outcome && <OutcomePanel outcome={outcome} onClear={() => setOutcome(null)} />}

      <Dialog
        open={dialogMode !== null}
        onOpenChange={(open) => {
          if (!open) setDialogMode(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "server"
                ? "Переключить production на сервер"
                : "Вернуть production на Vercel/Supabase"}
            </DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                {dialogMode === "server"
                  ? "Если production DNS уже указывает на новый сервер, komui.ru начнёт обслуживаться новым сервером."
                  : "Если production DNS уже указывает на новый сервер, komui.ru будет проксироваться на legacy Vercel/Supabase."}
              </span>
              <span className="block">
                Это <span className="font-medium">не меняет DNS</span>. Если
                сервер недоступен, нужен ручной DNS rollback.
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="komui-reason" className="text-xs">
                Причина (необязательно, попадёт в audit log)
              </Label>
              <Input
                id="komui-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="manual owner action from admin panel"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="komui-confirm" className="text-xs">
                Введите <span className="font-mono font-semibold">CONFIRM</span>,
                чтобы подтвердить
              </Label>
              <Input
                id="komui-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogMode(null)}>
              Отмена
            </Button>
            <Button
              onClick={performSwitch}
              disabled={
                switching || confirmText.trim().toUpperCase() !== "CONFIRM"
              }
            >
              {switching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowLeftRight className="h-4 w-4" />
              )}
              Подтвердить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatField({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("text-sm font-semibold mt-0.5", tone)}>{value}</div>
    </div>
  );
}

function BoolField({
  label,
  value,
  trueLabel,
  falseLabel,
}: {
  label: string;
  value: boolean;
  trueLabel: string;
  falseLabel: string;
}) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5">
        <Badge
          variant="outline"
          className={cn(
            "border-transparent",
            value
              ? "bg-state-success text-state-success-fg"
              : "bg-state-neutral text-state-neutral-fg",
          )}
        >
          {value ? trueLabel : falseLabel}
        </Badge>
      </div>
    </div>
  );
}

function OutcomePanel({
  outcome,
  onClear,
}: {
  outcome: SwitchOutcome;
  onClear: () => void;
}) {
  const meta =
    outcome.kind === "applied"
      ? {
          tone: "text-state-success-fg",
          bg: "bg-state-success",
          Icon: CheckCircle2,
          spin: false,
          title: "Применено",
        }
      : outcome.kind === "prepared"
        ? {
            tone: "text-state-warning-fg",
            bg: "bg-state-warning",
            Icon: AlertTriangle,
            spin: false,
            title: "Подготовлено, но не применено",
          }
        : outcome.kind === "pending"
          ? {
              tone: "text-state-info-fg",
              bg: "bg-state-info",
              Icon: Loader2,
              spin: true,
              title: "Запрос принят, опрашиваем статус",
            }
          : {
              tone: "text-state-danger-fg",
              bg: "bg-state-danger",
              Icon: XCircle,
              spin: false,
              title: "Не выполнено",
            };
  return (
    <Card>
      <CardContent className={cn("p-4 flex items-start gap-3", meta.bg)}>
        <meta.Icon
          className={cn("h-5 w-5 shrink-0 mt-0.5", meta.tone, meta.spin && "animate-spin")}
        />
        <div className={cn("text-sm space-y-1 flex-1", meta.tone)}>
          <div className="font-medium">{meta.title}</div>
          <div className="opacity-90">{outcome.message}</div>
        </div>
        <Button
          variant="outline"
          onClick={onClear}
          className="shrink-0 bg-background/80"
        >
          Скрыть
        </Button>
      </CardContent>
    </Card>
  );
}
