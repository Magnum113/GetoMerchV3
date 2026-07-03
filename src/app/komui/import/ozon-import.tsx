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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, errorMessage, formatDate, formatMoney } from "@/lib/utils";
import { InfoTip } from "./info-tip";
import { LinkOffersSection } from "./link-offers-section";
import { NewProductGroupsSection } from "./new-product-groups";
import {
  hasPreviewWarning,
  JOB_STATUS_LABELS,
  previewWarningText,
  type DiffField,
  type ImportStartResponse,
  type ImportTargets,
  type ItemDiff,
  type JobResponse,
  type PreviewItem,
  type PreviewResponse,
} from "@/lib/komui/types";

// ============================================================================
// Helpers
// ============================================================================

type FilterKey = "all" | "changed" | "noop";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "changed", label: "С изменениями" },
  { key: "noop", label: "Без изменений" },
];

function isActionable(item: PreviewItem): boolean {
  return item.plannedActions.some(
    (a) => a.action !== "noop" && a.action !== "skip",
  );
}

// Позиции, которые можно выборочно импортировать: сматчены с карточкой сайта
// и имеют реальное действие в плане.
function isSelectable(item: PreviewItem): boolean {
  return Boolean(item.targetProduct?.id) && isActionable(item);
}

function isMatched(item: PreviewItem): boolean {
  return Boolean(item.targetProduct?.id || item.targetMerchProduct?.id);
}

function matchesFilter(item: PreviewItem, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "changed") return isActionable(item);
  return !isActionable(item);
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

// Сырые имена полей diff'а группируем в человеческие категории — в строке
// таблицы видно «что поменяется», а точные поля живут в раскрытом diff'е.
const PRICE_FIELDS = new Set([
  "price", "old_price", "min_price", "price_min", "price_max", "sale_price",
]);
const OZON_PRICE_FIELDS = new Set([
  "ozon_price", "ozon_old_price", "ozon_min_price",
]);
const IMAGE_FIELDS = new Set([
  "primary_image", "primary_image_url", "main_image_path", "image_urls",
  "images", "images360", "color_image",
]);
const LINK_FIELDS = new Set([
  "ozon_product_ids", "ozon_skus", "ozon_offer_ids", "product_id", "sku",
  "offer_id", "last_ozon_sync_at",
]);

function changeCategories(fields: string[]): string[] {
  const cats: string[] = [];
  const add = (c: string) => {
    if (!cats.includes(c)) cats.push(c);
  };
  for (const f of fields) {
    const base = f.includes(".") ? (f.split(".").at(-1) ?? f) : f;
    if (PRICE_FIELDS.has(base)) add("цена");
    else if (OZON_PRICE_FIELDS.has(base)) add("цена Ozon");
    else if (IMAGE_FIELDS.has(base)) add("фото");
    else if (base === "sizes") add("размеры");
    else if (LINK_FIELDS.has(base)) add("привязка SKU");
    else if (base === "name") add("название");
    else if (base === "visible" || base === "archived") add("видимость");
    else add(base);
  }
  return cats;
}

function categoryBadgeClasses(cat: string): string {
  switch (cat) {
    case "цена":
      return "bg-state-danger text-state-danger-fg";
    case "фото":
      return "bg-state-info text-state-info-fg";
    case "размеры":
      return "bg-state-success text-state-success-fg";
    default:
      return "bg-state-neutral text-state-neutral-fg";
  }
}

// Форматируем значение поля diff'а в короткую строку. Массивы → "[a, b, …]",
// строки в кавычках, null → "—", числа без кавычек.
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

// ============================================================================
// Main component
// ============================================================================

