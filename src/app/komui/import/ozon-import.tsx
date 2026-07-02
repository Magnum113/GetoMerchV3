"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Download,
  Loader2,
  RefreshCcw,
  Search,
  Store,
  XCircle,
} from "lucide-react";

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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
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
import { cn, errorMessage, formatDate, formatMoney } from "@/lib/utils";
import {
  hasPreviewWarning,
  JOB_STATUS_LABELS,
  previewWarningText,
  statusLabel,
  type DiffField,
  type ImportStartResponse,
  type ImportTargets,
  type ItemDiff,
  type ItemStatus,
  type JobResponse,
  type PreviewItem,
  type PreviewResponse,
} from "@/lib/komui/types";

type FilterKey =
  | "all"
  | "matched"
  | "unmatched"
  | "actionable"
  | "noop"
  | "conflict";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "actionable", label: "К действию" },
  { key: "matched", label: "Сопоставлены" },
  { key: "unmatched", label: "Не сопоставлены" },
  { key: "noop", label: "Без изменений" },
  { key: "conflict", label: "Конфликты" },
];

// Группируем action по семантике. Backend выдаёт глаголы вроде
// "update_storefront_offer", "create_storefront_product", "noop" — нам важно
// отделить create от update, чтобы в сводке честно показать что произойдёт.
function classifyAction(action: string): "create" | "update" | "noop" | "other" {
  const a = action.toLowerCase();
  if (a === "noop" || a === "skip") return "noop";
  if (
    a.startsWith("create_") ||
    a.startsWith("insert_") ||
    a.startsWith("add_")
  )
    return "create";
  if (
    a.startsWith("update_") ||
    a.startsWith("upsert_") ||
    a.startsWith("sync_") ||
    a.startsWith("apply_")
  )
    return "update";
  return "other";
}

type ActionableBreakdown = {
  postgresCreate: number;
  postgresUpdate: number;
  postgresOther: number;
  supabaseCreate: number;
  supabaseUpdate: number;
  supabaseOther: number;
  newProducts: number; // позиции без targetProduct
};

function computeBreakdown(items: PreviewItem[]): ActionableBreakdown {
  const acc: ActionableBreakdown = {
    postgresCreate: 0,
    postgresUpdate: 0,
    postgresOther: 0,
    supabaseCreate: 0,
    supabaseUpdate: 0,
    supabaseOther: 0,
    newProducts: 0,
  };
  for (const it of items) {
    if (!it.targetProduct) acc.newProducts += 1;
    for (const a of it.plannedActions) {
      const cls = classifyAction(a.action);
      if (cls === "noop") continue;
      if (a.target === "serverPostgres") {
        if (cls === "create") acc.postgresCreate += 1;
        else if (cls === "update") acc.postgresUpdate += 1;
        else acc.postgresOther += 1;
      } else if (a.target === "supabase") {
        if (cls === "create") acc.supabaseCreate += 1;
        else if (cls === "update") acc.supabaseUpdate += 1;
        else acc.supabaseOther += 1;
      }
    }
  }
  return acc;
}

function statusBadgeClasses(status: ItemStatus): string {
  switch (status) {
    case "matched":
      return "bg-state-success text-state-success-fg";
    case "unmatched":
      return "bg-state-warning text-state-warning-fg";
    case "conflict":
      return "bg-state-danger text-state-danger-fg";
    case "noop":
    case "skipped":
      return "bg-state-neutral text-state-neutral-fg";
    default:
      return "bg-state-info text-state-info-fg";
  }
}

function isActionable(item: PreviewItem): boolean {
  return item.plannedActions.some((a) => a.action !== "noop");
}

function matchesFilter(item: PreviewItem, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "actionable") return isActionable(item);
  if (filter === "matched") return item.status === "matched";
  if (filter === "unmatched") return item.status === "unmatched";
  if (filter === "noop")
    return item.status === "noop" || item.status === "skipped";
  if (filter === "conflict") return item.status === "conflict";
  return true;
}

