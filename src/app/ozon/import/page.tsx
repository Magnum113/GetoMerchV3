"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  DownloadCloud,
  Link2,
  Loader2,
  PackagePlus,
  Palette,
  RefreshCw,
  Search,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { errorMessage, formatDate } from "@/lib/utils";
import type { DesignSuggestion, OzonImportApplyResult, OzonImportItem, OzonImportPreview } from "@/lib/ozon-import";
import {
  DEFAULT_OZON_IMPORT_SELECTION,
  type OzonImportSelection,
} from "@/lib/ozon/import-selection";
import { api } from "@/lib/api";

type Filter = "all" | "new_design" | "new_product" | "update" | "conflict" | "noop";

type DesignDraft = {
  name: string;
  imageUrl: string;
};

const FILTER_LABELS: Record<Filter, string> = {
  all: "Все",
  new_design: "Новые дизайны",
  new_product: "Новые SKU",
  update: "Обновления",
  conflict: "Конфликты",
  noop: "Без изменений",
};

const STATUS_LABELS: Record<string, string> = {
  new_design: "Новый дизайн",
  new_product: "Новый SKU",
  update: "Обновить",
  noop: "Без изменений",
  conflict: "Конфликт",
  skipped: "Пропущено",
  applied: "Применено",
  error: "Ошибка",
};

function statusBadge(item: OzonImportItem) {
  if (item.status === "conflict" || item.status === "error") return "destructive" as const;
  if (item.status === "noop") return "outline" as const;
  if (item.status === "update") return "secondary" as const;
  return "default" as const;
}

function actionText(item: OzonImportItem) {
  if (item.errors.length > 0) return item.errors.join("; ");
  if (item.actions.length === 0) return "Ничего не менять";
  return item.actions
    .map((action) => {
      if (action.type === "create_design") return `создать дизайн ${action.code} ${action.designType}`;
      if (action.type === "create_product") return "создать SKU";
      if (action.type === "update_product") {
        const fields = [
          "salePrice" in action.patch ? "цену" : "",
          ["sku", "ozonSku", "addLegacySku"].some((key) => key in action.patch)
            ? "артикул или привязку"
            : "",
        ].filter(Boolean).join(" и ");
        return `обновить ${fields}`;
      }
      return "";
    })
    .join("; ");
}

function makeDesignDrafts(suggestions: DesignSuggestion[]) {
  return Object.fromEntries(
    suggestions.map((suggestion) => [
      suggestion.key,
      { name: suggestion.name, imageUrl: suggestion.imageUrl ?? "" },
    ]),
  ) as Record<string, DesignDraft>;
}

