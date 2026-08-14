"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Barcode,
  Boxes,
  ClipboardCheck,
  CornerDownLeft,
  Database,
  Download,
  FileCheck2,
  FileUp,
  History,
  KeyRound,
  Laptop,
  BadgeCheck,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  Pencil,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Usb,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
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
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  MarkingCodeImportBatch,
  MarkingCodeImportDetail,
  MarkingCodePoolItem,
  MarkingCodePoolSummary,
  MarkingCrptWorkspace,
  MarkingConflictItem,
  MarkingAssignmentListItem,
  MarkingEventListItem,
  MarkingJitCandidate,
  MarkingOzonBatchListItem,
  MarkingProcessListItem,
  MarkingProfileBackfillDetail,
  MarkingReadinessItem,
  MarkingReturnCase,
} from "@/lib/marking/read-models/types";
import { formatDate } from "@/lib/utils";
import {
  downloadMarkingLabel,
  postMarkingMutation,
} from "@/lib/marking/client";
import { SuzOrdersPanel } from "@/components/marking/suz-orders-panel";

type ApiPage<T> = {
  ok: true;
  data: T[];
  page: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};

type PoolApiPage = ApiPage<MarkingCodePoolItem> & {
  summary: MarkingCodePoolSummary;
};

type ReturnWorkspace = {
  items: MarkingReturnCase[];
  warehouses: Array<{ id: string; name: string }>;
  runtime: { enabled: boolean; syncEnabled: boolean };
};

const EMPTY_RETURN_WORKSPACE: ReturnWorkspace = {
  items: [],
  warehouses: [],
  runtime: { enabled: false, syncEnabled: false },
};

type PageState<T> = {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
};

type ReadinessFilters = {
  search: string;
  status: string;
  channel: string;
  conflictsOnly: boolean;
};

const EMPTY_PAGE = {
  items: [],
  cursor: null,
  hasMore: false,
  loading: true,
};

const EMPTY_FILTERS: ReadinessFilters = {
  search: "",
  status: "all",
  channel: "all",
  conflictsOnly: false,
};

const EMPTY_POOL_SUMMARY: MarkingCodePoolSummary = {
  total: 0,
  available: 0,
  reserved: 0,
  bound: 0,
  quarantined: 0,
  invalid: 0,
  terminal: 0,
};

const EMPTY_CRPT_WORKSPACE: MarkingCrptWorkspace = {
  runtime: {
    enabled: false,
    readEnabled: false,
    signerEnabled: false,
    writeEnabled: false,
    introductionEnabled: false,
    withdrawalEnabled: false,
    returnsEnabled: false,
    contour: "sandbox",
    innConfigured: false,
    signerTransport: "unix",
  },
  signingAgents: [],
  signatureSummary: { pending: 0, leased: 0, failed24h: 0, signed24h: 0 },
  signatureRequests: [],
  authorization: {
    status: "not_started",
    tokenExpiresAt: null,
    certificateThumbprint: null,
    certificateValidTo: null,
    errorCode: null,
    errorMessage: null,
    updatedAt: null,
  },
  queries: [],
  documents: [],
};