export function OzonImportTab() {
  const [targets, setTargets] = useState<ImportTargets>({
    serverPostgres: true,
    supabase: false,
  });
  const [limit, setLimit] = useState<number>(1000);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [updatePrices, setUpdatePrices] = useState(false);
  const [syncSizes, setSyncSizes] = useState(true);
  // true, если галку цен сняли, но backend флаг не поддержал (старый release).
  const [priceFlagIgnored, setPriceFlagIgnored] = useState(false);

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
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
          syncSizes: syncSizes ? "add" : "off",
        }),
      });
      const data = (await res.json()) as PreviewResponse | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error(("error" in data && data.error) || `Ошибка ${res.status}`);
      }
      setPreview(data);
      setJob(null);
      // Предвыбираем все importable-позиции — админ может снять лишние.
      setSelected(
        new Set(data.items.filter(isSelectable).map((it) => it.itemId)),
      );
      // Старый backend молча отбрасывает незнакомый флаг. Если галка снята,
      // но backend не подтвердил (ни warning, ни mode.updatePrices=false) —
      // план построен С обновлением цен, честно предупреждаем.
      const modeConfirms =
        typeof data.mode === "object" && data.mode?.updatePrices === false;
      setPriceFlagIgnored(
        !updatePrices &&
          !modeConfirms &&
          !hasPreviewWarning(data.warnings, "price_updates_disabled"),
      );
      const actionable =
        data.summary.actionableServerPostgres +
        data.summary.actionableSupabase;
      toast.success(
        `Просканировано ${data.summary.totalOzonItems}, к обновлению: ${actionable}`,
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
          // Всегда шлём явный список — так рекомендует контракт API; без
          // списка backend применил бы весь importable preview.
          itemIds: Array.from(selected),
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

  // Основная таблица — только сматченные позиции; unmatched живут в секции
  // «Привязка», новые дизайны — в «Новых карточках».
  const matchedItems = useMemo(
    () => (preview ? preview.items.filter(isMatched) : []),
    [preview],
  );

  const filteredItems = useMemo(
    () =>
      matchedItems.filter(
        (it) => matchesFilter(it, filter) && matchesSearch(it, query),
      ),
    [matchedItems, filter, query],
  );

  const hasErrors = useMemo(
    () => (preview ? preview.items.some((it) => it.severity === "error") : false),
    [preview],
  );

  const actionableTotal = preview
    ? preview.summary.actionableServerPostgres +
      preview.summary.actionableSupabase
    : 0;

  const selectableTotal = useMemo(
    () => matchedItems.filter(isSelectable).length,
    [matchedItems],
  );

  const jobActive = job && (job.status === "queued" || job.status === "running");
  const importDisabled =
    !preview ||
    !preview.canImport ||
    hasErrors ||
    selected.size === 0 ||
    importing ||
    Boolean(jobActive);

  function toggleSelected(itemId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleAllVisible(check: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const it of filteredItems) {
        if (!isSelectable(it)) continue;
        if (check) next.add(it.itemId);
        else next.delete(it.itemId);
      }
      return next;
    });
  }

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
    <TooltipProvider delayDuration={200}>
    <div className="space-y-5">
      {/* Панель запуска: всё в одну строку, пояснения — в (i) */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
                Куда пишем
                <InfoTip text="Server PostgreSQL — основная база сайта komui.ru. Supabase — legacy-контур; запись в него сейчас отключена на сервере (OZON_IMPORT_WRITE_SUPABASE=false)." />
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={targets.serverPostgres}
                    onCheckedChange={(v) =>
                      setTargets((t) => ({ ...t, serverPostgres: v === true }))
                    }
                  />
                  PostgreSQL
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
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="komui-limit" className="text-xs text-muted-foreground font-medium">
                Лимит
              </Label>
              <Input
                id="komui-limit"
                type="number"
                min={1}
                max={10000}
                value={limit}
                onChange={(e) =>
                  setLimit(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-24 h-9"
              />
            </div>

            <div className="flex items-center gap-4 pb-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={includeArchived}
                  onCheckedChange={(v) => setIncludeArchived(v === true)}
                />
                Архивные
                <InfoTip text="Включать в скан архивные товары Ozon." />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={updatePrices}
                  onCheckedChange={(v) => setUpdatePrices(v === true)}
                />
                Обновлять цены
                <InfoTip text="Цены сайта и Ozon у Komui разные. Включай, только если сознательно хочешь заменить цены сайта Ozon-ценами. Ozon-цены и так сохраняются в технические поля offers[].ozon_price." />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={syncSizes}
                  onCheckedChange={(v) => setSyncSizes(v === true)}
                />
                Новые размеры
                <InfoTip text="Добавлять к карточкам размеры, появившиеся в Ozon. Только добавляет — удаление размеров остаётся ручным действием в редакторе товара." />
              </label>
            </div>

            <div className="ml-auto pb-0.5">
              <Button
                onClick={runPreview}
                disabled={previewing || (!targets.serverPostgres && !targets.supabase)}
              >
                {previewing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
                Проверить товары из Ozon
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {!preview && !previewing && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Store}
              title="Превью ещё не запускалось"
              description="Нажмите «Проверить товары из Ozon» — покажем, какие карточки обновятся, какие offer-ы нужно привязать вручную и какие товары можно создать."
            />
          </CardContent>
        </Card>
      )}

      {preview && (
        <>
          <SummaryCards preview={preview} actionableTotal={actionableTotal} />

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
                    обновлением цен. Импорт из него изменит цены сайта.
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {preview.warnings.length > 0 && (
            <Card>
              <CardContent className="p-3 flex items-start gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-state-warning-fg shrink-0 mt-0.5" />
                <div className="space-y-0.5 text-muted-foreground">
                  {preview.warnings.map((w, i) => (
                    <div key={i}>{previewWarningText(w)}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Обновления карточек</span>
                  <Badge variant="secondary" className="tabular-nums">
                    {matchedItems.length}
                  </Badge>
                  <InfoTip text="Товары Ozon, автоматически сопоставленные с карточками сайта. Отметь галками нужные строки и нажми «Применить». Стрелка слева от строки раскрывает точный список изменений." />
                </div>
                <div className="flex gap-2 items-center">
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
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Поиск: артикул или название"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="pl-8 w-64 h-8"
                    />
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={copyPreviewJson}
                        aria-label="Скопировать JSON превью"
                      >
                        <ClipboardCopy className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Скопировать весь ответ preview (JSON)</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <Separator />

              <ItemsTable
                items={filteredItems}
                onInspect={setInspectItem}
                selected={selected}
                onToggle={toggleSelected}
                onToggleAll={toggleAllVisible}
              />

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="text-xs text-muted-foreground">
                  Показано {filteredItems.length} из {matchedItems.length}
                  {" · "}выбрано {selected.size} из {selectableTotal}
                  {hasErrors && (
                    <span className="ml-2 text-state-danger-fg">
                      Есть ошибки — импорт заблокирован
                    </span>
                  )}
                  {!hasErrors && preview.canImport && actionableTotal === 0 && (
                    <span className="ml-2">Всё уже синхронизировано</span>
                  )}
                </div>
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={importDisabled}
                >
                  <Download className="h-4 w-4" /> Применить выбранные
                  {selected.size > 0 && ` (${selected.size})`}
                </Button>
              </div>
            </CardContent>
          </Card>

          <LinkOffersSection
            preview={preview}
            updatePrices={updatePrices}
            syncSizes={syncSizes}
            onLinked={runPreview}
          />

          <NewProductGroupsSection preview={preview} onCreated={runPreview} />
        </>
      )}

      {job && <JobPanel job={job} />}

      {/* JSON-инспектор позиции: все технические поля живут здесь */}
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
              Все поля как пришли с backend: идентификаторы, matchReason,
              plannedActions, diff.
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
              Будут применены выбранные позиции ({selected.size} шт) в{" "}
              {targets.serverPostgres && "server PostgreSQL"}
              {targets.serverPostgres && targets.supabase && " и "}
              {targets.supabase && "Supabase"}.
              {updatePrices
                ? " Цены сайта будут заменены Ozon-ценами."
                : " Цены сайта не изменятся."}{" "}
              Продолжить?
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
    </TooltipProvider>
  );
}

// ============================================================================
// Summary
// ============================================================================

function SummaryCards({
  preview,
  actionableTotal,
}: {
  preview: PreviewResponse;
  actionableTotal: number;
}) {
  const s = preview.summary;
  const groups = s.newProductGroups ?? preview.newProductGroups?.length ?? 0;
  const cards: { label: string; value: number; tone?: string; hint?: string }[] = [
    {
      label: "Из Ozon",
      value: s.totalOzonItems,
      hint: "Сколько товаров Ozon просканировано в этом preview.",
    },
    {
      label: "К обновлению",
      value: actionableTotal,
      tone: actionableTotal > 0 ? "text-state-info-fg" : undefined,
      hint: "Сматченные карточки, у которых есть реальные изменения — таблица ниже.",
    },
    {
      label: "Без изменений",
      value: s.noop,
      hint: "Сматчены, но данные уже совпадают — импорт их пропустит.",
    },
    {
      label: "Требуют привязки",
      value: s.unmatched - groupItemsCount(preview),
      tone:
        s.unmatched - groupItemsCount(preview) > 0
          ? "text-state-warning-fg"
          : undefined,
      hint: "Offer-ы без автоматического матча — привяжи их к карточкам в секции «Привязка» ниже.",
    },
    {
      label: "Новые карточки",
      value: groups,
      tone: groups > 0 ? "text-state-info-fg" : undefined,
      hint: "Группы новых дизайнов, из которых можно создать карточки сайта — секция внизу страницы.",
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-3">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {c.label}
              {c.hint && <InfoTip text={c.hint} />}
            </div>
            <div
              className={cn("text-xl font-semibold tabular-nums mt-0.5", c.tone)}
            >
              {c.value}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// Offer-ы, уже сгруппированные в кандидаты новых карточек, не считаем
// «требующими привязки» — у них свой путь (создание карточки).
function groupItemsCount(preview: PreviewResponse): number {
  const groups = preview.newProductGroups ?? [];
  return groups.reduce((sum, g) => sum + g.itemIds.length, 0);
}

// ============================================================================
// Items table
// ============================================================================

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
  selected,
  onToggle,
  onToggleAll,
}: {
  items: PreviewItem[];
  onInspect: (it: PreviewItem) => void;
  selected: Set<string>;
  onToggle: (itemId: string) => void;
  onToggleAll: (check: boolean) => void;
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

  const selectable = items.filter(isSelectable);
  const allChecked =
    selectable.length > 0 && selectable.every((it) => selected.has(it.itemId));
  const someChecked = selectable.some((it) => selected.has(it.itemId));

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
            <TableHead className="w-8">
              {selectable.length > 0 && (
                <Checkbox
                  checked={allChecked ? true : someChecked ? "indeterminate" : false}
                  onCheckedChange={(v) => onToggleAll(v === true)}
                  aria-label="Выбрать все видимые"
                />
              )}
            </TableHead>
            <TableHead>Товар</TableHead>
            <TableHead className="w-32 text-right">Цена Ozon</TableHead>
            <TableHead>Что изменится</TableHead>
            <TableHead className="w-20"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => {
            const isOpen = expanded.has(it.itemId);
            const changedFields = it.diff?.changedFields ?? [];
            const hasDiff = it.diff && it.diff.fields.length > 0;
            const cats = changeCategories(changedFields);
            return (
              <Fragment key={it.itemId}>
                <TableRow className={cn(!isActionable(it) && "opacity-60")}>
                  <TableCell>
                    {isSelectable(it) && (
                      <Checkbox
                        checked={selected.has(it.itemId)}
                        onCheckedChange={() => onToggle(it.itemId)}
                        aria-label={`Выбрать ${it.offerId}`}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium truncate max-w-[320px]">
                      {it.targetProduct?.name ??
                        it.targetMerchProduct?.sku ?? (
                          <span className="text-muted-foreground italic">
                            без карточки
                          </span>
                        )}
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {it.offerId}
                      {it.size && <> · {it.size}</>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PriceCell item={it} />
                  </TableCell>
                  <TableCell>
                    {it.severity === "error" ? (
                      <span className="inline-flex items-center gap-1 text-xs text-state-danger-fg">
                        <XCircle className="h-3.5 w-3.5" /> ошибка —
                        подробности в JSON
                      </span>
                    ) : cats.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        без изменений
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {cats.map((c) => (
                          <Badge
                            key={c}
                            variant="outline"
                            className={cn(
                              "border-transparent text-[10px]",
                              categoryBadgeClasses(c),
                            )}
                          >
                            {c}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      {hasDiff && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => toggle(it.itemId)}
                              aria-label={isOpen ? "Свернуть diff" : "Показать diff"}
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Точный список изменений</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => onInspect(it)}
                            aria-label="Показать JSON позиции"
                          >
                            <Braces className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Технические данные (ID, matchReason, план)
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
                {isOpen && it.diff && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-muted/30 p-0">
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
          таблица:{" "}
          <span className="font-mono text-foreground">{diff.table}</span>
        </span>
        <span>
          · операция:{" "}
          <span className="font-mono text-foreground">{diff.operation}</span>
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
                      className="border-transparent text-[10px] bg-state-warning text-state-warning-fg"
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

// ============================================================================
// Job panel
// ============================================================================

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
                Импорт: {JOB_STATUS_LABELS[job.status]}
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