export default function OzonImportPage() {
  const [preview, setPreview] = useState<OzonImportPreview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DesignDraft>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<OzonImportApplyResult | null>(null);
  const [selection, setSelection] = useState<OzonImportSelection>({
    ...DEFAULT_OZON_IMPORT_SELECTION,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function scan() {
    setLoading(true);
    setApplyResult(null);
    const t = toast.loading("Сканирую товары Ozon…");
    try {
      const next = await api.createOzonImportPreview();
      setPreview(next);
      setDrafts(makeDesignDrafts(next.designSuggestions));
      setSelection({ ...DEFAULT_OZON_IMPORT_SELECTION });
      toast.success(
        `План готов: ${next.summary.createDesigns} дизайнов, ${next.summary.createProducts} SKU, ${next.summary.updateProducts} обновлений`,
        { id: t },
      );
    } catch (error) {
      toast.error(errorMessage(error), { id: t });
    } finally {
      setLoading(false);
    }
  }

  async function applyImport() {
    if (!preview) return;
    setApplying(true);
    const t = toast.loading("Применяю импорт…");
    try {
      const designOverrides = Object.fromEntries(
        Object.entries(drafts).map(([key, draft]) => [
          key,
          { name: draft.name.trim(), imageUrl: draft.imageUrl.trim() || null },
        ]),
      );
      const result = await api.applyOzonImport(
        preview.runId,
        designOverrides,
        selection,
      );
      setApplyResult(result);
      setConfirmOpen(false);
      toast.success(
        `Импорт применён: ${result.summary.createdDesigns} дизайнов, ${result.summary.createdProducts} SKU, ${result.summary.updatedIdentifiers} привязок, ${result.summary.updatedPrices} цен`,
        { id: t },
      );
    } catch (error) {
      toast.error(errorMessage(error), { id: t });
    } finally {
      setApplying(false);
    }
  }

  const filteredItems = useMemo(() => {
    if (!preview) return [];
    return preview.items.filter((item) => {
      if (filter !== "all" && item.status !== filter) return false;
      if (search) {
        const needle = search.toLowerCase();
        const haystack = [item.offerId, item.ozonName, item.parsed?.designCode, item.errors.join(" ")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [preview, filter, search]);

  const counts = useMemo(() => {
    const base: Record<Filter, number> = {
      all: preview?.items.length ?? 0,
      new_design: 0,
      new_product: 0,
      update: 0,
      conflict: 0,
      noop: 0,
    };
    for (const item of preview?.items ?? []) {
      if (item.status in base) base[item.status as Filter]++;
    }
    return base;
  }, [preview]);

  const operationCounts = useMemo(() => countOperations(preview), [preview]);
  const selectedOperationCount =
    (selection.createDesigns ? operationCounts.designs : 0)
    + (selection.createProducts ? operationCounts.products : 0)
    + (selection.updateIdentifiers ? operationCounts.identifiers : 0)
    + (selection.updatePrices ? operationCounts.prices : 0);
  const canApplySelection = Boolean(
    preview?.canApply
    && !applyResult
    && selectedOperationCount > 0,
  );

  function updateSelection(key: keyof OzonImportSelection, checked: boolean) {
    setSelection((current) => {
      const next = { ...current, [key]: checked };
      if (key === "createProducts" && checked && operationCounts.designs > 0) {
        next.createDesigns = true;
      }
      if (key === "createDesigns" && !checked && operationCounts.designs > 0) {
        next.createProducts = false;
      }
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        title="Импорт Ozon"
        description="Сверка Ozon с локальным каталогом и выбор конкретных изменений для применения"
        action={
          <>
            <Button variant="outline" onClick={scan} disabled={loading || applying}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Сканировать Ozon
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={!canApplySelection || loading || applying}
            >
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
              Применить выбранное
            </Button>
          </>
        }
      />

      {!preview ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={DownloadCloud}
              title="Импорт ещё не запускался"
              description="Сначала запустите dry-run: админка прочитает Ozon, сравнит с локальным каталогом и покажет план без записи."
              action={<Button onClick={scan} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Сканировать Ozon</Button>}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
            <Metric label="Товаров Ozon" value={preview.summary.totalOzonItems} />
            <Metric label="Новых дизайнов" value={preview.summary.createDesigns} />
            <Metric label="Новых SKU" value={preview.summary.createProducts} />
            <Metric label="Привязок" value={operationCounts.identifiers} />
            <Metric label="Изменений цен" value={operationCounts.prices} />
            <Metric label="Конфликтов" value={preview.summary.conflicts} tone={preview.summary.conflicts > 0 ? "bad" : "ok"} />
            <Metric label="Без изменений" value={preview.summary.noop} />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Что применить</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="grid divide-y border-t md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-4">
                <OperationToggle
                  id="import-designs"
                  icon={Palette}
                  title="Новые дизайны"
                  description="Название, тип и изображение дизайна"
                  count={operationCounts.designs}
                  checked={selection.createDesigns}
                  disabled={operationCounts.designs === 0 || (
                    selection.createProducts && operationCounts.designs > 0
                  )}
                  onCheckedChange={(checked) => updateSelection("createDesigns", checked)}
                />
                <OperationToggle
                  id="import-products"
                  icon={PackagePlus}
                  title="Новые товары"
                  description="SKU, размер, цвет, ткань и Ozon SKU"
                  count={operationCounts.products}
                  checked={selection.createProducts}
                  disabled={operationCounts.products === 0}
                  onCheckedChange={(checked) => updateSelection("createProducts", checked)}
                />
                <OperationToggle
                  id="import-identifiers"
                  icon={Link2}
                  title="Артикулы и привязки"
                  description="Изменения SKU, Ozon SKU и legacy SKU"
                  count={operationCounts.identifiers}
                  checked={selection.updateIdentifiers}
                  disabled={operationCounts.identifiers === 0}
                  onCheckedChange={(checked) => updateSelection("updateIdentifiers", checked)}
                />
                <OperationToggle
                  id="import-prices"
                  icon={CircleDollarSign}
                  title="Цены"
                  description="Цены существующих и новых SKU; по умолчанию выключено"
                  count={operationCounts.prices}
                  checked={selection.updatePrices}
                  disabled={operationCounts.prices === 0 && operationCounts.products === 0}
                  warning
                  onCheckedChange={(checked) => updateSelection("updatePrices", checked)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1">
                <div className="text-sm font-medium">Preview `{preview.runId}`</div>
                <div className="text-xs text-muted-foreground">
                  Создан {formatDate(preview.createdAt)}. Применение пропускает конфликты и строки без изменений.
                </div>
              </div>
              {applyResult && (
                <div className="flex items-center gap-2 text-sm">
                  {applyResult.status === "applied" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                  )}
                  <span>
                    Создано: {applyResult.summary.createdDesigns} дизайнов, {applyResult.summary.createdProducts} SKU.
                    Обновлено привязок: {applyResult.summary.updatedIdentifiers}, цен: {applyResult.summary.updatedPrices}.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {preview.designSuggestions.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Новые дизайны</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {preview.designSuggestions.map((suggestion) => {
                  const draft = drafts[suggestion.key] ?? { name: suggestion.name, imageUrl: suggestion.imageUrl ?? "" };
                  return (
                    <div key={suggestion.key} className="rounded-md border p-3 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="secondary">{suggestion.code}</Badge>
                        <span className="text-xs text-muted-foreground">{suggestion.designType}</span>
                      </div>
                      <Input
                        value={draft.name}
                        disabled={!selection.createDesigns}
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [suggestion.key]: { ...draft, name: event.target.value },
                        }))}
                        placeholder="Название дизайна"
                      />
                      <Input
                        value={draft.imageUrl}
                        disabled={!selection.createDesigns}
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [suggestion.key]: { ...draft, imageUrl: event.target.value },
                        }))}
                        placeholder="URL изображения"
                      />
                      <div className="text-[11px] text-muted-foreground">
                        Товаров: {suggestion.offers.length}. Пример: <span className="font-mono">{suggestion.offers[0]}</span>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Поиск по артикулу, названию, ошибке…"
                    className="pl-8"
                  />
                </div>
                <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
                  <TabsList className="flex h-auto flex-wrap justify-start">
                    {(Object.keys(FILTER_LABELS) as Filter[]).map((key) => (
                      <TabsTrigger key={key} value={key}>
                        {FILTER_LABELS[key]} ({counts[key]})
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[190px]">Артикул</TableHead>
                      <TableHead>Статус</TableHead>
                      <TableHead className="min-w-[260px]">План</TableHead>
                      <TableHead>Матчинг</TableHead>
                      <TableHead>Разбор</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredItems.map((item) => (
                      <TableRow key={item.id ?? item.offerId}>
                        <TableCell>
                          <div className="font-mono text-xs">{item.offerId}</div>
                          <div className="mt-1 max-w-[360px] truncate text-xs text-muted-foreground">{item.ozonName}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusBadge(item)}>{STATUS_LABELS[item.status] ?? item.status}</Badge>
                        </TableCell>
                        <TableCell className={item.errors.length > 0 ? "text-destructive" : ""}>
                          <div className="text-sm">{actionText(item)}</div>
                          {item.warnings.length > 0 && (
                            <div className="mt-1 text-xs text-amber-700">{item.warnings.join("; ")}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">{item.matchReason}</div>
                          {item.targetProductId && (
                            <div className="mt-1 font-mono text-[11px] text-muted-foreground">{item.targetProductId}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          {item.parsed ? (
                            <div className="text-xs text-muted-foreground">
                              {item.parsed.designCode} / {item.parsed.categorySlug} / {item.parsed.decorationSlug} / {item.parsed.colorCode} / {item.parsed.sizeName}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {filteredItems.length === 0 && (
                <div className="p-8 text-center text-sm text-muted-foreground">Нет строк под выбранный фильтр.</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Применить выбранные изменения?</DialogTitle>
            <DialogDescription>
              Preview будет закрыт после применения. Для другой группы изменений потребуется новый scan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {selection.createDesigns && operationCounts.designs > 0 && (
              <ConfirmLine label="Новые дизайны" value={operationCounts.designs} />
            )}
            {selection.createProducts && operationCounts.products > 0 && (
              <ConfirmLine label="Новые товары" value={operationCounts.products} />
            )}
            {selection.updateIdentifiers && operationCounts.identifiers > 0 && (
              <ConfirmLine label="Артикулы и привязки" value={operationCounts.identifiers} />
            )}
            {selection.updatePrices && (
              <ConfirmLine
                label="Цены"
                value={operationCounts.prices + (
                  selection.createProducts ? operationCounts.products : 0
                )}
                destructive
              />
            )}
            {!selection.updatePrices && selection.createProducts && (
              <div className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
                У новых товаров цена продажи останется пустой.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={applying}>
              Отмена
            </Button>
            <Button onClick={applyImport} disabled={applying || !canApplySelection}>
              {applying && <Loader2 className="animate-spin" />}
              Применить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OperationToggle({
  id,
  icon: Icon,
  title,
  description,
  count,
  checked,
  disabled,
  warning = false,
  onCheckedChange,
}: {
  id: string;
  icon: typeof Palette;
  title: string;
  description: string;
  count: number;
  checked: boolean;
  disabled: boolean;
  warning?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-28 cursor-pointer gap-3 p-4 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50"
      data-disabled={disabled}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <Icon className="h-4 w-4" />
            {title}
          </div>
          <Badge variant={warning && count > 0 ? "secondary" : "outline"}>{count}</Badge>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}

function ConfirmLine({
  label,
  value,
  destructive = false,
}: {
  label: string;
  value: number;
  destructive?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b py-2 last:border-b-0">
      <span>{label}</span>
      <span className={destructive ? "font-semibold text-destructive" : "font-semibold"}>{value}</span>
    </div>
  );
}

function countOperations(preview: OzonImportPreview | null) {
  const designKeys = new Set<string>();
  let products = 0;
  let identifiers = 0;
  let prices = 0;
  for (const item of preview?.items ?? []) {
    for (const action of item.actions) {
      if (action.type === "create_design") {
        designKeys.add(`${action.code}|${action.designType}`);
      } else if (action.type === "create_product") {
        products += 1;
      } else {
        if ("salePrice" in action.patch) prices += 1;
        if (["sku", "ozonSku", "addLegacySku"].some((key) => key in action.patch)) {
          identifiers += 1;
        }
      }
    }
  }
  return { designs: designKeys.size, products, identifiers, prices };
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "bad" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={tone === "bad" ? "mt-1 text-2xl font-semibold text-destructive" : tone === "ok" ? "mt-1 text-2xl font-semibold text-emerald-700" : "mt-1 text-2xl font-semibold"}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