export default function MarkingPage() {
  const [readiness, setReadiness] =
    useState<PageState<MarkingReadinessItem>>(EMPTY_PAGE);
  const [processes, setProcesses] =
    useState<PageState<MarkingProcessListItem>>(EMPTY_PAGE);
  const [events, setEvents] =
    useState<PageState<MarkingEventListItem>>(EMPTY_PAGE);
  const [pool, setPool] =
    useState<PageState<MarkingCodePoolItem>>(EMPTY_PAGE);
  const [poolSummary, setPoolSummary] = useState<MarkingCodePoolSummary>(
    EMPTY_POOL_SUMMARY,
  );
  const [imports, setImports] =
    useState<PageState<MarkingCodeImportBatch>>(EMPTY_PAGE);
  const [assignments, setAssignments] =
    useState<PageState<MarkingAssignmentListItem>>(EMPTY_PAGE);
  const [ozonBatches, setOzonBatches] = useState<MarkingOzonBatchListItem[]>([]);
  const [ozonBatchesLoading, setOzonBatchesLoading] = useState(true);
  const [crpt, setCrpt] = useState<MarkingCrptWorkspace>(EMPTY_CRPT_WORKSPACE);
  const [crptLoading, setCrptLoading] = useState(true);
  const [crptDocumentId, setCrptDocumentId] = useState("");
  const [returns, setReturns] = useState<ReturnWorkspace>(EMPTY_RETURN_WORKSPACE);
  const [returnsLoading, setReturnsLoading] = useState(true);
  const [selectedReturn, setSelectedReturn] = useState<MarkingReturnCase | null>(null);
  const [returnDialogOpen, setReturnDialogOpen] = useState(false);
  const [candidates, setCandidates] = useState<MarkingJitCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [assignmentActionId, setAssignmentActionId] = useState<string | null>(null);
  const [selectedAssignment, setSelectedAssignment] =
    useState<MarkingAssignmentListItem | null>(null);
  const [assignmentCancelOpen, setAssignmentCancelOpen] = useState(false);
  const [assignmentApplyOpen, setAssignmentApplyOpen] = useState(false);
  const [conflicts, setConflicts] = useState<MarkingConflictItem[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(true);
  const [filters, setFilters] = useState<ReadinessFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<ReadinessFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<MarkingReadinessItem | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [gtinOpen, setGtinOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [conformityOpen, setConformityOpen] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDetail, setImportDetail] = useState<MarkingCodeImportDetail | null>(null);
  const [selectedCode, setSelectedCode] = useState<MarkingCodePoolItem | null>(null);
  const [codeActionOpen, setCodeActionOpen] = useState(false);
  const [backfill, setBackfill] = useState<MarkingProfileBackfillDetail | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadReadiness = useCallback(async (activeFilters: ReadinessFilters) => {
    setReadiness((state) => ({ ...state, loading: true }));
    const page = await fetchPage<MarkingReadinessItem>(
      `/api/admin/marking/readiness?${readinessQuery(activeFilters)}`,
    );
    setReadiness(toPageState(page));
  }, []);

  const loadCrpt = useCallback(async (silent = false) => {
    if (!silent) setCrptLoading(true);
    try {
      setCrpt(await fetchData<MarkingCrptWorkspace>("/api/admin/marking/crpt"));
    } catch (error) {
      if (!silent) toast.error(errorMessage(error, "Не удалось обновить состояние ГИС МТ"));
    } finally {
      if (!silent) setCrptLoading(false);
    }
  }, []);

  const loadInitial = useCallback(async () => {
    setRefreshing(true);
    setProcesses((state) => ({ ...state, loading: true }));
    setEvents((state) => ({ ...state, loading: true }));
    setPool((state) => ({ ...state, loading: true }));
    setImports((state) => ({ ...state, loading: true }));
    setAssignments((state) => ({ ...state, loading: true }));
    setOzonBatchesLoading(true);
    setCrptLoading(true);
    setReturnsLoading(true);
    setCandidatesLoading(true);
    setConflictsLoading(true);
    try {
      const [
        readinessPage,
        processPage,
        eventPage,
        conflictRows,
        poolPage,
        importPage,
        assignmentPage,
        candidateRows,
        ozonBatchRows,
        crptWorkspace,
        returnWorkspace,
      ] =
        await Promise.all([
          fetchPage<MarkingReadinessItem>(
            `/api/admin/marking/readiness?${readinessQuery(appliedFilters)}`,
          ),
          fetchPage<MarkingProcessListItem>(
            "/api/admin/marking/processes?limit=50",
          ),
          fetchPage<MarkingEventListItem>("/api/admin/marking/events?limit=50"),
          fetchData<MarkingConflictItem[]>("/api/admin/marking/conflicts?limit=200"),
          fetchPoolPage("/api/admin/marking/pool?limit=50"),
          fetchPage<MarkingCodeImportBatch>("/api/admin/marking/imports?limit=30"),
          fetchPage<MarkingAssignmentListItem>(
            "/api/admin/marking/assignments?limit=50",
          ),
          fetchData<MarkingJitCandidate[]>(
            "/api/admin/marking/assignments/candidates?limit=200",
          ),
          fetchData<MarkingOzonBatchListItem[]>("/api/admin/marking/ozon?limit=50"),
          fetchData<MarkingCrptWorkspace>("/api/admin/marking/crpt"),
          fetchData<ReturnWorkspace>("/api/admin/marking/returns?limit=200"),
        ]);
      setReadiness(toPageState(readinessPage));
      setProcesses(toPageState(processPage));
      setEvents(toPageState(eventPage));
      setConflicts(conflictRows);
      setPool(toPageState(poolPage));
      setPoolSummary(poolPage.summary);
      setImports(toPageState(importPage));
      setAssignments(toPageState(assignmentPage));
      setCandidates(candidateRows);
      setOzonBatches(ozonBatchRows);
      setCrpt(crptWorkspace);
      setReturns(returnWorkspace);
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось загрузить маркировку"));
      setReadiness((state) => ({ ...state, loading: false }));
      setProcesses((state) => ({ ...state, loading: false }));
      setEvents((state) => ({ ...state, loading: false }));
      setPool((state) => ({ ...state, loading: false }));
      setImports((state) => ({ ...state, loading: false }));
      setAssignments((state) => ({ ...state, loading: false }));
      setOzonBatchesLoading(false);
      setCrptLoading(false);
      setReturnsLoading(false);
    } finally {
      setConflictsLoading(false);
      setCandidatesLoading(false);
      setOzonBatchesLoading(false);
      setCrptLoading(false);
      setReturnsLoading(false);
      setRefreshing(false);
    }
  }, [appliedFilters]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadCrpt(true), 10_000);
    return () => window.clearInterval(timer);
  }, [loadCrpt]);

  async function applyFilters(event: FormEvent) {
    event.preventDefault();
    setAppliedFilters(filters);
    try {
      await loadReadiness(filters);
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось применить фильтры"));
    }
  }

  async function refreshAfterMutation() {
    setProfileOpen(false);
    setGtinOpen(false);
    setEvidenceOpen(false);
    setConformityOpen(false);
    setSelected(null);
    await loadInitial();
  }

  async function prepareAssignment(item: MarkingJitCandidate) {
    setAssignmentActionId(item.fulfillmentItemId);
    try {
      const prepared = await postMutation<{ unitOrdinal: number }>(
        "/api/admin/marking/assignments",
        {
          fulfillmentItemId: item.fulfillmentItemId,
          warehouseId: item.warehouseId,
        },
      );
      toast.success(`КМ зарезервирован для единицы ${prepared.unitOrdinal}`);
      await loadInitial();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось зарезервировать КМ"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function downloadAssignmentLabel(item: MarkingAssignmentListItem) {
    setAssignmentActionId(`label:${item.id}`);
    try {
      await downloadMarkingLabel({
        assignmentId: item.id,
        expectedRevision: item.assignmentRevision,
        postingNumber: item.postingNumber,
        unitOrdinal: item.unitOrdinal,
      });
      toast.success(
        item.renderCount === 0
          ? "Этикетка 58x40 сформирована"
          : "Повторная этикетка сформирована",
      );
      await loadInitial();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось сформировать этикетку"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function confirmAssignmentApplied(item: MarkingAssignmentListItem) {
    setAssignmentActionId(`apply:${item.id}`);
    try {
      await postMarkingMutation(
        `/api/admin/marking/assignments/${item.id}/apply`,
        { expectedRevision: item.assignmentRevision },
      );
      toast.success("Нанесение КМ подтверждено, склад обновлён");
      setAssignmentApplyOpen(false);
      setSelectedAssignment(null);
      await loadInitial();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось подтвердить нанесение КМ"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function runAssignmentOzonOperation(
    item: MarkingAssignmentListItem,
    operation: "validate" | "submit",
  ) {
    setAssignmentActionId(`ozon:${operation}:${item.fulfillmentOrderId}`);
    try {
      await postMarkingMutation("/api/admin/marking/ozon", {
        fulfillmentOrderId: item.fulfillmentOrderId,
        operation,
      });
      toast.success(
        operation === "validate"
          ? "Проверка КМ в Ozon поставлена в очередь"
          : "Передача КМ в Ozon поставлена в очередь",
      );
      await loadInitial();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось запустить операцию Ozon"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function correctOzonBatch(item: MarkingOzonBatchListItem) {
    setAssignmentActionId(`ozon:correct:${item.id}`);
    try {
      await postMarkingMutation("/api/admin/marking/ozon", {
        fulfillmentOrderId: item.fulfillmentOrderId,
        operation: "validate",
        forceCorrection: true,
      });
      toast.success("Исправленный пакет поставлен на повторную проверку Ozon");
      await loadInitial();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось создать исправление Ozon"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function syncReturns() {
    setAssignmentActionId("returns:sync");
    try {
      await postMarkingMutation("/api/admin/marking/returns", { operation: "sync" });
      toast.success("Синхронизация возвратов Ozon поставлена в очередь");
      await loadInitial();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось запустить синхронизацию возвратов"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function runReturnOperation(
    item: MarkingReturnCase,
    operation: "confirm_direction" | "prepare" | "retry" | "receive_seller" | "confirm_fbo",
    values: Record<string, unknown> = {},
  ) {
    setAssignmentActionId(`return:${operation}:${item.id}`);
    try {
      await postMarkingMutation("/api/admin/marking/returns", {
        operation,
        returnCaseId: item.id,
        expectedVersion: item.version,
        ...values,
      });
      toast.success(returnOperationSuccess(operation));
      setReturnDialogOpen(false);
      setSelectedReturn(null);
      await loadInitial();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось обновить возврат"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function runCrptOperation(
    operation: "refresh_auth" | "check_code" | "check_document"
      | "retry_introduction" | "retry_circulation" | "retry_withdrawal",
    subject?: string,
  ) {
    const key = `crpt:${operation}:${subject ?? "auth"}`;
    setAssignmentActionId(key);
    try {
      await postMarkingMutation("/api/admin/marking/crpt", {
        operation,
        ...(operation === "check_code" ? { markingCodeId: subject } : {}),
        ...(operation === "check_document" ? { externalDocumentId: subject } : {}),
        ...(operation === "retry_introduction" ? { assignmentId: subject } : {}),
        ...(operation === "retry_circulation" ? { documentId: subject } : {}),
        ...(operation === "retry_withdrawal" ? { handoverId: subject } : {}),
      });
      toast.success(
        operation === "refresh_auth"
          ? "Проверка авторизации ГИС МТ поставлена в очередь"
          : operation === "retry_introduction"
            ? "Новая ревизия ввода в оборот поставлена в очередь"
          : operation === "retry_circulation"
            ? "Повторная проверка статуса КМ поставлена в очередь"
          : operation === "retry_withdrawal"
            ? "Новая ревизия вывода из оборота поставлена в очередь"
          : "Проверка статуса ГИС МТ поставлена в очередь",
      );
      if (operation === "check_document") setCrptDocumentId("");
      await loadCrpt();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось запустить проверку ГИС МТ"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  async function reconcileCrptIntroductionDocument(
    localDocumentId: string,
    externalDocumentId: string,
  ) {
    const key = `crpt:reconcile_introduction:${localDocumentId}`;
    setAssignmentActionId(key);
    try {
      await postMarkingMutation("/api/admin/marking/crpt", {
        operation: "reconcile_introduction",
        documentId: localDocumentId,
        externalDocumentId,
      });
      toast.success("Документ сверен с ГИС МТ");
      setCrptDocumentId("");
      await loadCrpt();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось сверить документ ГИС МТ"));
    } finally {
      setAssignmentActionId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Честный знак"
        description="Готовность товаров, конфликты и операционная история маркировки"
        action={(
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setImportOpen(true)}>
              <FileUp />
              Импорт КМ
            </Button>
            <Button variant="outline" onClick={() => setBackfillOpen(true)}>
              <Database />
              Backfill профилей
            </Button>
            <Button variant="outline" onClick={loadInitial} disabled={refreshing}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              Обновить
            </Button>
          </div>
        )}
      />

      <Tabs defaultValue="readiness">
        <TabsList className="mb-4 h-auto flex-wrap justify-start">
          <TabsTrigger value="readiness">
            <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />
            Товары
          </TabsTrigger>
          <TabsTrigger value="conflicts">
            <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
            Конфликты
            {conflicts.length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {conflicts.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pool">
            <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
            Пул КМ
            {poolSummary.available > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {poolSummary.available}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="imports">
            <FileUp className="mr-1.5 h-3.5 w-3.5" />
            Импорты
          </TabsTrigger>
          <TabsTrigger value="suz">
            <Boxes className="mr-1.5 h-3.5 w-3.5" />
            Заказы КМ
          </TabsTrigger>
          <TabsTrigger value="assignments">
            <PackagePlus className="mr-1.5 h-3.5 w-3.5" />
            Назначения
            {assignments.items.filter((item) => item.assignmentStatus === "active").length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {assignments.items.filter((item) => item.assignmentStatus === "active").length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="processes">
            <Activity className="mr-1.5 h-3.5 w-3.5" />
            Процессы
          </TabsTrigger>
          <TabsTrigger value="ozon">
            <Send className="mr-1.5 h-3.5 w-3.5" />
            Ozon
          </TabsTrigger>
          <TabsTrigger value="returns">
            <CornerDownLeft className="mr-1.5 h-3.5 w-3.5" />
            Возвраты
            {returns.items.filter((item) => item.processStatus !== "completed"
              && item.processStatus !== "cancelled").length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {returns.items.filter((item) => item.processStatus !== "completed"
                  && item.processStatus !== "cancelled").length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="crpt">
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            ГИС МТ
          </TabsTrigger>
          <TabsTrigger value="events">
            <History className="mr-1.5 h-3.5 w-3.5" />
            История
          </TabsTrigger>
        </TabsList>

        <TabsContent value="readiness">
          <ReadinessToolbar
            filters={filters}
            setFilters={setFilters}
            onSubmit={applyFilters}
          />
          <ReadinessTable
            state={readiness}
            setState={setReadiness}
            query={readinessQuery(appliedFilters)}
            onEdit={(item) => {
              setSelected(item);
              setProfileOpen(true);
            }}
            onGtin={(item) => {
              setSelected(item);
              setGtinOpen(true);
            }}
            onEvidence={(item) => {
              setSelected(item);
              setEvidenceOpen(true);
            }}
            onConformity={(item) => {
              setSelected(item);
              setConformityOpen(true);
            }}
          />
        </TabsContent>
        <TabsContent value="conflicts">
          <ConflictTable items={conflicts} loading={conflictsLoading} />
        </TabsContent>
        <TabsContent value="pool">
          <CodePoolTable
            state={pool}
            setState={setPool}
            summary={poolSummary}
            onAction={(item) => {
              setSelectedCode(item);
              setCodeActionOpen(true);
            }}
            crptReadEnabled={crpt.runtime.readEnabled}
            actionId={assignmentActionId}
            onCrptCheck={(item) => runCrptOperation("check_code", item.id)}
          />
        </TabsContent>
        <TabsContent value="imports">
          <CodeImportTable
            state={imports}
            setState={setImports}
            onOpen={async (batch) => {
              try {
                const detail = await fetchData<MarkingCodeImportDetail>(
                  `/api/admin/marking/imports/${batch.id}`,
                );
                setImportDetail(detail);
                setImportOpen(true);
              } catch (error) {
                toast.error(errorMessage(error, "Не удалось открыть импорт"));
              }
            }}
          />
        </TabsContent>
        <TabsContent value="suz">
          <SuzOrdersPanel />
        </TabsContent>
        <TabsContent value="assignments">
          <div className="space-y-4">
            <JitCandidateTable
              items={candidates}
              loading={candidatesLoading}
              actionId={assignmentActionId}
              onPrepare={prepareAssignment}
            />
            <AssignmentTable
              state={assignments}
              setState={setAssignments}
              actionId={assignmentActionId}
              onDownload={downloadAssignmentLabel}
              onApply={(item) => {
                setSelectedAssignment(item);
                setAssignmentApplyOpen(true);
              }}
              onCancel={(item) => {
                setSelectedAssignment(item);
                setAssignmentCancelOpen(true);
              }}
              onOzon={runAssignmentOzonOperation}
            />
          </div>
        </TabsContent>
        <TabsContent value="processes">
          <ProcessTable state={processes} setState={setProcesses} />
        </TabsContent>
        <TabsContent value="ozon">
          <OzonBatchTable
            items={ozonBatches}
            loading={ozonBatchesLoading}
            actionId={assignmentActionId}
            onCorrect={correctOzonBatch}
          />
        </TabsContent>
        <TabsContent value="returns">
          <ReturnCaseTable
            workspace={returns}
            loading={returnsLoading}
            actionId={assignmentActionId}
            onSync={syncReturns}
            onOpen={(item) => {
              setSelectedReturn(item);
              setReturnDialogOpen(true);
            }}
            onPrepare={(item) => runReturnOperation(item, "prepare")}
            onRetry={(item) => runReturnOperation(item, "retry")}
          />
        </TabsContent>
        <TabsContent value="crpt">
          <CrptReadPanel
            workspace={crpt}
            loading={crptLoading}
            actionId={assignmentActionId}
            documentId={crptDocumentId}
            setDocumentId={setCrptDocumentId}
            onRefreshAuth={() => runCrptOperation("refresh_auth")}
            onCheckDocument={() => runCrptOperation(
              "check_document",
              crptDocumentId.trim(),
            )}
            onRetryIntroduction={(assignmentId) => runCrptOperation(
              "retry_introduction",
              assignmentId,
            )}
            onRetryCirculation={(documentId) => runCrptOperation(
              "retry_circulation",
              documentId,
            )}
            onRetryWithdrawal={(handoverId) => runCrptOperation(
              "retry_withdrawal",
              handoverId,
            )}
            onReconcileIntroduction={(documentId, externalDocumentId) => (
              reconcileCrptIntroductionDocument(documentId, externalDocumentId)
            )}
          />
        </TabsContent>
        <TabsContent value="events">
          <EventTable state={events} setState={setEvents} />
        </TabsContent>
      </Tabs>

      <ProfileDialog
        item={selected}
        open={profileOpen}
        onOpenChange={setProfileOpen}
        onSaved={refreshAfterMutation}
      />
      <ReturnActionDialog
        item={selectedReturn}
        warehouses={returns.warehouses}
        open={returnDialogOpen}
        onOpenChange={setReturnDialogOpen}
        loading={Boolean(assignmentActionId?.startsWith("return:"))}
        onSubmit={(operation, values) => selectedReturn
          ? runReturnOperation(selectedReturn, operation, values)
          : Promise.resolve()}
      />
      <GtinDialog
        item={selected}
        open={gtinOpen}
        onOpenChange={setGtinOpen}
        onSaved={refreshAfterMutation}
      />
      <EvidenceDialog
        item={selected}
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        onSaved={refreshAfterMutation}
      />
      <ConformityDocumentDialog
        item={selected}
        open={conformityOpen}
        onOpenChange={setConformityOpen}
        onSaved={refreshAfterMutation}
      />
      <AssignmentCancelDialog
        item={selectedAssignment}
        open={assignmentCancelOpen}
        onOpenChange={setAssignmentCancelOpen}
        onSaved={async () => {
          setAssignmentCancelOpen(false);
          setSelectedAssignment(null);
          await loadInitial();
        }}
      />
      <AssignmentApplyDialog
        item={selectedAssignment}
        open={assignmentApplyOpen}
        busy={Boolean(
          selectedAssignment
          && assignmentActionId === `apply:${selectedAssignment.id}`,
        )}
        onOpenChange={setAssignmentApplyOpen}
        onConfirm={() => {
          if (selectedAssignment) {
            void confirmAssignmentApplied(selectedAssignment);
          }
        }}
      />
      <BackfillDialog
        open={backfillOpen}
        onOpenChange={setBackfillOpen}
        detail={backfill}
        setDetail={setBackfill}
        onApplied={loadInitial}
      />
      <CodeImportDialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setImportDetail(null);
        }}
        detail={importDetail}
        setDetail={setImportDetail}
        onApplied={loadInitial}
      />
      <CodeStateDialog
        item={selectedCode}
        open={codeActionOpen}
        onOpenChange={setCodeActionOpen}
        onSaved={async () => {
          setCodeActionOpen(false);
          setSelectedCode(null);
          await loadInitial();
        }}
      />
    </div>
  );
}

function ReadinessToolbar({
  filters,
  setFilters,
  onSubmit,
}: {
  filters: ReadinessFilters;
  setFilters: React.Dispatch<React.SetStateAction<ReadinessFilters>>;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="mb-3 grid gap-2 md:grid-cols-[minmax(240px,1fr)_180px_160px_auto_auto]"
    >
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(event) => setFilters((state) => ({
            ...state,
            search: event.target.value,
          }))}
          className="pl-9"
          placeholder="SKU, offer ID, GTIN или название"
        />
      </div>
      <Select
        value={filters.status}
        onValueChange={(status) => setFilters((state) => ({ ...state, status }))}
      >
        <SelectTrigger><SelectValue placeholder="Готовность" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Все статусы</SelectItem>
          <SelectItem value="ready">Готов</SelectItem>
          <SelectItem value="blocked">Заблокирован</SelectItem>
          <SelectItem value="not_required">Не требуется</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={filters.channel}
        onValueChange={(channel) => setFilters((state) => ({ ...state, channel }))}
      >
        <SelectTrigger><SelectValue placeholder="Канал" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Все каналы</SelectItem>
          <SelectItem value="ozon_fbs">Ozon FBS</SelectItem>
          <SelectItem value="komui">KOMUI</SelectItem>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant={filters.conflictsOnly ? "default" : "outline"}
        onClick={() => setFilters((state) => ({
          ...state,
          conflictsOnly: !state.conflictsOnly,
        }))}
      >
        <AlertTriangle />
        Только конфликты
      </Button>
      <Button type="submit">
        <Search />
        Найти
      </Button>
    </form>
  );
}

function ReadinessTable({
  state,
  setState,
  query,
  onEdit,
  onGtin,
  onEvidence,
  onConformity,
}: {
  state: PageState<MarkingReadinessItem>;
  setState: React.Dispatch<React.SetStateAction<PageState<MarkingReadinessItem>>>;
  query: string;
  onEdit: (item: MarkingReadinessItem) => void;
  onGtin: (item: MarkingReadinessItem) => void;
  onEvidence: (item: MarkingReadinessItem) => void;
  onConformity: (item: MarkingReadinessItem) => void;
}) {
  if (state.loading && state.items.length === 0) return <LoadingPanel />;
  if (state.items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={ClipboardCheck}
            title="Товары не найдены"
            description="Измените фильтры или создайте preview профилей."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel
      footer={(
        <LoadMore
          state={state}
          setState={setState}
          path={`/api/admin/marking/readiness?${query}`}
        />
      )}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SKU / канал</TableHead>
            <TableHead>Вариант</TableHead>
            <TableHead>GTIN / НК</TableHead>
            <TableHead>Политика</TableHead>
            <TableHead>Готовность</TableHead>
            <TableHead className="text-right">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.items.map((item) => (
            <TableRow key={item.productId}>
              <TableCell>
                <div className="font-mono text-xs">{item.sku ?? "Без SKU"}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {channelLabel(item.channel)}
                  {item.offerId && item.offerId !== item.sku ? ` · ${item.offerId}` : ""}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.conformityDocumentNumber
                    ? `РД: ${item.conformityDocumentNumber}`
                    : "РД для ввода в оборот не указан"}
                </div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{item.design ?? item.category ?? "Товар"}</div>
                <div className="text-xs text-muted-foreground">
                  {[item.fabric, item.color, item.size].filter(Boolean).join(" · ") || "—"}
                </div>
              </TableCell>
              <TableCell>
                <div className="font-mono text-xs">{item.gtin ?? "Не указан"}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.nationalCatalogCardId
                    ? `Карточка ${item.nationalCatalogCardId}`
                    : "Карточка НК не подтверждена"}
                </div>
              </TableCell>
              <TableCell>
                <div className="text-sm">{requirementLabel(item.markingRequirement)}</div>
                <div className="text-xs text-muted-foreground">
                  {modeLabel(item.productionMode)} · {operationalLabel(item.operationalStatus)}
                </div>
              </TableCell>
              <TableCell className="max-w-[280px]">
                <StatusBadge status={item.readinessStatus} />
                {item.conflictCount > 0 && (
                  <Badge variant="destructive" className="ml-1.5">
                    {item.conflictCount} конфликт
                  </Badge>
                )}
                {item.blockerReasons.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.blockerReasons.map(blockerLabel).join(", ")}
                  </div>
                )}
                {item.warnings.length > 0 && (
                  <div className="mt-1 text-xs text-amber-700">
                    {item.warnings.map(warningLabel).join(", ")}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Настроить профиль"
                    onClick={() => onEdit(item)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Подтвердить GTIN"
                    disabled={!item.profileId}
                    onClick={() => onGtin(item)}
                  >
                    <Barcode />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Добавить подтверждение"
                    disabled={!item.profileId}
                    onClick={() => onEvidence(item)}
                  >
                    <ShieldCheck />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Документ соответствия"
                    disabled={!item.profileId || !item.tradeItemId}
                    onClick={() => onConformity(item)}
                  >
                    <FileCheck2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function ConflictTable({
  items,
  loading,
}: {
  items: MarkingConflictItem[];
  loading: boolean;
}) {
  if (loading) return <LoadingPanel />;
  if (items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={ShieldCheck}
            title="Конфликтов нет"
            description="Проверенные связи товаров и GTIN согласованы."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Уровень</TableHead>
            <TableHead>SKU / GTIN</TableHead>
            <TableHead>Проверка</TableHead>
            <TableHead>Значения</TableHead>
            <TableHead>Обнаружено</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.conflictKey}>
              <TableCell>
                <Badge variant={item.severity === "blocking" ? "destructive" : "secondary"}>
                  {item.severity === "blocking" ? "Блокирует" : "Справочно"}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="font-mono text-xs">{item.sku ?? "—"}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {item.gtin ?? "GTIN не указан"}
                </div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{conflictTypeLabel(item.conflictType)}</div>
                <div className="text-xs text-muted-foreground">{item.message}</div>
              </TableCell>
              <TableCell className="text-xs">
                <div>Админка: {item.localValue ?? "—"}</div>
                <div className="text-muted-foreground">
                  Внешнее: {item.externalValue ?? "—"}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm">
                {formatDate(item.observedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function CodePoolTable({
  state,
  setState,
  summary,
  onAction,
  crptReadEnabled,
  actionId,
  onCrptCheck,
}: {
  state: PageState<MarkingCodePoolItem>;
  setState: React.Dispatch<React.SetStateAction<PageState<MarkingCodePoolItem>>>;
  summary: MarkingCodePoolSummary;
  onAction: (item: MarkingCodePoolItem) => void;
  crptReadEnabled: boolean;
  actionId: string | null;
  onCrptCheck: (item: MarkingCodePoolItem) => void;
}) {
  if (state.loading && state.items.length === 0) return <LoadingPanel />;
  if (state.items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={PackageCheck}
            title="Пул КМ пуст"
            description="Выполните защищённый импорт кодов для проверенного GTIN."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel
      footer={(
        <LoadMore
          state={state}
          setState={setState}
          path="/api/admin/marking/pool"
        />
      )}
    >
      <div className="grid grid-cols-2 gap-px border-b bg-border md:grid-cols-6">
        {[
          ["Всего", summary.total],
          ["Доступно", summary.available],
          ["Резерв", summary.reserved],
          ["Назначено", summary.bound],
          ["Карантин", summary.quarantined],
          ["Недоступно", summary.invalid + summary.terminal],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-background px-4 py-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>GTIN / товары</TableHead>
            <TableHead>Fingerprint</TableHead>
            <TableHead>Пул</TableHead>
            <TableHead>ГИС МТ</TableHead>
            <TableHead>Получен</TableHead>
            <TableHead className="text-right">Действие</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="font-mono text-xs">{item.gtin}</div>
                <div className="mt-1 max-w-[300px] truncate text-xs text-muted-foreground">
                  {item.productSkus.join(", ") || "Профиль без SKU"}
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs">{item.fingerprint}</TableCell>
              <TableCell>
                <StatusBadge status={item.poolState} />
                {item.blockedReason && (
                  <div className="mt-1 max-w-[240px] text-xs text-muted-foreground">
                    {item.blockedReason}
                  </div>
                )}
              </TableCell>
              <TableCell><StatusBadge status={item.crptState} /></TableCell>
              <TableCell className="whitespace-nowrap text-sm">
                {formatDate(item.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="icon"
                  variant="ghost"
                  title="Проверить статус КМ в ГИС МТ"
                  disabled={!crptReadEnabled || actionId === `crpt:check_code:${item.id}`}
                  onClick={() => onCrptCheck(item)}
                >
                  <RefreshCw className={
                    actionId === `crpt:check_code:${item.id}` ? "animate-spin" : ""
                  } />
                </Button>
                {["available", "quarantined"].includes(item.poolState) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title={item.poolState === "available"
                      ? "Поместить в карантин"
                      : "Вернуть из карантина"}
                    onClick={() => onAction(item)}
                  >
                    {item.poolState === "available" ? <ShieldAlert /> : <RotateCcw />}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function CodeImportTable({
  state,
  setState,
  onOpen,
}: {
  state: PageState<MarkingCodeImportBatch>;
  setState: React.Dispatch<React.SetStateAction<PageState<MarkingCodeImportBatch>>>;
  onOpen: (item: MarkingCodeImportBatch) => void;
}) {
  if (state.loading && state.items.length === 0) return <LoadingPanel />;
  if (state.items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={FileUp}
            title="Импортов нет"
            description="Preview загруженных файлов появятся здесь."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel
      footer={(
        <LoadMore
          state={state}
          setState={setState}
          path="/api/admin/marking/imports"
        />
      )}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Файл</TableHead>
            <TableHead>GTIN</TableHead>
            <TableHead>Строки</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead>Создан</TableHead>
            <TableHead className="text-right">Открыть</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="font-medium">{item.filename ?? "Без имени"}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {item.fileSha256.slice(0, 12)}
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs">{item.expectedGtin}</TableCell>
              <TableCell className="text-sm">
                <div>{item.rowsValid} валидных</div>
                <div className="text-xs text-muted-foreground">
                  {item.rowsDuplicate} дублей · {item.rowsRejected} отклонено
                </div>
              </TableCell>
              <TableCell><StatusBadge status={item.status} /></TableCell>
              <TableCell className="whitespace-nowrap text-sm">
                {formatDate(item.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="icon"
                  variant="ghost"
                  title="Открыть импорт"
                  onClick={() => onOpen(item)}
                >
                  <Pencil />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function JitCandidateTable({
  items,
  loading,
  actionId,
  onPrepare,
}: {
  items: MarkingJitCandidate[];
  loading: boolean;
  actionId: string | null;
  onPrepare: (item: MarkingJitCandidate) => void;
}) {
  if (loading && items.length === 0) return <LoadingPanel />;
  if (items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={PackagePlus}
            title="Нет строк для подготовки"
            description="Активные маркируемые позиции появятся после синхронизации заказов."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel>
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Ожидают КМ</h2>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Заказ / товар</TableHead>
            <TableHead>Единицы</TableHead>
            <TableHead>GTIN / КМ</TableHead>
            <TableHead>Производство</TableHead>
            <TableHead className="text-right">Действие</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const blocker = item.prepareBlocker;
            return (
              <TableRow key={`${item.fulfillmentItemId}:${item.warehouseId}`}>
                <TableCell>
                  <div className="font-medium">
                    {item.postingNumber ?? item.fulfillmentOrderId.slice(0, 8)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {item.offerId ?? item.sku ?? "Без артикула"}
                  </div>
                </TableCell>
                <TableCell>
                  <div>{item.activeAssignmentCount} из {item.quantity}</div>
                  <div className="text-xs text-muted-foreground">
                    Осталось: {item.unassignedQuantity}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-mono text-xs">{item.gtin ?? "Не задан"}</div>
                  <div className="text-xs text-muted-foreground">
                    Доступно КМ: {item.availableCodeCount}
                  </div>
                </TableCell>
                <TableCell>
                  <div>{item.warehouseName}</div>
                  <div className="text-xs text-muted-foreground">
                    Пустые: {item.blankQuantity}
                    {item.decorationSlug === "print"
                      ? ` · принты: ${item.decorationQuantity}`
                      : ""}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    title={blocker ?? "Зарезервировать КМ"}
                    disabled={Boolean(blocker) || actionId === item.fulfillmentItemId}
                    onClick={() => onPrepare(item)}
                  >
                    <PackagePlus
                      className={actionId === item.fulfillmentItemId ? "animate-pulse" : ""}
                    />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function AssignmentTable({
  state,
  setState,
  actionId,
  onDownload,
  onApply,
  onCancel,
  onOzon,
}: {
  state: PageState<MarkingAssignmentListItem>;
  setState: React.Dispatch<
    React.SetStateAction<PageState<MarkingAssignmentListItem>>
  >;
  actionId: string | null;
  onDownload: (item: MarkingAssignmentListItem) => void;
  onApply: (item: MarkingAssignmentListItem) => void;
  onCancel: (item: MarkingAssignmentListItem) => void;
  onOzon: (
    item: MarkingAssignmentListItem,
    operation: "validate" | "submit",
  ) => void;
}) {
  if (state.loading && state.items.length === 0) return <LoadingPanel />;
  if (state.items.length === 0) return null;
  return (
    <TablePanel
      footer={(
        <LoadMore
          state={state}
          setState={setState}
          path="/api/admin/marking/assignments"
        />
      )}
    >
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Назначенные единицы</h2>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Заказ / единица</TableHead>
            <TableHead>КМ</TableHead>
            <TableHead>Физическое состояние</TableHead>
            <TableHead>ГИС МТ / Ozon</TableHead>
            <TableHead>Последнее действие</TableHead>
            <TableHead className="text-right">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="font-medium">
                  {item.postingNumber ?? item.fulfillmentOrderId.slice(0, 8)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {item.unitOrdinal}/{item.itemQuantity}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.offerId ?? item.sku ?? item.internalSerial}
                </div>
              </TableCell>
              <TableCell>
                <div className="font-mono text-xs">{item.codeFingerprint}</div>
                <div className="font-mono text-xs text-muted-foreground">{item.gtin}</div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <StatusBadge status={item.assignmentStatus} />
                  <StatusBadge status={item.labelState} />
                  <StatusBadge status={item.unitState} />
                </div>
                {item.renderCount > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Выдач этикетки: {item.renderCount}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <StatusBadge status={item.crptState} />
                  <StatusBadge status={item.ozonState} />
                </div>
                {item.shippingBlocker && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.shippingBlocker}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-sm">
                <div>{item.lastEventType ? statusLabel(item.lastEventType) : "—"}</div>
                <div className="text-xs text-muted-foreground">
                  {formatDate(item.lastEventAt ?? item.updatedAt)}
                </div>
                {item.lastErrorCode && (
                  <div className="text-xs text-destructive">{item.lastErrorCode}</div>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  {item.renderCount === 0 && item.canRenderLabel && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Скачать КМ 58x40"
                      disabled={actionId === `label:${item.id}`}
                      onClick={() => onDownload(item)}
                    >
                      <Download
                        className={
                          actionId === `label:${item.id}` ? "animate-pulse" : ""
                        }
                      />
                    </Button>
                  )}
                  {item.renderCount > 0 && item.canReprintLabel && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Повторная печать той же этикетки"
                      disabled={actionId === `label:${item.id}`}
                      onClick={() => onDownload(item)}
                    >
                      <Printer
                        className={
                          actionId === `label:${item.id}` ? "animate-pulse" : ""
                        }
                      />
                    </Button>
                  )}
                  {item.canConfirmApplied && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Подтвердить физическое нанесение КМ"
                      disabled={actionId === `apply:${item.id}`}
                      onClick={() => onApply(item)}
                    >
                      <BadgeCheck
                        className={
                          actionId === `apply:${item.id}` ? "animate-pulse" : ""
                        }
                      />
                    </Button>
                  )}
                  {item.canValidateOzon && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Проверить КМ в Ozon"
                      disabled={actionId === `ozon:validate:${item.fulfillmentOrderId}`}
                      onClick={() => onOzon(item, "validate")}
                    >
                      <ShieldCheck
                        className={
                          actionId === `ozon:validate:${item.fulfillmentOrderId}`
                            ? "animate-pulse"
                            : ""
                        }
                      />
                    </Button>
                  )}
                  {item.canSubmitOzon && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Передать КМ в Ozon"
                      disabled={actionId === `ozon:submit:${item.fulfillmentOrderId}`}
                      onClick={() => onOzon(item, "submit")}
                    >
                      <Send
                        className={
                          actionId === `ozon:submit:${item.fulfillmentOrderId}`
                            ? "animate-pulse"
                            : ""
                        }
                      />
                    </Button>
                  )}
                  {item.canCancel && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Отменить подготовку"
                      onClick={() => onCancel(item)}
                    >
                      <XCircle />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function OzonBatchTable({
  items,
  loading,
  actionId,
  onCorrect,
}: {
  items: MarkingOzonBatchListItem[];
  loading: boolean;
  actionId: string | null;
  onCorrect: (item: MarkingOzonBatchListItem) => void;
}) {
  if (loading && items.length === 0) return <LoadingPanel />;
  if (items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={Send}
            title="Передач в Ozon пока нет"
            description="Пакет появится после запуска проверки КМ у подготовленного FBS-заказа."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Posting</TableHead>
            <TableHead>Ревизия</TableHead>
            <TableHead>Единицы</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead>Попытки</TableHead>
            <TableHead>Обновлён</TableHead>
            <TableHead className="w-12"><span className="sr-only">Действия</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="font-medium">{item.postingNumber}</TableCell>
              <TableCell>
                {item.requestRevision}
                {item.operationKind === "correction" && (
                  <div className="text-xs text-muted-foreground">Исправление</div>
                )}
              </TableCell>
              <TableCell>
                {item.acceptedCount}/{item.unitCount}
                {item.rejectedCount > 0 && (
                  <div className="text-xs text-destructive">
                    Отклонено: {item.rejectedCount}
                  </div>
                )}
              </TableCell>
              <TableCell><StatusBadge status={item.status} /></TableCell>
              <TableCell>{item.attemptCount}</TableCell>
              <TableCell>{formatDate(item.updatedAt)}</TableCell>
              <TableCell>
                {canCorrectOzonBatch(item.status) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Создать исправление и повторно проверить"
                    disabled={actionId === `ozon:correct:${item.id}`}
                    onClick={() => onCorrect(item)}
                  >
                    <RotateCcw
                      className={
                        actionId === `ozon:correct:${item.id}` ? "animate-spin" : ""
                      }
                    />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function canCorrectOzonBatch(status: string) {
  return [
    "validation_failed",
    "partially_rejected",
    "rejected",
    "timed_out",
    "manual_review",
  ].includes(status);
}

function ReturnCaseTable({
  workspace,
  loading,
  actionId,
  onSync,
  onOpen,
  onPrepare,
  onRetry,
}: {
  workspace: ReturnWorkspace;
  loading: boolean;
  actionId: string | null;
  onSync: () => void;
  onOpen: (item: MarkingReturnCase) => void;
  onPrepare: (item: MarkingReturnCase) => void;
  onRetry: (item: MarkingReturnCase) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant={workspace.runtime.enabled ? "default" : "secondary"}>
            Возвраты {workspace.runtime.enabled ? "включены" : "выключены"}
          </Badge>
          <Badge variant={workspace.runtime.syncEnabled ? "outline" : "secondary"}>
            Ozon sync {workspace.runtime.syncEnabled ? "включён" : "выключен"}
          </Badge>
        </div>
        <Button
          variant="outline"
          disabled={!workspace.runtime.syncEnabled || actionId === "returns:sync"}
          onClick={onSync}
        >
          <RefreshCw className={actionId === "returns:sync" ? "animate-spin" : ""} />
          Синхронизировать возвраты
        </Button>
      </div>
      {loading && workspace.items.length === 0 ? (
        <LoadingPanel />
      ) : workspace.items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={PackageOpen}
              title="Возвратов пока нет"
              description="После синхронизации здесь появятся отмены и возвраты Ozon FBS."
            />
          </CardContent>
        </Card>
      ) : (
        <TablePanel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Возврат / заказ</TableHead>
                <TableHead>Единица</TableHead>
                <TableHead>Направление</TableHead>
                <TableHead>Честный знак</TableHead>
                <TableHead>Состояние</TableHead>
                <TableHead className="w-32"><span className="sr-only">Действия</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspace.items.map((item) => {
                const failedDocument = item.documentStatus === "rejected"
                  || item.documentStatus === "requires_manual_review";
                const canPrepare = item.destination !== "unknown"
                  && ["direction_confirmed", "awaiting_withdrawal"].includes(item.processStatus)
                  && !item.documentId;
                const canOperate = Boolean(item.assignmentId)
                  && !["completed", "cancelled"].includes(item.processStatus);
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-medium">{item.sourceReturnId}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">
                        {item.postingNumber}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {returnKindLabel(item.returnKind)} · {item.sourceStatus}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{item.offerId ?? "Артикул не определён"}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.codeFingerprint ? `КМ ${item.codeFingerprint}` : "КМ не сопоставлен"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={item.destination === "unknown" ? "secondary" : "outline"}>
                        {returnDestinationLabel(item.destination)}
                      </Badge>
                      {item.paid !== null && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {item.paid ? "Оплачен" : "Не оплачен"}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{item.crptState ? crptCodeStateLabel(item.crptState) : "Не определён"}</div>
                      {item.documentStatus && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          LP_RETURN: {crptDocumentStatusLabel(item.documentStatus)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={item.processStatus} />
                      {item.manualReviewReason && (
                        <div className="mt-1 max-w-[320px] text-xs text-destructive">
                          {item.manualReviewReason}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatDate(item.updatedAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {canOperate && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title={returnActionTitle(item)}
                            disabled={Boolean(actionId?.includes(item.id))}
                            onClick={() => onOpen(item)}
                          >
                            <Pencil />
                          </Button>
                        )}
                        {canPrepare && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Подготовить LP_RETURN"
                            disabled={!workspace.runtime.enabled
                              || actionId === `return:prepare:${item.id}`}
                            onClick={() => onPrepare(item)}
                          >
                            <Send className={actionId === `return:prepare:${item.id}`
                              ? "animate-pulse" : ""} />
                          </Button>
                        )}
                        {failedDocument && item.destination !== "unknown" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Создать исправленную ревизию LP_RETURN"
                            disabled={!workspace.runtime.enabled
                              || actionId === `return:retry:${item.id}`}
                            onClick={() => onRetry(item)}
                          >
                            <RotateCcw className={actionId === `return:retry:${item.id}`
                              ? "animate-spin" : ""} />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TablePanel>
      )}
    </div>
  );
}

function ReturnActionDialog({
  item,
  warehouses,
  open,
  onOpenChange,
  loading,
  onSubmit,
}: {
  item: MarkingReturnCase | null;
  warehouses: Array<{ id: string; name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  onSubmit: (
    operation: "confirm_direction" | "receive_seller" | "confirm_fbo",
    values: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [destination, setDestination] = useState("to_seller");
  const [paid, setPaid] = useState(false);
  const [condition, setCondition] = useState("intact");
  const [warehouseId, setWarehouseId] = useState("");
  const [fboReference, setFboReference] = useState("");
  const [edoReference, setEdoReference] = useState("");
  const [editDirection, setEditDirection] = useState(false);
  useEffect(() => {
    if (!item || !open) return;
    setDestination(item.destination === "to_ozon_fbo" ? "to_ozon_fbo" : "to_seller");
    setPaid(item.paid ?? false);
    setCondition("intact");
    setWarehouseId(warehouses[0]?.id ?? "");
    setFboReference(item.fboIntakeReference ?? "");
    setEdoReference(item.edoDocumentReference ?? "");
    setEditDirection(false);
  }, [item, open, warehouses]);
  if (!item) return null;
  const nextAction = item.processStatus === "awaiting_physical_receipt"
    ? "receive"
    : item.processStatus === "awaiting_fbo_evidence"
      ? "fbo"
      : "direction";
  const mode = editDirection ? "direction" : nextAction;
  const paidLocked = ["payload_built", "signed", "submitting", "processing", "accepted"]
    .includes(item.documentStatus ?? "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "receive") {
      await onSubmit("receive_seller", { condition, warehouseId });
    } else if (mode === "fbo") {
      await onSubmit("confirm_fbo", {
        fboIntakeReference: fboReference,
        edoDocumentReference: edoReference,
      });
    } else {
      await onSubmit("confirm_direction", { destination, paid });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{returnDialogTitle(mode)}</DialogTitle>
            <DialogDescription>
              Возврат {item.sourceReturnId} · заказ {item.postingNumber}
            </DialogDescription>
          </DialogHeader>
          {mode === "direction" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="return-destination">Куда направлен товар</Label>
                <Select value={destination} onValueChange={setDestination}>
                  <SelectTrigger id="return-destination"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="to_seller">Возвращается GetoMerch</SelectItem>
                    <SelectItem value="to_ozon_fbo">Остаётся у Ozon для FBO</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={paid} disabled={paidLocked}
                  onCheckedChange={(value) => setPaid(value === true)} />
                Заказ был оплачен
              </label>
            </>
          )}
          {mode === "receive" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="return-condition">Состояние товара и этикетки</Label>
                <Select value={condition} onValueChange={setCondition}>
                  <SelectTrigger id="return-condition"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="intact">Товар и КМ исправны</SelectItem>
                    <SelectItem value="relabel_same_code">Новая этикетка того же КМ</SelectItem>
                    <SelectItem value="remark_required">Нужна перемаркировка</SelectItem>
                    <SelectItem value="destroy_pending">Нужна утилизация</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="return-warehouse">Склад приёмки</Label>
                <Select value={warehouseId} onValueChange={setWarehouseId}>
                  <SelectTrigger id="return-warehouse"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {warehouses.map((warehouse) => (
                      <SelectItem key={warehouse.id} value={warehouse.id}>
                        {warehouse.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {mode === "fbo" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="return-fbo-reference">Приёмка / поставка FBO</Label>
                <Input id="return-fbo-reference" value={fboReference}
                  onChange={(event) => setFboReference(event.target.value)} maxLength={300} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="return-edo-reference">ЭДО: передача агенту 00005</Label>
                <Input id="return-edo-reference" value={edoReference}
                  onChange={(event) => setEdoReference(event.target.value)} maxLength={300} />
              </div>
            </>
          )}
          {nextAction !== "direction" && !editDirection && (
            <Button type="button" variant="outline" onClick={() => setEditDirection(true)}>
              <CornerDownLeft />
              Изменить направление
            </Button>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={loading
              || (mode === "receive" && !warehouseId)
              || (mode === "fbo" && (!fboReference.trim() || !edoReference.trim()))}>
              {loading && <RefreshCw className="animate-spin" />}
              Подтвердить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function returnOperationSuccess(operation: string) {
  return ({
    confirm_direction: "Направление возврата подтверждено",
    prepare: "LP_RETURN поставлен в очередь",
    retry: "Исправленная ревизия LP_RETURN поставлена в очередь",
    receive_seller: "Физическая приёмка возврата зафиксирована",
    confirm_fbo: "Передача единицы на FBO подтверждена",
  } as Record<string, string>)[operation] ?? "Возврат обновлён";
}

function returnKindLabel(value: string) {
  return ({
    cancel_before_handover: "Отмена до передачи",
    return_to_seller: "Возврат продавцу",
    not_picked_up_to_seller: "Невыкуп",
    to_ozon_fbo: "FBS → FBO",
    fbo_return_to_seller: "Возврат FBO продавцу",
    unknown: "Требует классификации",
  } as Record<string, string>)[value] ?? value;
}

function returnDestinationLabel(value: string) {
  const labels: Record<string, string> = {
    unknown: "Не подтверждено",
    to_seller: "GetoMerch",
    to_ozon_fbo: "Ozon FBO",
    lost_destroyed: "Утрата / утилизация",
  };
  return labels[value] ?? value;
}

function returnActionTitle(item: MarkingReturnCase) {
  if (item.processStatus === "awaiting_physical_receipt") return "Принять возврат";
  if (item.processStatus === "awaiting_fbo_evidence") return "Подтвердить передачу FBO";
  return item.destination === "unknown" ? "Подтвердить направление" : "Изменить направление";
}

function returnDialogTitle(mode: "direction" | "receive" | "fbo") {
  return mode === "receive" ? "Приёмка возврата"
    : mode === "fbo" ? "Передача на FBO"
      : "Направление возврата";
}

function CrptReadPanel({
  workspace,
  loading,
  actionId,
  documentId,
  setDocumentId,
  onRefreshAuth,
  onCheckDocument,
  onRetryIntroduction,
  onRetryCirculation,
  onRetryWithdrawal,
  onReconcileIntroduction,
}: {
  workspace: MarkingCrptWorkspace;
  loading: boolean;
  actionId: string | null;
  documentId: string;
  setDocumentId: (value: string) => void;
  onRefreshAuth: () => void;
  onCheckDocument: () => void;
  onRetryIntroduction: (assignmentId: string) => void;
  onRetryCirculation: (documentId: string) => void;
  onRetryWithdrawal: (handoverId: string) => void;
  onReconcileIntroduction: (documentId: string, externalDocumentId: string) => void;
}) {
  const documentValid = /^[A-Za-z0-9._:-]{1,200}$/.test(documentId.trim());
  const agent = workspace.signingAgents[0] ?? null;
  const agentOnline = Boolean(agent && agent.state !== "offline");
  const remoteSignerReady = workspace.runtime.signerTransport !== "remote"
    || agent?.state === "ready";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant={workspace.runtime.readEnabled ? "default" : "secondary"}>
            Чтение {workspace.runtime.readEnabled ? "включено" : "выключено"}
          </Badge>
          <Badge variant="outline">
            {workspace.runtime.contour === "production" ? "Production" : "Тестовый контур"}
          </Badge>
          <Badge variant={workspace.runtime.signerEnabled ? "outline" : "destructive"}>
            Signer {workspace.runtime.signerTransport === "remote" ? "Mac" : "локальный"}
          </Badge>
          <Badge variant={workspace.runtime.writeEnabled ? "destructive" : "secondary"}>
            Запись {workspace.runtime.writeEnabled ? "включена" : "выключена"}
          </Badge>
          <Badge variant={workspace.runtime.introductionEnabled ? "default" : "secondary"}>
            Ввод в оборот {workspace.runtime.introductionEnabled ? "включён" : "выключен"}
          </Badge>
          <Badge variant={workspace.runtime.withdrawalEnabled ? "default" : "secondary"}>
            Вывод {workspace.runtime.withdrawalEnabled ? "включён" : "выключен"}
          </Badge>
          <Badge variant={workspace.runtime.returnsEnabled ? "default" : "secondary"}>
            Возвраты {workspace.runtime.returnsEnabled ? "включены" : "выключены"}
          </Badge>
        </div>
        <Button
          variant="outline"
          disabled={
            !workspace.runtime.readEnabled
            || !remoteSignerReady
            || actionId === "crpt:refresh_auth:auth"
          }
          onClick={onRefreshAuth}
        >
          <ShieldCheck />
          Проверить авторизацию
        </Button>
      </div>

      {workspace.runtime.signerTransport === "remote" && !remoteSignerReady && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{remoteSignerMessage(agent)}</span>
        </div>
      )}

      <div className="grid border-y sm:grid-cols-2 xl:grid-cols-6">
        <SignerStatusItem
          icon={Laptop}
          label="Mac-агент"
          value={agent ? statusLabel(agent.state) : "Не подключён"}
          detail={agent ? `Связь: ${formatDate(agent.lastSeenAt)}` : "Нет телеметрии"}
          healthy={agent?.state === "ready"}
        />
        <SignerStatusItem
          icon={Usb}
          label="Рутокен"
          value={!agentOnline ? "Нет связи" : agent?.readerDetected ? "Найден" : "Не найден"}
          detail={agent?.displayName ?? "Mac не подключён"}
          healthy={agentOnline && agent?.readerDetected === true}
        />
        <SignerStatusItem
          icon={KeyRound}
          label="Signer / PIN"
          value={signerStateLabel(agent)}
          detail={!agentOnline
            ? "Mac-агент не отвечает"
            : agent?.signerReachable ? `Сессия: ${pinStateLabel(agent.pinState)}` : "Сокет недоступен"}
          healthy={agentOnline && agent?.signerReachable === true
            && agent.pinState !== "required"
            && agent.pinState !== "blocked"}
        />
        <SignerStatusItem
          icon={BadgeCheck}
          label="Сертификат"
          value={certificateExpiryLabel(agent?.certificateValidTo ?? null)}
          detail={shortThumbprint(agent?.certificateThumbprint ?? null)}
          healthy={isFuture(agent?.certificateValidTo ?? null)}
        />
        <SignerStatusItem
          icon={ShieldCheck}
          label="Последняя авторизация"
          value={authorizationStatusLabel(workspace.authorization.status)}
          detail={workspace.authorization.tokenExpiresAt
            ? `До ${formatDate(workspace.authorization.tokenExpiresAt)}`
            : workspace.authorization.updatedAt
              ? formatDate(workspace.authorization.updatedAt)
              : "Не выполнялась"}
          healthy={workspace.authorization.status === "active"}
        />
        <SignerStatusItem
          icon={History}
          label="Очередь подписей"
          value={`${workspace.signatureSummary.pending + workspace.signatureSummary.leased} в работе`}
          detail={`${workspace.signatureSummary.signed24h} готово · ${workspace.signatureSummary.failed24h} ошибок`}
          healthy={workspace.signatureSummary.failed24h === 0}
        />
      </div>

      {agent?.errorMessage && (
        <div className="border-b px-3 pb-3 text-sm text-destructive">
          {agent.errorMessage}
        </div>
      )}

      <div className="space-y-2 pt-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Send className="h-4 w-4" />
          Документы ГИС МТ
        </div>
        {loading && workspace.documents.length === 0 ? (
          <LoadingPanel />
        ) : workspace.documents.length === 0 ? (
          <div className="border-y px-3 py-5 text-sm text-muted-foreground">
            Документы появятся после нанесения КМ или фактической FBS-передачи.
          </div>
        ) : (
          <TablePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Заказ / товар</TableHead>
                  <TableHead>Документ</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Обновлён</TableHead>
                  <TableHead className="w-12"><span className="sr-only">Действия</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspace.documents.map((item) => {
                  const code = item.codes[0];
                  const failedRevision = item.status === "rejected"
                    || (item.status === "requires_manual_review"
                      && item.errorCode !== "crpt_submit_outcome_unknown");
                  const retryable = item.documentType === "introduction" && failedRevision;
                  const withdrawalRetryable = item.documentType === "withdrawal_remote_sale"
                    && failedRevision && Boolean(item.handoverId);
                  const circulationRetryable = item.documentType === "introduction"
                    && item.status === "accepted"
                    && item.circulationState === "requires_manual_review";
                  const withdrawalOverdue = item.documentType === "withdrawal_remote_sale"
                    && item.withdrawalState !== "confirmed"
                    && item.withdrawalDeadlineAt !== null
                    && new Date(item.withdrawalDeadlineAt).getTime() < Date.now();
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{code?.postingNumber ?? "Без заказа"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {code?.offerId ?? "Без артикула"} · {code?.gtin ?? "GTIN не указан"}
                        </div>
                        {code?.fingerprint && (
                          <div className="mt-1 font-mono text-xs">КМ {code.fingerprint}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div>
                          {item.documentType === "withdrawal_remote_sale"
                            ? "Дистанционный вывод"
                            : item.documentType === "return_to_circulation"
                              ? "Возврат в оборот"
                              : "Ввод в оборот"} · ревизия {item.revision}
                        </div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">
                          {item.externalDocumentId ?? item.id.slice(0, 8)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.status === "accepted" ? "default"
                          : retryable ? "destructive" : "secondary"}>
                          {crptDocumentStatusLabel(item.status)}
                        </Badge>
                        {item.status === "accepted" && item.documentType === "introduction" && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            КМ: {crptCirculationStatusLabel(item.circulationState!)}
                          </div>
                        )}
                        {item.documentType === "withdrawal_remote_sale" && (
                          <div className={`mt-1 text-xs ${withdrawalOverdue
                            ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                            Вывод: {crptWithdrawalStatusLabel(item.withdrawalState)}
                            {item.withdrawalDeadlineAt
                              ? ` · срок ${formatDate(item.withdrawalDeadlineAt)}`
                              : ""}
                            {withdrawalOverdue ? " · срок истёк" : ""}
                          </div>
                        )}
                        {item.documentType === "return_to_circulation" && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            Возврат: {crptReturnStatusLabel(item.returnState)}
                          </div>
                        )}
                        {item.errorMessage && (
                          <div className="mt-1 max-w-[320px] text-xs text-destructive">
                            {item.errorMessage}
                          </div>
                        )}
                        {item.circulationErrorMessage && (
                          <div className="mt-1 max-w-[320px] text-xs text-destructive">
                            {item.circulationErrorMessage}
                          </div>
                        )}
                        {item.withdrawalErrorMessage && (
                          <div className="mt-1 max-w-[320px] text-xs text-destructive">
                            {item.withdrawalErrorMessage}
                          </div>
                        )}
                        {item.returnErrorMessage && (
                          <div className="mt-1 max-w-[320px] text-xs text-destructive">
                            {item.returnErrorMessage}
                          </div>
                        )}
                        {item.errorCode === "crpt_submit_outcome_unknown" && (
                          <div className="mt-1 max-w-[320px] text-xs text-muted-foreground">
                            Введите найденный ID документа ниже и запустите сверку.
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {formatDate(item.updatedAt)}
                      </TableCell>
                      <TableCell>
                        {item.errorCode === "crpt_submit_outcome_unknown" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Сверить с документом из личного кабинета"
                            disabled={!workspace.runtime.readEnabled || !remoteSignerReady
                              || !documentValid
                              || actionId === `crpt:reconcile_introduction:${item.id}`}
                            onClick={() => onReconcileIntroduction(item.id, documentId.trim())}
                          >
                            <Search className={
                              actionId === `crpt:reconcile_introduction:${item.id}`
                                ? "animate-pulse"
                                : ""
                            } />
                          </Button>
                        )}
                        {retryable && code && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Создать исправленную ревизию"
                            disabled={!workspace.runtime.introductionEnabled
                              || actionId === `crpt:retry_introduction:${code.assignmentId}`}
                            onClick={() => onRetryIntroduction(code.assignmentId)}
                          >
                            <RotateCcw className={actionId === `crpt:retry_introduction:${code.assignmentId}`
                              ? "animate-spin" : ""} />
                          </Button>
                        )}
                        {circulationRetryable && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Повторно проверить статус КМ"
                            disabled={!workspace.runtime.readEnabled || !remoteSignerReady
                              || actionId === `crpt:retry_circulation:${item.id}`}
                            onClick={() => onRetryCirculation(item.id)}
                          >
                            <RefreshCw className={actionId === `crpt:retry_circulation:${item.id}`
                              ? "animate-spin" : ""} />
                          </Button>
                        )}
                        {withdrawalRetryable && item.handoverId && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Создать исправленную ревизию вывода"
                            disabled={!workspace.runtime.withdrawalEnabled
                              || actionId === `crpt:retry_withdrawal:${item.handoverId}`}
                            onClick={() => onRetryWithdrawal(item.handoverId!)}
                          >
                            <RotateCcw className={actionId === `crpt:retry_withdrawal:${item.handoverId}`
                              ? "animate-spin" : ""} />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TablePanel>
        )}
      </div>

      <div className="flex max-w-2xl items-end gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor="crpt-document-id">ID документа ГИС МТ</Label>
          <Input
            id="crpt-document-id"
            value={documentId}
            onChange={(event) => setDocumentId(event.target.value)}
            maxLength={200}
          />
        </div>
        <Button
          variant="outline"
          disabled={
            !workspace.runtime.readEnabled
            || !remoteSignerReady
            || !documentValid
            || actionId === `crpt:check_document:${documentId.trim()}`
          }
          onClick={onCheckDocument}
        >
          <Search />
          Проверить
        </Button>
      </div>

      {loading && workspace.queries.length === 0 ? (
        <LoadingPanel />
      ) : workspace.queries.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={ShieldCheck}
              title="Проверок ГИС МТ пока нет"
              description="Проверки КМ запускаются из вкладки «Пул КМ», документов — здесь."
            />
          </CardContent>
        </Card>
      ) : (
        <TablePanel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Объект</TableHead>
                <TableHead>Статус запроса</TableHead>
                <TableHead>Статус ГИС МТ</TableHead>
                <TableHead>Сверка</TableHead>
                <TableHead>Попытки</TableHead>
                <TableHead>Проверено</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspace.queries.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="font-medium">
                      {item.queryType === "code_status" ? "Код маркировки" : "Документ"}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                      {item.fingerprint ?? item.externalDocumentId}
                    </div>
                    {item.gtin && <div className="mt-1 font-mono text-xs">{item.gtin}</div>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={item.status} />
                    {item.errorMessage && (
                      <div className="mt-1 max-w-[300px] text-xs text-destructive">
                        {item.errorMessage}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {item.normalizedStatus
                      ? <StatusBadge status={item.normalizedStatus} />
                      : <span className="text-sm text-muted-foreground">—</span>}
                    {item.rawStatus && item.rawStatus !== item.normalizedStatus && (
                      <div className="mt-1 max-w-[240px] truncate text-xs text-muted-foreground">
                        {item.rawStatus}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.queryType === "code_status" ? (
                      item.ownerMatches === false || item.gtinMatches === false
                        ? <span className="text-destructive">Есть расхождение</span>
                        : item.gtinMatches === true
                          ? <span>GTIN совпал</span>
                          : <span className="text-muted-foreground">Не проверено</span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>{item.attemptCount}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {item.checkedAt ? formatDate(item.checkedAt) : formatDate(item.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      )}

      {workspace.signatureRequests.length > 0 && (
        <div className="space-y-2 pt-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4" />
            История подписей
          </div>
          <TablePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Запрос</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Агент</TableHead>
                  <TableHead>Попытки</TableHead>
                  <TableHead>Создан</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspace.signatureRequests.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-mono text-xs">{item.id.slice(0, 8)}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">
                        SHA-256 {item.payloadSha256.slice(0, 12)}…
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={item.status} />
                      {item.errorMessage && (
                        <div className="mt-1 max-w-[280px] text-xs text-destructive">
                          {item.errorMessage}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{item.leaseAgentId ?? "—"}</TableCell>
                    <TableCell>{item.attemptCount}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {formatDate(item.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TablePanel>
        </div>
      )}
    </div>
  );
}

function SignerStatusItem({
  icon: Icon,
  label,
  value,
  detail,
  healthy,
}: {
  icon: typeof Laptop;
  label: string;
  value: string;
  detail: string;
  healthy: boolean;
}) {
  return (
    <div className="min-w-0 border-b px-3 py-3 sm:border-r xl:border-b-0 last:border-r-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-4 w-4 shrink-0" />
        <span>{label}</span>
      </div>
      <div className={healthy ? "mt-2 truncate text-sm font-semibold" : "mt-2 truncate text-sm font-semibold text-destructive"}>
        {value}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground" title={detail}>{detail}</div>
    </div>
  );
}

function remoteSignerMessage(agent: MarkingCrptWorkspace["signingAgents"][number] | null) {
  if (!agent || agent.state === "offline") return "Mac-агент не подключён. Запустите signer и агент на Mac с установленным Рутокеном.";
  if (agent.errorCode === "provider_license_expired") return "Срок лицензии CryptoPro CSP истёк. Активируйте действующую лицензию на Mac и повторите проверку авторизации.";
  if (!agent.readerDetected) return "Mac-агент работает, но Рутокен не найден.";
  if (!agent.signerReachable) return "Рутокен найден, но локальный signer на Mac недоступен.";
  if (agent.pinState === "required") return "PIN отклонён или сессия заблокирована. Перезапустите signer на Mac и введите PIN заново.";
  if (agent.pinState === "blocked") return "PIN Рутокена заблокирован. Подписание остановлено.";
  return "Mac-агент временно не готов к подписанию.";
}

function signerStateLabel(agent: MarkingCrptWorkspace["signingAgents"][number] | null) {
  if (!agent || agent.state === "offline") return "Не в сети";
  if (agent.errorCode === "provider_license_expired") return "Нет лицензии CSP";
  if (!agent?.signerReachable) return "Недоступен";
  if (agent.pinState === "required") return "Нужен PIN";
  if (agent.pinState === "blocked") return "PIN заблокирован";
  return "Готов";
}

function pinStateLabel(state: MarkingCrptWorkspace["signingAgents"][number]["pinState"]) {
  return ({ unknown: "не разблокирована", ready: "разблокирована", required: "нужен перезапуск", blocked: "PIN заблокирован" })[state];
}

function certificateExpiryLabel(value: string | null) {
  if (!value) return "Не определён";
  const days = Math.ceil((Date.parse(value) - Date.now()) / 86_400_000);
  if (days < 0) return "Истёк";
  return `${days} дн. до окончания`;
}

function shortThumbprint(value: string | null) {
  return value ? `${value.slice(0, 8)}…${value.slice(-8)}` : "Нет данных";
}

function isFuture(value: string | null) {
  return Boolean(value && Date.parse(value) > Date.now());
}

function authorizationStatusLabel(status: MarkingCrptWorkspace["authorization"]["status"]) {
  return ({
    not_started: "Не проверялась",
    queued: "В очереди",
    running: "Выполняется",
    active: "Успешна",
    expired: "Истекла",
    failed: "Ошибка",
    cancelled: "Отменена",
  })[status];
}

function ProcessTable({
  state,
  setState,
}: {
  state: PageState<MarkingProcessListItem>;
  setState: React.Dispatch<React.SetStateAction<PageState<MarkingProcessListItem>>>;
}) {
  if (state.loading && state.items.length === 0) return <LoadingPanel />;
  if (state.items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={Activity}
            title="Активных процессов нет"
            description="Очередь появится после включения маркировки для проверенных товаров."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel
      footer={(
        <LoadMore
          state={state}
          setState={setState}
          path="/api/admin/marking/processes"
        />
      )}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Процесс</TableHead>
            <TableHead>Заказ / товар</TableHead>
            <TableHead>Шаг</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead>Обновлен</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="font-medium">{item.processType}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {item.id.slice(0, 8)}
                </div>
              </TableCell>
              <TableCell>
                <div>{item.postingNumber ?? item.sourceKey}</div>
                <div className="text-xs text-muted-foreground">
                  {item.offerId ?? item.source}
                </div>
              </TableCell>
              <TableCell>
                <div>{item.currentStep}</div>
                {item.nextAction && (
                  <div className="text-xs text-muted-foreground">{item.nextAction}</div>
                )}
              </TableCell>
              <TableCell><StatusBadge status={item.status} /></TableCell>
              <TableCell className="whitespace-nowrap text-sm">
                {formatDate(item.updatedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function EventTable({
  state,
  setState,
}: {
  state: PageState<MarkingEventListItem>;
  setState: React.Dispatch<React.SetStateAction<PageState<MarkingEventListItem>>>;
}) {
  if (state.loading && state.items.length === 0) return <LoadingPanel />;
  if (state.items.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={History}
            title="История пока пуста"
            description="Здесь появятся изменения профилей и процессов."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <TablePanel
      footer={(
        <LoadMore state={state} setState={setState} path="/api/admin/marking/events" />
      )}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Время</TableHead>
            <TableHead>Событие</TableHead>
            <TableHead>Объект</TableHead>
            <TableHead>Источник</TableHead>
            <TableHead>Исполнитель</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="whitespace-nowrap">{formatDate(item.occurredAt)}</TableCell>
              <TableCell className="font-medium">{eventLabel(item.eventType)}</TableCell>
              <TableCell className="font-mono text-xs">
                {item.processId
                  ? `process ${item.processId.slice(0, 8)}`
                  : item.productProfileId
                    ? `profile ${item.productProfileId.slice(0, 8)}`
                    : item.markingCodeId
                      ? `code ${item.markingCodeId.slice(0, 8)}`
                      : "—"}
              </TableCell>
              <TableCell>{item.source}</TableCell>
              <TableCell>{item.actorId ?? actorLabel(item.actorType)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePanel>
  );
}

function ProfileDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: MarkingReadinessItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [requirement, setRequirement] = useState("unknown");
  const [source, setSource] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [productionMode, setProductionMode] = useState("own_production");
  const [fulfillmentMode, setFulfillmentMode] = useState("jit_after_order");
  const [channel, setChannel] = useState("ozon_fbs");
  const [offerId, setOfferId] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !item) return;
    setRequirement(item.markingRequirement);
    setSource(item.markingRequirementSource ?? "");
    setObservedAt(toLocalDateTime(item.markingRequirementObservedAt));
    setProductionMode(item.productionMode ?? "own_production");
    setFulfillmentMode(item.fulfillmentMarkingMode ?? "jit_after_order");
    setChannel(item.channel ?? "ozon_fbs");
    setOfferId(item.offerId ?? item.sku ?? "");
    setPauseReason("");
  }, [item, open]);

  async function saveProfile() {
    if (!item) return;
    setSaving(true);
    try {
      await postMutation("/api/admin/marking/profiles", {
        productId: item.productId,
        expectedRevision: item.revision,
        markingRequirement: requirement,
        requirementSource: requirement === "unknown" ? null : source,
        requirementObservedAt: requirement === "unknown"
          ? null
          : fromLocalDateTime(observedAt),
        productionMode,
        fulfillmentMode,
        channel,
        offerId: offerId || null,
        externalProductId: item.externalProductId,
        externalSku: item.ozonSku,
        sourceSnapshot: {
          source: source || "manual_admin",
          offerId: offerId || null,
          requirement,
          observedAt: observedAt || null,
        },
      });
      toast.success("Профиль сохранён");
      await onSaved();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось сохранить профиль"));
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(status: "enabled" | "paused") {
    if (!item?.profileId || item.revision == null) return;
    setSaving(true);
    try {
      await postMutation(
        `/api/admin/marking/profiles/${item.profileId}/operational-status`,
        {
          expectedRevision: item.revision,
          operationalStatus: status,
          reason: status === "paused" ? pauseReason : null,
        },
      );
      toast.success(status === "enabled" ? "Профиль включён" : "Профиль приостановлен");
      await onSaved();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось изменить статус"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Профиль маркировки</DialogTitle>
          <DialogDescription>
            {item?.sku ?? "Товар без SKU"}. Изменение не подтверждает GTIN и не
            запускает внешние операции.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Требование маркировки">
            <Select value={requirement} onValueChange={setRequirement}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown">Не подтверждено</SelectItem>
                <SelectItem value="required">Требуется</SelectItem>
                <SelectItem value="not_required">Не требуется</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Канал">
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ozon_fbs">Ozon FBS</SelectItem>
                <SelectItem value="komui">KOMUI</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Источник требования">
            <Input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="Например, Ozon order snapshot"
              disabled={requirement === "unknown"}
            />
          </Field>
          <Field label="Проверено на дату">
            <Input
              type="datetime-local"
              value={observedAt}
              onChange={(event) => setObservedAt(event.target.value)}
              disabled={requirement === "unknown"}
            />
          </Field>
          <Field label="Модель производства">
            <Select value={productionMode} onValueChange={(value) => {
              setProductionMode(value);
              if (value === "pre_marked_minor_customization") {
                setFulfillmentMode("pre_marked_minor_customization");
              } else if (fulfillmentMode === "pre_marked_minor_customization") {
                setFulfillmentMode("jit_after_order");
              }
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="own_production">Собственное производство</SelectItem>
                <SelectItem value="pre_marked_minor_customization">
                  Незначительная доработка
                </SelectItem>
                <SelectItem value="remarking_after_customization">
                  Перемаркировка
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Момент маркировки">
            <Select value={fulfillmentMode} onValueChange={setFulfillmentMode}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="jit_after_order">После заказа</SelectItem>
                <SelectItem value="prebuilt_stock">Готовый запас</SelectItem>
                <SelectItem value="pre_marked_minor_customization">
                  Маркированная заготовка
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Offer ID">
            <Input value={offerId} onChange={(event) => setOfferId(event.target.value)} />
          </Field>
          {item?.operationalStatus === "enabled" && (
            <Field label="Причина приостановки">
              <Input
                value={pauseReason}
                onChange={(event) => setPauseReason(event.target.value)}
                placeholder="Обязательное поле"
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          {item?.profileId && item.operationalStatus === "enabled" && (
            <Button
              variant="destructive"
              disabled={saving || !pauseReason.trim()}
              onClick={() => changeStatus("paused")}
            >
              Приостановить
            </Button>
          )}
          {item?.profileId
            && item.operationalStatus !== "enabled"
            && item.markingRequirement !== "unknown" && (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => changeStatus("enabled")}
              >
                Включить
              </Button>
            )}
          <Button disabled={saving} onClick={saveProfile}>
            {saving && <RefreshCw className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GtinDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: MarkingReadinessItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [gtin, setGtin] = useState("");
  const [productGroup, setProductGroup] = useState("clothes");
  const [tnved, setTnved] = useState("6109100000");
  const [catalogId, setCatalogId] = useState("");
  const [catalogStatus, setCatalogStatus] = useState("published");
  const [source, setSource] = useState("national_catalog_manual_verification");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !item) return;
    setGtin(item.gtin ?? "");
    setProductGroup(item.productGroup ?? "clothes");
    setCatalogId(item.nationalCatalogCardId ?? "");
    setCatalogStatus(item.nationalCatalogStatus ?? "published");
    setReference("");
  }, [item, open]);

  async function save() {
    if (!item?.profileId || item.revision == null) return;
    setSaving(true);
    const sourceSnapshot = {
      gtin,
      productGroup,
      tnved,
      nationalCatalogCardId: catalogId,
      nationalCatalogStatus: catalogStatus,
      color: item.color,
      sizeInt: item.size,
      source,
      externalReference: reference || null,
    };
    try {
      await postMutation(
        `/api/admin/marking/profiles/${item.profileId}/verify-gtin`,
        {
          expectedRevision: item.revision,
          gtin,
          productGroup,
          tnvedCode: tnved || null,
          nationalCatalogCardId: catalogId || null,
          nationalCatalogStatus: catalogStatus || null,
          declaredProductType: item.category,
          declaredFabric: item.fabric,
          declaredColor: item.color,
          declaredSizeInt: item.size,
          verificationSource: source,
          externalReference: reference || null,
          sourceSnapshot,
        },
      );
      toast.success("GTIN и связь с товаром подтверждены");
      await onSaved();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось подтвердить GTIN"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Подтверждение GTIN</DialogTitle>
          <DialogDescription>
            Значения сверяются вручную с опубликованной карточкой Национального каталога.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GTIN">
            <Input value={gtin} onChange={(event) => setGtin(event.target.value)} />
          </Field>
          <Field label="Товарная группа">
            <Input
              value={productGroup}
              onChange={(event) => setProductGroup(event.target.value)}
            />
          </Field>
          <Field label="ТН ВЭД">
            <Input value={tnved} onChange={(event) => setTnved(event.target.value)} />
          </Field>
          <Field label="ID карточки НК">
            <Input
              value={catalogId}
              onChange={(event) => setCatalogId(event.target.value)}
            />
          </Field>
          <Field label="Статус карточки НК">
            <Input
              value={catalogStatus}
              onChange={(event) => setCatalogStatus(event.target.value)}
            />
          </Field>
          <Field label="Источник проверки">
            <Input value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Ссылка или номер подтверждения">
              <Input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Без полного КМ и секретных данных"
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={saving || !gtin.trim() || !source.trim()} onClick={save}>
            {saving && <RefreshCw className="animate-spin" />}
            Подтвердить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConformityDocumentDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: MarkingReadinessItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [documentType, setDocumentType] = useState("CONFORMITY_DECLARATION");
  const [documentNumber, setDocumentNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [source, setSource] = useState("national_catalog_personal_account");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !item) return;
    setDocumentType(item.conformityDocumentType ?? "CONFORMITY_DECLARATION");
    setDocumentNumber(item.conformityDocumentNumber ?? "");
    setIssuedAt(item.conformityDocumentIssuedAt?.slice(0, 10) ?? "");
    setValidUntil(item.conformityDocumentValidUntil?.slice(0, 10) ?? "");
    setReference("");
  }, [item, open]);

  async function save() {
    if (!item?.profileId || item.revision == null) return;
    setSaving(true);
    try {
      await postMutation(
        `/api/admin/marking/profiles/${item.profileId}/conformity-document`,
        {
          expectedRevision: item.revision,
          documentType,
          documentNumber,
          issuedAt,
          validUntil: validUntil || null,
          verificationSource: source,
          externalReference: reference || null,
          sourceSnapshot: {
            profileId: item.profileId,
            gtin: item.gtin,
            documentType,
            documentNumber,
            issuedAt,
            validUntil: validUntil || null,
            verificationSource: source,
            externalReference: reference || null,
          },
        },
      );
      toast.success("Документ соответствия сохранён");
      await onSaved();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось сохранить документ соответствия"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Документ соответствия</DialogTitle>
          <DialogDescription>
            Реквизиты попадут в документ ввода GTIN {item?.gtin ?? ""} в оборот.
            Заказ, печать и нанесение КМ от этого поля не зависят.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Вид документа">
            <Select value={documentType} onValueChange={setDocumentType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CONFORMITY_DECLARATION">Декларация соответствия</SelectItem>
                <SelectItem value="CONFORMITY_CERTIFICATE">Сертификат соответствия</SelectItem>
                <SelectItem value="STATE_REGISTRATION_CERTIFICATE">
                  Свидетельство госрегистрации
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Номер документа">
            <Input
              value={documentNumber}
              onChange={(event) => setDocumentNumber(event.target.value)}
            />
          </Field>
          <Field label="Дата документа">
            <Input
              type="date"
              value={issuedAt}
              onChange={(event) => setIssuedAt(event.target.value)}
            />
          </Field>
          <Field label="Действует до">
            <Input
              type="date"
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </Field>
          <Field label="Источник данных">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="national_catalog_personal_account">
                  Национальный каталог
                </SelectItem>
                <SelectItem value="crpt_personal_account">Личный кабинет ГИС МТ</SelectItem>
                <SelectItem value="owner_document">Документ владельца</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Ссылка или номер источника">
            <Input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button
            disabled={saving || !documentNumber.trim() || !issuedAt || !source.trim()}
            onClick={save}
          >
            {saving && <RefreshCw className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EvidenceDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: MarkingReadinessItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [type, setType] = useState("shared_trade_item_mapping");
  const [source, setSource] = useState("manual_admin_verification");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!item?.profileId || item.revision == null) return;
    setSaving(true);
    const snapshot = {
      profileId: item.profileId,
      productId: item.productId,
      gtin: item.gtin,
      evidenceType: type,
      source,
      reference: reference || null,
    };
    try {
      await postMutation(
        `/api/admin/marking/profiles/${item.profileId}/evidence`,
        {
          expectedRevision: item.revision,
          evidenceType: type,
          source,
          externalReference: reference || null,
          scope: { productId: item.productId, gtin: item.gtin },
          details: { note: "Verified in admin product readiness" },
          verificationStatus: "verified",
          sourceSnapshot: snapshot,
        },
      );
      toast.success("Подтверждение добавлено");
      await onSaved();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось добавить подтверждение"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Подтверждение связи</DialogTitle>
          <DialogDescription>
            Добавляется безопасный hash и ссылка. Полный КМ здесь не хранится.
          </DialogDescription>
        </DialogHeader>
        <Field label="Тип">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="shared_trade_item_mapping">
                Общий GTIN для нескольких карточек
              </SelectItem>
              <SelectItem value="product_profile_mapping">
                Связь товара и GTIN
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Источник">
          <Input value={source} onChange={(event) => setSource(event.target.value)} />
        </Field>
        <Field label="Ссылка или номер">
          <Input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button disabled={saving || !source.trim()} onClick={save}>
            {saving && <RefreshCw className="animate-spin" />}
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackfillDialog({
  open,
  onOpenChange,
  detail,
  setDetail,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: MarkingProfileBackfillDetail | null;
  setDetail: React.Dispatch<React.SetStateAction<MarkingProfileBackfillDetail | null>>;
  onApplied: () => Promise<void>;
}) {
  const [channel, setChannel] = useState("ozon_fbs");
  const [loading, setLoading] = useState(false);

  async function preview() {
    setLoading(true);
    try {
      const result = await postMutation<{ runId: string }>(
        "/api/admin/marking/profile-backfills/preview",
        { channel },
      );
      const next = await fetchData<MarkingProfileBackfillDetail>(
        `/api/admin/marking/profile-backfills/${result.runId}`,
      );
      setDetail(next);
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось сформировать preview"));
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!detail || detail.run.status !== "preview") return;
    setLoading(true);
    try {
      await postMutation(
        `/api/admin/marking/profile-backfills/${detail.run.id}/apply`,
        {},
      );
      const next = await fetchData<MarkingProfileBackfillDetail>(
        `/api/admin/marking/profile-backfills/${detail.run.id}`,
      );
      setDetail(next);
      toast.success("Черновики профилей созданы");
      await onApplied();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось применить preview"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Backfill профилей товаров</DialogTitle>
          <DialogDescription>
            Создаются только неактивные черновики по точным идентификаторам.
            GTIN не подтверждается и профили не включаются автоматически.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-end gap-2">
          <div className="w-48">
            <Field label="Канал">
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ozon_fbs">Ozon FBS</SelectItem>
                  <SelectItem value="komui">KOMUI</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Button variant="outline" disabled={loading} onClick={preview}>
            {loading ? <RefreshCw className="animate-spin" /> : <Database />}
            Сформировать preview
          </Button>
        </div>
        {detail && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="secondary">Всего: {detail.run.summary.total}</Badge>
              <Badge variant="secondary">
                Черновики: {detail.run.summary.createDraft ?? detail.run.summary.applied ?? 0}
              </Badge>
              <Badge variant="secondary">
                Пропустить: {detail.run.summary.skip ?? detail.run.summary.skipped ?? 0}
              </Badge>
              <Badge variant={Number(detail.run.summary.conflict ?? 0) > 0
                ? "destructive"
                : "secondary"}
              >
                Конфликты: {detail.run.summary.conflict ?? detail.run.summary.conflicts ?? 0}
              </Badge>
              <StatusBadge status={detail.run.status} />
            </div>
            <div className="max-h-[360px] overflow-auto border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Действие</TableHead>
                    <TableHead>Диагностика</TableHead>
                    <TableHead>Apply</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-xs">
                        {item.sku ?? "Без SKU"}
                      </TableCell>
                      <TableCell>{backfillActionLabel(item.action)}</TableCell>
                      <TableCell className="text-xs">
                        {[...item.errors, ...item.warnings]
                          .map(backfillDiagnosticLabel)
                          .join(", ") || "—"}
                      </TableCell>
                      <TableCell><StatusBadge status={item.applyStatus} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        <DialogFooter>
          <Button
            disabled={loading || !detail || detail.run.status !== "preview"}
            onClick={apply}
          >
            Применить этот preview
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CodeImportDialog({
  open,
  onOpenChange,
  detail,
  setDetail,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: MarkingCodeImportDetail | null;
  setDetail: React.Dispatch<React.SetStateAction<MarkingCodeImportDetail | null>>;
  onApplied: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [gtin, setGtin] = useState("");
  const [acquisitionMode, setAcquisitionMode] = useState("own_suz_emission");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || detail) return;
    setFile(null);
    setGtin("");
    setAcquisitionMode("own_suz_emission");
  }, [detail, open]);

  async function preview() {
    if (!file || !/^\d{14}$/.test(gtin)) return;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/marking/imports/preview", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Idempotency-Key": crypto.randomUUID(),
          "X-Request-ID": crypto.randomUUID(),
          "X-Marking-Expected-Gtin": gtin,
          "X-Marking-Filename": encodeURIComponent(file.name),
          "X-Marking-Acquisition-Mode": acquisitionMode,
        },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? `Ошибка preview (${response.status})`);
      }
      const next = await fetchData<MarkingCodeImportDetail>(
        `/api/admin/marking/imports/${payload.data.batchId}`,
      );
      setDetail(next);
      toast.success("Preview импорта сформирован");
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось обработать файл"));
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!detail || detail.batch.status !== "preview") return;
    setLoading(true);
    try {
      await postMutation(`/api/admin/marking/imports/${detail.batch.id}/apply`, {});
      const next = await fetchData<MarkingCodeImportDetail>(
        `/api/admin/marking/imports/${detail.batch.id}`,
      );
      setDetail(next);
      toast.success("Коды добавлены в защищённый пул");
      await onApplied();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось применить импорт"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Импорт кодов маркировки</DialogTitle>
          <DialogDescription>
            Ожидаемый GTIN и файл TXT или одноколоночный CSV.
          </DialogDescription>
        </DialogHeader>
        {!detail && (
          <div className="grid gap-4 md:grid-cols-[1fr_240px_220px_auto] md:items-end">
            <Field label="Файл">
              <Input
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Field>
            <Field label="Ожидаемый GTIN">
              <Input
                value={gtin}
                onChange={(event) => setGtin(event.target.value.replace(/\D/g, "").slice(0, 14))}
                inputMode="numeric"
                placeholder="14 цифр"
              />
            </Field>
            <Field label="Источник">
              <Select value={acquisitionMode} onValueChange={setAcquisitionMode}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="own_suz_emission">Выпуск СУЗ</SelectItem>
                  <SelectItem value="remarking">Перемаркировка</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button
              disabled={loading || !file || gtin.length !== 14}
              onClick={preview}
            >
              {loading ? <RefreshCw className="animate-spin" /> : <FileUp />}
              Preview
            </Button>
          </div>
        )}
        {detail && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="secondary">Всего: {detail.batch.rowsTotal}</Badge>
              <Badge variant="secondary">Валидных: {detail.batch.rowsValid}</Badge>
              <Badge variant="secondary">Дублей: {detail.batch.rowsDuplicate}</Badge>
              <Badge variant={detail.batch.rowsRejected > 0 ? "destructive" : "secondary"}>
                Отклонено: {detail.batch.rowsRejected}
              </Badge>
              <StatusBadge status={detail.batch.status} />
              <span className="self-center font-mono text-xs text-muted-foreground">
                {detail.batch.expectedGtin}
              </span>
            </div>
            <div className="max-h-[420px] overflow-auto border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Строка</TableHead>
                    <TableHead>GTIN</TableHead>
                    <TableHead>Fingerprint</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead>Диагностика</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.rowNumber}</TableCell>
                      <TableCell className="font-mono text-xs">{row.gtin ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.fingerprint ?? "—"}
                      </TableCell>
                      <TableCell><StatusBadge status={row.validationStatus} /></TableCell>
                      <TableCell className="text-xs">
                        {row.errorCodes.map(importErrorLabel).join(", ") || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {detail.rowsTruncated && (
              <div className="text-xs text-muted-foreground">
                Показаны первые 500 строк.
              </div>
            )}
          </>
        )}
        <DialogFooter>
          {detail && detail.batch.status === "preview" && (
            <Button
              disabled={loading || detail.batch.rowsValid === 0}
              onClick={apply}
            >
              {loading && <RefreshCw className="animate-spin" />}
              Добавить {detail.batch.rowsValid} КМ в пул
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignmentCancelDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: MarkingAssignmentListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setReason("");
  }, [open, item?.id]);

  async function save() {
    if (!item) return;
    setSaving(true);
    try {
      await postMutation(
        `/api/admin/marking/assignments/${item.id}/cancel`,
        {
          expectedRevision: item.assignmentRevision,
          reason,
        },
      );
      toast.success(
        item.labelState === "not_rendered"
          ? "Назначение отменено, КМ возвращён в пул"
          : "Назначение отменено, КМ помещён в карантин",
      );
      await onSaved();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось отменить подготовку"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Отменить подготовку</DialogTitle>
          <DialogDescription>
            {item?.postingNumber ?? "Заказ"} · единица {item?.unitOrdinal ?? "—"} · КМ{" "}
            {item?.codeFingerprint ?? "—"}
          </DialogDescription>
        </DialogHeader>
        <Field label="Причина">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
          />
        </Field>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={saving || reason.trim().length < 3}
            onClick={save}
          >
            {saving && <RefreshCw className="animate-spin" />}
            Отменить подготовку
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignmentApplyDialog({
  item,
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  item: MarkingAssignmentListItem | null;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Подтвердить нанесение КМ</DialogTitle>
          <DialogDescription>
            Подтвердите, что этикетка физически распечатана и нанесена на
            единицу {item?.unitOrdinal ?? "—"}. После подтверждения будут
            списаны заготовка и принт/вышивка.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button disabled={!item || busy} onClick={onConfirm}>
            {busy && <RefreshCw className="animate-spin" />}
            КМ нанесён
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CodeStateDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: MarkingCodePoolItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [destroyed, setDestroyed] = useState(false);
  const [saving, setSaving] = useState(false);
  const release = item?.poolState === "quarantined";

  useEffect(() => {
    if (!open) return;
    setReason("");
    setDestroyed(false);
  }, [open, item?.id]);

  async function save() {
    if (!item) return;
    setSaving(true);
    try {
      await postMutation(
        `/api/admin/marking/codes/${item.id}/${release ? "release" : "quarantine"}`,
        {
          expectedRevision: item.revision,
          reason,
          ...(release ? { destroyedPrintedCopies: destroyed } : {}),
        },
      );
      toast.success(release ? "Код возвращён в доступный пул" : "Код помещён в карантин");
      await onSaved();
    } catch (error) {
      toast.error(errorMessage(error, "Не удалось изменить состояние КМ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {release ? "Вернуть КМ из карантина" : "Поместить КМ в карантин"}
          </DialogTitle>
          <DialogDescription>
            GTIN {item?.gtin ?? "—"} · fingerprint {item?.fingerprint ?? "—"}
          </DialogDescription>
        </DialogHeader>
        <Field label="Причина">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
          />
        </Field>
        {release && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={destroyed}
              onCheckedChange={(checked) => setDestroyed(checked === true)}
            />
            <span>Все распечатанные копии этого КМ уничтожены</span>
          </label>
        )}
        <DialogFooter>
          <Button
            variant={release ? "default" : "destructive"}
            disabled={saving || !reason.trim() || (release && !destroyed)}
            onClick={save}
          >
            {saving && <RefreshCw className="animate-spin" />}
            {release ? "Вернуть в пул" : "В карантин"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function TablePanel({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">{children}</div>
        {footer}
      </CardContent>
    </Card>
  );
}

function LoadMore<T>({
  state,
  setState,
  path,
}: {
  state: PageState<T>;
  setState: React.Dispatch<React.SetStateAction<PageState<T>>>;
  path: string;
}) {
  if (!state.hasMore || !state.cursor) return null;
  async function load() {
    setState((current) => ({ ...current, loading: true }));
    try {
      const separator = path.includes("?") ? "&" : "?";
      const page = await fetchPage<T>(
        `${path}${separator}limit=50&cursor=${encodeURIComponent(state.cursor ?? "")}`,
      );
      setState((current) => ({
        items: [...current.items, ...page.data],
        cursor: page.page.nextCursor,
        hasMore: page.page.hasMore,
        loading: false,
      }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false }));
      toast.error(errorMessage(error, "Не удалось загрузить данные"));
    }
  }
  return (
    <div className="flex justify-center border-t p-3">
      <Button variant="ghost" onClick={load} disabled={state.loading}>
        {state.loading && <RefreshCw className="animate-spin" />}
        Показать еще
      </Button>
    </div>
  );
}

function LoadingPanel() {
  return (
    <Card>
      <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Загрузка
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    ["ready", "completed", "verified", "enabled", "applied", "available"].includes(status)
      ? "default"
      : [
        "failed",
        "blocked",
        "cancelled",
        "conflict",
        "quarantined",
        "invalid",
        "rejected",
        "gtin_mismatch",
      ].includes(status)
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}

async function fetchPage<T>(url: string): Promise<ApiPage<T>> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? `Ошибка загрузки (${response.status})`);
  }
  return payload as ApiPage<T>;
}

async function fetchData<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? `Ошибка загрузки (${response.status})`);
  }
  return payload.data as T;
}

async function fetchPoolPage(url: string): Promise<PoolApiPage> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? `Ошибка загрузки (${response.status})`);
  }
  return payload as PoolApiPage;
}

async function postMutation<T = unknown>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": crypto.randomUUID(),
      "X-Request-ID": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? `Ошибка операции (${response.status})`);
  }
  return payload.data as T;
}

function toPageState<T>(page: ApiPage<T>): PageState<T> {
  return {
    items: page.data,
    cursor: page.page.nextCursor,
    hasMore: page.page.hasMore,
    loading: false,
  };
}

function readinessQuery(filters: ReadinessFilters) {
  const params = new URLSearchParams({ limit: "50" });
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.channel !== "all") params.set("channel", filters.channel);
  if (filters.conflictsOnly) params.set("conflictsOnly", "true");
  return params.toString();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function toLocalDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function statusLabel(status: string) {
  return ({
    ready: "Готов",
    blocked: "Заблокирован",
    not_required: "Не требуется",
    archived: "Архив",
    open: "Открыт",
    waiting_user: "Ждет действия",
    waiting_external: "Ждет систему",
    completed: "Завершен",
    manual_review: "Нужна проверка",
    queued: "В очереди",
    running: "Выполняется",
    succeeded: "Успешно",
    failed: "Ошибка",
    offline: "Не в сети",
    degraded: "Требует внимания",
    token_missing: "Рутокен не найден",
    signer_unavailable: "Signer недоступен",
    pin_required: "Требуется PIN",
    cancelled: "Отменен",
    active: "Активно",
    released: "Освобождено",
    preview: "Preview",
    applied: "Применён",
    pending: "Ожидает",
    leased: "Подписывается",
    signed: "Подписан",
    consumed: "Использован",
    skipped: "Пропущен",
    enabled: "Включён",
    paused: "Приостановлен",
    draft: "Черновик",
    available: "Доступен",
    reserved: "Зарезервирован",
    bound: "Назначен",
    quarantined: "Карантин",
    invalid: "Недействителен",
    retired: "Погашен",
    replaced: "Заменён",
    emitted: "Выпущен",
    introduced: "Введён",
    in_circulation: "В обороте",
    withdrawn: "Выведен",
    expired: "Истёк",
    duplicate_file: "Дубль в файле",
    duplicate_pool: "Уже в пуле",
    gtin_mismatch: "Другой GTIN",
    rejected: "Отклонён",
    scrubbed: "Очищен",
    preparing: "Подготовка",
    marking_pending: "КМ нанесён",
    shipped: "Передано",
    returned: "Возврат",
    planned: "Запланирован",
    not_rendered: "Не сформирован",
    label_rendered: "Этикетка готова",
    printed: "Напечатан",
    damaged: "Повреждён",
    lost: "Утрачен",
    destroyed: "Уничтожен",
    unknown: "Неизвестно",
    not_started: "Не передан",
    validating: "Проверяется в Ozon",
    validation_failed: "Проверка не пройдена",
    validation_rejected: "Проверка не пройдена",
    validated: "Проверен Ozon",
    submitting: "Передаётся в Ozon",
    polling: "Ozon обрабатывает",
    accepted: "Принят Ozon",
    partially_rejected: "Принят частично",
    timed_out: "Ожидание истекло",
    superseded: "Заменён новой ревизией",
    jit_assignment_prepared: "КМ зарезервирован",
    marking_label_generated: "Этикетка сформирована",
    marking_label_reprinted: "Этикетка сформирована повторно",
    marking_code_applied: "Нанесение КМ подтверждено",
    detected: "Обнаружен",
    direction_confirmed: "Направление подтверждено",
    awaiting_withdrawal: "Ждёт вывод",
    return_prepared: "LP_RETURN подготовлен",
    return_processing: "LP_RETURN обрабатывается",
    awaiting_physical_receipt: "Ждёт приёмку",
    awaiting_fbo_evidence: "Ждёт FBO / ЭДО",
  } as Record<string, string>)[status] ?? status;
}

function crptDocumentStatusLabel(status: MarkingCrptWorkspace["documents"][number]["status"]) {
  return ({
    draft: "Подготовка",
    payload_built: "Готов к подписи",
    signed: "Подписан",
    submitting: "Отправляется в ГИС МТ",
    processing: "Обрабатывается ГИС МТ",
    accepted: "Принят ГИС МТ",
    rejected: "Отклонён ГИС МТ",
    requires_manual_review: "Нужна проверка",
    superseded: "Заменён новой ревизией",
  } as const)[status];
}

function crptCirculationStatusLabel(
  status: Exclude<MarkingCrptWorkspace["documents"][number]["circulationState"], null>,
) {
  return ({
    pending: "ожидает подтверждения",
    confirmed: "в обороте",
    requires_manual_review: "нужна проверка",
  } as const)[status];
}

function crptWithdrawalStatusLabel(
  status: MarkingCrptWorkspace["documents"][number]["withdrawalState"],
) {
  return ({
    pending: "ожидает подтверждения",
    confirmed: "выведен из оборота",
    requires_manual_review: "нужна проверка",
  } as Record<string, string>)[status ?? ""] ?? "не начат";
}

function crptReturnStatusLabel(
  status: MarkingCrptWorkspace["documents"][number]["returnState"],
) {
  return ({
    pending: "ожидает подтверждения",
    confirmed: "возвращён в оборот",
    requires_manual_review: "нужна проверка",
  } as Record<string, string>)[status ?? ""] ?? "не начат";
}

function crptCodeStateLabel(status: string) {
  return statusLabel(status);
}

function modeLabel(mode: string | null) {
  return ({
    own_production: "Собственное производство",
    pre_marked_minor_customization: "Доработка маркированного",
    remarking_after_customization: "Перемаркировка",
  } as Record<string, string>)[mode ?? ""] ?? "Модель не задана";
}

function requirementLabel(value: string) {
  return ({
    unknown: "Не подтверждено",
    required: "Маркировка требуется",
    not_required: "Маркировка не требуется",
  } as Record<string, string>)[value] ?? value;
}

function operationalLabel(value: string | null) {
  return value ? statusLabel(value) : "Нет профиля";
}

function channelLabel(value: string | null) {
  return ({ ozon_fbs: "Ozon FBS", komui: "KOMUI" } as Record<string, string>)[
    value ?? ""
  ] ?? "Канал не задан";
}

function blockerLabel(value: string) {
  return ({
    profile_missing: "нет профиля",
    marking_requirement_unknown: "не подтверждено требование",
    profile_not_enabled: "профиль не включён",
    profile_paused: "профиль приостановлен",
    profile_not_verified: "профиль не проверен",
    trade_item_missing: "нет GTIN",
    trade_item_not_verified: "GTIN не проверен",
    mapping_evidence_missing: "нет подтверждения связи",
    shared_gtin_evidence_missing: "не подтвержден общий GTIN",
    catalog_color_mismatch: "цвет не совпадает с НК",
    catalog_size_mismatch: "размер не совпадает с НК",
    ozon_requirement_mismatch: "требование Ozon не совпадает",
  } as Record<string, string>)[value] ?? value;
}

function warningLabel(value: string) {
  return ({
    conformity_document_missing_for_introduction: "нет РД для ввода в оборот",
    document_reference_attention: "справочный документ требует внимания",
    ozon_requirement_not_observed: "нет наблюдения требования Ozon",
  } as Record<string, string>)[value] ?? value;
}

function conflictTypeLabel(value: MarkingConflictItem["conflictType"]) {
  return ({
    catalog_attribute_mismatch: "Атрибуты Национального каталога",
    sku_multiple_gtin: "Один SKU связан с несколькими GTIN",
    shared_gtin_incompatible_attributes: "Один GTIN для разных вариантов",
    ozon_requirement_mismatch: "Требование Ozon",
    document_reference_warning: "Справочный документ",
  } as Record<string, string>)[value];
}

function eventLabel(value: string) {
  return ({
    process_created: "Процесс создан",
    process_transitioned: "Статус процесса изменён",
    product_profile_created: "Профиль создан",
    product_profile_updated: "Профиль изменён",
    product_profile_gtin_verified: "GTIN подтверждён",
    product_profile_evidence_attached: "Подтверждение добавлено",
    product_profile_enabled: "Профиль включён",
    product_profile_paused: "Профиль приостановлен",
    product_profile_backfilled: "Черновик создан через backfill",
    marking_code_imported: "КМ добавлен в пул",
    marking_code_quarantined: "КМ помещён в карантин",
    marking_code_released: "КМ возвращён из карантина",
    jit_assignment_prepared: "КМ назначен единице заказа",
    marking_code_applied: "КМ нанесён",
    jit_assignment_cancelled: "Подготовка единицы отменена",
    jit_assignment_reconciled: "Назначение сверено с заказом",
  } as Record<string, string>)[value] ?? value;
}

function actorLabel(value: string) {
  return ({
    admin: "Администратор",
    worker: "Worker",
    system: "Система",
    migration: "Миграция",
  } as Record<string, string>)[value] ?? value;
}

function backfillActionLabel(value: string) {
  return ({
    create_draft: "Создать черновик",
    skip: "Пропустить",
    conflict: "Ручная проверка",
  } as Record<string, string>)[value] ?? value;
}

function backfillDiagnosticLabel(value: string) {
  return ({
    active_profile_exists: "профиль уже есть",
    sku_missing: "нет SKU",
    sku_not_unique: "SKU не уникален",
    marking_requirement_requires_manual_confirmation:
      "требование нужно подтвердить вручную",
    ozon_product_id_missing: "нет Ozon product ID",
  } as Record<string, string>)[value] ?? value;
}

function importErrorLabel(value: string) {
  return ({
    code_too_short: "код слишком короткий",
    code_too_long: "код слишком длинный",
    unsupported_character: "недопустимый символ",
    missing_ai_01: "нет AI 01",
    invalid_gtin: "некорректный GTIN",
    missing_ai_21: "нет AI 21",
    invalid_serial: "некорректный серийный номер",
    missing_ai_91: "нет AI 91",
    missing_ai_92: "нет AI 92",
    gtin_mismatch: "GTIN не совпадает с ожидаемым",
    duplicate_file: "повтор внутри файла",
    duplicate_pool: "код уже есть в пуле",
    duplicate_pool_race: "код параллельно добавлен другим импортом",
    preview_expired: "preview истёк",
  } as Record<string, string>)[value] ?? value;
}