function matchesSearch(item: PreviewItem, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    String(item.productId).includes(needle) ||
    item.offerId.toLowerCase().includes(needle) ||
    (item.normalizedOfferId?.toLowerCase().includes(needle) ?? false) ||
    (item.targetProduct?.name?.toLowerCase().includes(needle) ?? false) ||
    (item.targetMerchProduct?.sku?.toLowerCase().includes(needle) ?? false)
  );
}

export function OzonImportTab() {
  const [targets, setTargets] = useState<ImportTargets>({
    serverPostgres: true,
    // Backend сейчас стоит на staging-safety: запись в Supabase отключена
    // флагом OZON_IMPORT_WRITE_SUPABASE=false. Дефолтим в false, чтобы не
    // вводить в заблуждение — флажок остаётся доступным для будущего.
    supabase: false,
  });
  const [limit, setLimit] = useState<number>(200);
  const [includeArchived, setIncludeArchived] = useState(false);
  // false → backend не трогает цены существующих офферов (price/old_price/
  // min_price, sale_price). Новые офферы всё равно получают начальную цену.
  const [updatePrices, setUpdatePrices] = useState(true);
  // true, если галку сняли, но backend флаг не поддержал (старый release).
  const [priceFlagIgnored, setPriceFlagIgnored] = useState(false);

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  // Item, открытый в JSON-debug диалоге — показывает все поля как пришли с
  // backend (matchReason, targetProduct, plannedActions, …).
  const [inspectItem, setInspectItem] = useState<PreviewItem | null>(null);

  const [job, setJob] = useState<JobResponse | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  async function runPreview() {
    setPreviewing(true);
    try {
      const res = await fetch("/api/komui/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets,
          mode: "preview",
          limit,
          includeArchived,
          updatePrices,
        }),
      });
      const data = (await res.json()) as PreviewResponse | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setPreview(data);
      setJob(null);
      // Старый backend молча отбрасывает незнакомый флаг. Если галка снята,
      // но backend не подтвердил (warning отсутствует) — план построен
      // С обновлением цен, честно предупреждаем.
      setPriceFlagIgnored(
        !updatePrices && !hasPreviewWarning(data.warnings, "price_updates_disabled"),
      );
      const actionable =
        data.summary.actionableServerPostgres +
        data.summary.actionableSupabase;
      toast.success(
        `Просканировано ${data.summary.totalOzonItems}, к действию: ${actionable}`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  }

  function pollJob(jobId: string) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/komui/jobs/${encodeURIComponent(jobId)}`);
        const data = (await res.json()) as JobResponse | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
        }
        setJob(data);
        if (data.status === "queued" || data.status === "running") {
          pollJob(jobId);
        } else if (data.status === "succeeded") {
          toast.success("Импорт завершён");
        } else if (data.status === "partial") {
          toast.warning("Импорт завершён частично — есть ошибки");
        } else if (data.status === "failed") {
          toast.error("Импорт не выполнен");
        }
      } catch (e) {
        toast.error(errorMessage(e));
      }
    }, 2500);
  }

  async function startImport() {
    if (!preview) return;
    if (importing) return;
    setImporting(true);
    setConfirmOpen(false);
    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const res = await fetch("/api/komui/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          previewId: preview.previewId,
          targets,
          confirm: true,
        }),
      });
      const data = (await res.json()) as ImportStartResponse | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setJob({
        jobId: data.jobId,
        status: data.status,
        progress: { current: 0, total: 0 },
        summary: {},
        events: [],
        errors: [],
      });
      toast.success("Импорт запущен");
      pollJob(data.jobId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setImporting(false);
    }
  }

  const filteredItems = useMemo(() => {
    if (!preview) return [];
    return preview.items.filter(
      (it) => matchesFilter(it, filter) && matchesSearch(it, query),
    );
  }, [preview, filter, query]);

  const breakdown = useMemo(
    () => (preview ? computeBreakdown(preview.items) : null),
    [preview],
  );

  const hasErrors = useMemo(() => {
    if (!preview) return false;
    return preview.items.some((it) => it.severity === "error");
  }, [preview]);

  const actionableTotal = preview
    ? preview.summary.actionableServerPostgres +
      preview.summary.actionableSupabase
    : 0;

  const jobActive = job && (job.status === "queued" || job.status === "running");
  const importDisabled =
    !preview ||
    !preview.canImport ||
    hasErrors ||
    actionableTotal === 0 ||
    importing ||
    Boolean(jobActive);

  async function copyPreviewJson() {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(preview, null, 2));
      toast.success("JSON скопирован");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-[1fr_auto] items-end">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Цели импорта</Label>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={targets.serverPostgres}
                      onCheckedChange={(v) =>
                        setTargets((t) => ({ ...t, serverPostgres: v === true }))
                      }
                    />
                    Server PostgreSQL
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={targets.supabase}
                      onCheckedChange={(v) =>
                        setTargets((t) => ({ ...t, supabase: v === true }))
                      }
                    />
                    Supabase
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  На staging запись в Supabase отключена флагом
                  <code className="font-mono"> OZON_IMPORT_WRITE_SUPABASE=false</code>.
                  Несопоставленные позиции не создаются автоматически — мапить вручную.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="komui-limit" className="text-xs">
                  Лимит товаров
                </Label>
                <Input
                  id="komui-limit"
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  onChange={(e) =>
                    setLimit(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Архивные</Label>
                <label className="flex items-center gap-2 text-sm h-10">
                  <Checkbox
                    checked={includeArchived}
                    onCheckedChange={(v) => setIncludeArchived(v === true)}
                  />
                  Включать архивные
                </label>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Цены</Label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={updatePrices}
                    onCheckedChange={(v) => setUpdatePrices(v === true)}
                  />
                  Обновлять цены
                </label>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  Выкл — цены существующих офферов и sale_price не трогаются.
                  Новые офферы всё равно получат начальную цену из Ozon.
                </p>
              </div>
            </div>
            <Button
              onClick={runPreview}
              disabled={previewing || (!targets.serverPostgres && !targets.supabase)}
            >
              {previewing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
              Проверить новые товары из Ozon
            </Button>
          </div>
        </CardContent>
      </Card>

      {!preview && !previewing && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Store}
              title="Превью ещё не запускалось"
              description="Нажмите «Проверить новые товары из Ozon», чтобы получить diff: какие позиции сопоставились, какие требуют ручного маппинга."
            />
          </CardContent>
        </Card>
      )}

      {preview && (
        <>
          <SummaryCards preview={preview} breakdown={breakdown} />

          {priceFlagIgnored && (
            <Card>
              <CardContent className="p-4 flex items-start gap-3 bg-state-danger">
                <XCircle className="h-5 w-5 text-state-danger-fg shrink-0 mt-0.5" />
                <div className="text-sm text-state-danger-fg">
                  <div className="font-medium">
                    Backend не поддержал отключение цен
                  </div>
                  <div className="opacity-90 mt-0.5">
                    На сервере старый release без флага{" "}
                    <code className="font-mono">updatePrices</code> — этот
                    preview построен <span className="font-semibold">с</span>{" "}
                    обновлением цен. Импорт из него изменит цены. Обнови
                    backend или оставь галку включённой.
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {preview.warnings.length > 0 && (
            <Card>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-state-warning-fg" />
                  Предупреждения backend
                </div>
                <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-0.5">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{previewWarningText(w)}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div className="flex flex-wrap gap-1.5">
                  {FILTERS.map((f) => (
                    <Pill
                      key={f.key}
                      shape="square"
                      active={filter === f.key}
                      onClick={() => setFilter(f.key)}
                    >
                      {f.label}
                    </Pill>
                  ))}
                </div>
                <div className="flex gap-2 items-center">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="offerId, productId, SKU, название"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="pl-8 w-72"
                    />
                  </div>
                  <Button variant="outline" onClick={copyPreviewJson}>
                    <ClipboardCopy className="h-4 w-4" /> JSON
                  </Button>
                </div>
              </div>

              <Separator />

              <ItemsTable items={filteredItems} onInspect={setInspectItem} />

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <div className="text-xs text-muted-foreground">
                  Показано {filteredItems.length} из {preview.items.length}
                  {hasErrors && (
                    <span className="ml-2 text-state-danger-fg">
                      Есть ошибки — импорт заблокирован
                    </span>
                  )}
                  {!hasErrors && !preview.canImport && (
                    <span className="ml-2 text-state-warning-fg">
                      Backend отметил canImport=false
                    </span>
                  )}
                  {!hasErrors && preview.canImport && actionableTotal === 0 && (
                    <span className="ml-2">Нечего импортировать</span>
                  )}
                </div>
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={importDisabled}
                >
                  <Download className="h-4 w-4" /> Импортировать
                  {actionableTotal > 0 && ` (${actionableTotal})`}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {job && <JobPanel job={job} />}

      <Dialog
        open={inspectItem !== null}
        onOpenChange={(open) => {
          if (!open) setInspectItem(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>JSON позиции</DialogTitle>
            <DialogDescription>
              Поля как пришли с backend: matchReason, targetProduct,
              targetMerchProduct, plannedActions, offerId, sku, productId.
            </DialogDescription>
          </DialogHeader>
          {inspectItem && (
            <pre className="text-[11px] font-mono bg-muted/50 rounded-md p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap break-words">
              {JSON.stringify(inspectItem, null, 2)}
            </pre>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!inspectItem) return;
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify(inspectItem, null, 2),
                  );
                  toast.success("JSON скопирован");
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              <ClipboardCopy className="h-4 w-4" /> Копировать
            </Button>
            <Button onClick={() => setInspectItem(null)}>Закрыть</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Подтвердить импорт</DialogTitle>
            <DialogDescription>
              Будут обновлены данные в{" "}
              {targets.serverPostgres && "server PostgreSQL"}
              {targets.serverPostgres && targets.supabase && " и "}
              {targets.supabase && "Supabase"}. Продолжить?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Отмена
            </Button>
            <Button onClick={startImport} disabled={importing}>
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Запустить импорт
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCards({
  preview,
  breakdown,
}: {
  preview: PreviewResponse;
  breakdown: ActionableBreakdown | null;
}) {
  const s = preview.summary;
  const cards: {
    label: string;
    value: number;
    tone?: string;
    breakdown?: { create: number; update: number; other: number };
  }[] = [
    { label: "Из Ozon", value: s.totalOzonItems },
    {
      label: "Сопоставлено карточек",
      value: s.matchedStorefront,
      tone: "text-state-success-fg",
    },
    {
      label: "Сопоставлено SKU",
      value: s.matchedMerchProducts,
      tone: "text-state-success-fg",
    },
    {
      label: "К применению в Postgres",
      value: s.actionableServerPostgres,
      tone: s.actionableServerPostgres > 0 ? "text-state-info-fg" : undefined,
      breakdown: breakdown
        ? {
            create: breakdown.postgresCreate,
            update: breakdown.postgresUpdate,
            other: breakdown.postgresOther,
          }
        : undefined,
    },
    {
      label: "К применению в Supabase",
      value: s.actionableSupabase,
      tone: s.actionableSupabase > 0 ? "text-state-info-fg" : undefined,
      breakdown: breakdown
        ? {
            create: breakdown.supabaseCreate,
            update: breakdown.supabaseUpdate,
            other: breakdown.supabaseOther,
          }
        : undefined,
    },
    { label: "Без изменений", value: s.noop },
    {
      label: "Не сопоставлено",
      value: s.unmatched,
      tone: s.unmatched > 0 ? "text-state-warning-fg" : undefined,
    },
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div
                className={cn(
                  "text-xl font-semibold tabular-nums mt-0.5",
                  c.tone,
                )}
              >
                {c.value}
              </div>
              {c.breakdown && c.value > 0 && (
                <div className="text-[10px] text-muted-foreground tabular-nums mt-1 flex flex-wrap gap-x-1.5">
                  {c.breakdown.create > 0 && (
                    <span>create: {c.breakdown.create}</span>
                  )}
                  {c.breakdown.update > 0 && (
                    <span>update: {c.breakdown.update}</span>
                  )}
                  {c.breakdown.other > 0 && (
                    <span>other: {c.breakdown.other}</span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// Форматируем значение поля diff'а в короткую строку. Массивы → "[a, b, …]",
// строки в кавычках, null → "—", числа без кавычек. Длинные значения
// сокращаются, полный вид всегда доступен через JSON-debug диалог.
function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const inner = v.slice(0, 3).map((x) => formatDiffValue(x)).join(", ");
    return v.length > 3 ? `[${inner}, …+${v.length - 3}]` : `[${inner}]`;
  }
  return JSON.stringify(v);
}

const DIFF_FIELD_LABELS: Record<string, string> = {
  "offers.price": "цена",
  "offers.old_price": "old price",
  "offers.min_price": "min price",
  "offers.offer_id": "offer_id",
  "offers.product_id": "product_id",
  "offers.visible": "visible",
  "offers.archived": "archived",
  price_min: "price_min",
  price_max: "price_max",
  ozon_product_ids: "ozon_product_ids",
  ozon_skus: "ozon_skus",
  ozon_offer_ids: "ozon_offer_ids",
};

function diffFieldLabel(field: string): string {
  return DIFF_FIELD_LABELS[field] ?? field;
}

function PriceCell({ item }: { item: PreviewItem }) {
  if (item.price == null) return <span>—</span>;
  const changed = item.oldPrice != null && item.oldPrice !== item.price;
  return (
    <div className="text-right tabular-nums">
      <div>{formatMoney(item.price)}</div>
      {changed && (
        <div className="text-[10px] text-muted-foreground flex items-center justify-end gap-1">
          <span className="line-through">{formatMoney(item.oldPrice)}</span>
          <ArrowRight className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}

function ItemsTable({
  items,
  onInspect,
}: {
  items: PreviewItem[];
  onInspect: (it: PreviewItem) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        Нет позиций под текущий фильтр
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8"></TableHead>
            <TableHead className="w-32">Статус</TableHead>
            <TableHead>Карточка / SKU</TableHead>
            <TableHead className="w-44">Offer ID</TableHead>
            <TableHead className="w-32 text-right">Цена</TableHead>
            <TableHead>Изменения</TableHead>
            <TableHead>План</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => {
            const isOpen = expanded.has(it.itemId);
            const changedFields = it.diff?.changedFields ?? [];
            const hasDiff = it.diff && it.diff.fields.length > 0;
            return (
              <Fragment key={it.itemId}>
            <TableRow>
              <TableCell>
                {hasDiff && (
                  <button
                    type="button"
                    onClick={() => toggle(it.itemId)}
                    className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-accent text-muted-foreground"
                    aria-label={isOpen ? "Свернуть" : "Развернуть"}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                )}
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn("border-transparent", statusBadgeClasses(it.status))}
                >
                  {statusLabel(it.status)}
                </Badge>
                {it.severity === "error" && (
                  <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-state-danger-fg">
                    <XCircle className="h-3 w-3" /> error
                  </div>
                )}
                {it.severity === "warning" && (
                  <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-state-warning-fg">
                    <AlertTriangle className="h-3 w-3" /> warning
                  </div>
                )}
                {it.matchReason && it.matchReason !== "none" && (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    match: <span className="font-mono">{it.matchReason}</span>
                  </div>
                )}
              </TableCell>
              <TableCell>
                <div className="text-sm font-medium truncate max-w-[280px]">
                  {it.targetProduct?.name ?? (
                    <span className="text-muted-foreground italic">
                      без карточки
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums font-mono">
                  product {it.productId}
                  {it.targetMerchProduct?.sku && (
                    <> · sku {it.targetMerchProduct.sku}</>
                  )}
                </div>
                {it.targetProduct?.slug && (
                  <div className="text-[10px] text-muted-foreground">
                    <span className="opacity-70">slug:</span>{" "}
                    <span className="font-mono">{it.targetProduct.slug}</span>
                  </div>
                )}
                {it.targetProduct?.designKey && (
                  <div className="text-[10px] text-muted-foreground">
                    <span className="opacity-70">ключ карточки:</span>{" "}
                    <span className="font-mono">{it.targetProduct.designKey}</span>
                  </div>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {it.offerId}
                {it.normalizedOfferId &&
                  it.normalizedOfferId !== it.offerId && (
                    <div className="text-[10px] text-muted-foreground">
                      → {it.normalizedOfferId}
                    </div>
                  )}
              </TableCell>
              <TableCell>
                <PriceCell item={it} />
              </TableCell>
              <TableCell className="text-xs">
                {it.diff ? (
                  changedFields.length === 0 ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "border-transparent text-[10px]",
                        statusBadgeClasses("noop"),
                      )}
                    >
                      без изменений
                    </Badge>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {changedFields.slice(0, 4).map((f) => (
                        <Badge
                          key={f}
                          variant="outline"
                          className={cn(
                            "border-transparent text-[10px] font-mono",
                            statusBadgeClasses("matched"),
                          )}
                        >
                          {diffFieldLabel(f)}
                        </Badge>
                      ))}
                      {changedFields.length > 4 && (
                        <Badge
                          variant="outline"
                          className="text-[10px]"
                        >
                          +{changedFields.length - 4}
                        </Badge>
                      )}
                    </div>
                  )
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {it.plannedActions.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="space-y-0.5">
                    {it.plannedActions.map((a, i) => (
                      <li
                        key={i}
                        className="flex flex-wrap gap-1.5 items-center"
                      >
                        <Badge variant="outline" className="text-[10px]">
                          {a.target}
                        </Badge>
                        <span className="font-medium font-mono">{a.action}</span>
                        {a.table && (
                          <span className="text-muted-foreground">
                            → {a.table}
                          </span>
                        )}
                        {a.reason && (
                          <span className="text-muted-foreground/70">
                            ({a.reason})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {it.errors && it.errors.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-state-danger-fg">
                    {it.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => onInspect(it)}
                  aria-label="Показать JSON позиции"
                  title="Показать JSON"
                  className="h-7 w-7"
                >
                  <Braces className="h-3.5 w-3.5" />
                </Button>
              </TableCell>
            </TableRow>
            {isOpen && it.diff && (
              <TableRow>
                <TableCell colSpan={8} className="bg-muted/30 p-0">
                  <DiffTable diff={it.diff} />
                </TableCell>
              </TableRow>
            )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function DiffTable({ diff }: { diff: ItemDiff }) {
  return (
    <div className="px-4 py-3 text-xs space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>
          target: <span className="font-mono text-foreground">{diff.target}</span>
        </span>
        {diff.table && (
          <span>
            · table:{" "}
            <span className="font-mono text-foreground">{diff.table}</span>
          </span>
        )}
        <span>
          · operation:{" "}
          <span className="font-mono text-foreground">{diff.operation}</span>
        </span>
        <span>
          · changed:{" "}
          <span
            className={cn(
              "font-mono",
              diff.changed ? "text-state-warning-fg" : "text-state-success-fg",
            )}
          >
            {String(diff.changed)}
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left font-medium py-1 pr-3 w-1/4">поле</th>
              <th className="text-left font-medium py-1 pr-3 w-[35%]">сейчас</th>
              <th className="text-left font-medium py-1 pr-3 w-[35%]">будет</th>
              <th className="text-left font-medium py-1 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {diff.fields.map((f: DiffField) => (
              <tr
                key={f.field}
                className={cn(
                  "align-top border-t border-border/40",
                  f.changed && "bg-state-warning text-state-warning-fg",
                )}
              >
                <td className="py-1 pr-3 font-mono">{f.field}</td>
                <td className="py-1 pr-3 font-mono break-all">
                  {formatDiffValue(f.current)}
                </td>
                <td className="py-1 pr-3 font-mono break-all">
                  {formatDiffValue(f.next)}
                </td>
                <td className="py-1">
                  {f.changed ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "border-transparent text-[10px]",
                        statusBadgeClasses("matched"),
                      )}
                    >
                      diff
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">=</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JobPanel({ job }: { job: JobResponse }) {
  const tone =
    job.status === "succeeded"
      ? "text-state-success-fg"
      : job.status === "failed"
        ? "text-state-danger-fg"
        : job.status === "partial"
          ? "text-state-warning-fg"
          : "text-state-info-fg";
  const Icon =
    job.status === "succeeded"
      ? CheckCircle2
      : job.status === "failed"
        ? XCircle
        : job.status === "partial"
          ? AlertTriangle
          : Loader2;
  const iconSpin = job.status === "queued" || job.status === "running";
  const pct =
    job.progress.total > 0
      ? Math.round((job.progress.current / job.progress.total) * 100)
      : null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Icon className={cn("h-5 w-5", tone, iconSpin && "animate-spin")} />
            <div>
              <div className="font-medium">
                Job {JOB_STATUS_LABELS[job.status]}
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                {job.jobId}
              </div>
            </div>
          </div>
          {pct !== null && (
            <div className="text-sm tabular-nums">
              {job.progress.current} / {job.progress.total} ({pct}%)
            </div>
          )}
        </div>

        {pct !== null && (
          <div className="h-2 rounded bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                job.status === "failed"
                  ? "bg-state-danger-fg"
                  : job.status === "partial"
                    ? "bg-state-warning-fg"
                    : "bg-primary",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
          <SummaryStat label="server insert" value={job.summary.insertedServer} />
          <SummaryStat label="server update" value={job.summary.updatedServer} />
          <SummaryStat label="supa insert" value={job.summary.insertedSupabase} />
          <SummaryStat label="supa update" value={job.summary.updatedSupabase} />
          <SummaryStat label="skipped" value={job.summary.skipped} />
          <SummaryStat
            label="errors"
            value={job.summary.errors}
            tone={
              (job.summary.errors ?? 0) > 0 ? "text-state-danger-fg" : undefined
            }
          />
        </div>

        {job.errors.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-state-danger-fg">
              Ошибки
            </div>
            <ul className="text-xs text-state-danger-fg list-disc pl-5 space-y-0.5">
              {job.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {job.events.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium">Журнал</div>
            <ul className="text-xs space-y-0.5 max-h-48 overflow-y-auto">
              {job.events.map((ev, i) => {
                const evTone =
                  ev.level === "error"
                    ? "text-state-danger-fg"
                    : ev.level === "warning"
                      ? "text-state-warning-fg"
                      : "text-muted-foreground";
                return (
                  <li key={i} className={cn("flex gap-2", evTone)}>
                    <span className="tabular-nums shrink-0">
                      {formatDate(ev.time)}
                    </span>
                    <span className="truncate">{ev.message}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value?: number;
  tone?: string;
}) {
  return (
    <div className="rounded-md bg-muted/50 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("text-sm font-semibold tabular-nums", tone)}>
        {value ?? 0}
      </div>
    </div>
  );
}
