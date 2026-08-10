"use client";

import { useState } from "react";
import {
  BadgeCheck,
  Download,
  PackagePlus,
  Printer,
  RefreshCw,
  Send,
  ShieldCheck,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  downloadMarkingLabel,
  postMarkingMutation,
} from "@/lib/marking/client";
import type { MarkingAssignmentListItem } from "@/lib/marking/read-models/types";
import type { OzonOrderItem } from "@/lib/types";

export function OrderItemMarkingControls({
  item,
  onChanged,
}: {
  item: OzonOrderItem;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelItem, setCancelItem] =
    useState<MarkingAssignmentListItem | null>(null);
  const [applyItem, setApplyItem] =
    useState<MarkingAssignmentListItem | null>(null);
  const [reason, setReason] = useState("");
  const marking = item.marking;
  const required = (
    item.fulfillment?.marking_requirement
    ?? item.marking_requirement
  ) === "required";
  if (!required && !marking?.assignments.length) return null;

  async function prepare() {
    const candidate = marking?.candidates.find((row) => row.canPrepare);
    if (!candidate) return;
    setBusy(`prepare:${candidate.fulfillmentItemId}`);
    try {
      await postMarkingMutation("/api/admin/marking/assignments", {
        fulfillmentItemId: candidate.fulfillmentItemId,
        warehouseId: candidate.warehouseId,
      });
      toast.success("КМ зарезервирован");
      await onChanged();
    } catch (error) {
      toast.error(message(error, "Не удалось зарезервировать КМ"));
    } finally {
      setBusy(null);
    }
  }

  async function download(assignment: MarkingAssignmentListItem) {
    setBusy(`label:${assignment.id}`);
    try {
      await downloadMarkingLabel({
        assignmentId: assignment.id,
        expectedRevision: assignment.assignmentRevision,
        postingNumber: assignment.postingNumber,
        unitOrdinal: assignment.unitOrdinal,
      });
      toast.success(
        assignment.renderCount === 0
          ? "Этикетка 58x40 сформирована"
          : "Повторная этикетка сформирована",
      );
      await onChanged();
    } catch (error) {
      toast.error(message(error, "Не удалось сформировать этикетку"));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!applyItem) return;
    setBusy(`apply:${applyItem.id}`);
    try {
      await postMarkingMutation(
        `/api/admin/marking/assignments/${applyItem.id}/apply`,
        { expectedRevision: applyItem.assignmentRevision },
      );
      toast.success("Нанесение КМ подтверждено, склад обновлён");
      setApplyItem(null);
      await onChanged();
    } catch (error) {
      toast.error(message(error, "Не удалось подтвердить нанесение КМ"));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!cancelItem) return;
    setBusy(`cancel:${cancelItem.id}`);
    try {
      await postMarkingMutation(
        `/api/admin/marking/assignments/${cancelItem.id}/cancel`,
        {
          expectedRevision: cancelItem.assignmentRevision,
          reason,
        },
      );
      toast.success(
        cancelItem.labelState === "not_rendered"
          ? "Назначение отменено, КМ возвращён в пул"
          : "Назначение отменено, КМ помещён в карантин",
      );
      setCancelItem(null);
      setReason("");
      await onChanged();
    } catch (error) {
      toast.error(message(error, "Не удалось отменить подготовку"));
    } finally {
      setBusy(null);
    }
  }

  async function ozonOperation(
    assignment: MarkingAssignmentListItem,
    operation: "validate" | "submit",
  ) {
    setBusy(`ozon:${operation}:${assignment.fulfillmentOrderId}`);
    try {
      await postMarkingMutation("/api/admin/marking/ozon", {
        fulfillmentOrderId: assignment.fulfillmentOrderId,
        operation,
      });
      toast.success(
        operation === "validate"
          ? "Проверка КМ в Ozon поставлена в очередь"
          : "Передача КМ в Ozon поставлена в очередь",
      );
      await onChanged();
    } catch (error) {
      toast.error(message(
        error,
        operation === "validate"
          ? "Не удалось запустить проверку Ozon"
          : "Не удалось передать КМ в Ozon",
      ));
    } finally {
      setBusy(null);
    }
  }

  const candidates = marking?.candidates ?? [];
  const assignments = marking?.assignments ?? [];
  const availableCandidate = candidates.find((row) => row.canPrepare);
  const blocker = candidates.find((row) => row.prepareBlocker)?.prepareBlocker
    ?? (!item.fulfillment ? "Нет строки исполнения" : null);

  return (
    <div className="mt-3 border-t pt-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BadgeCheck className="h-4 w-4" />
          Маркировка
          <Badge variant="secondary">
            {assignments.length}/{item.quantity}
          </Badge>
        </div>
        {availableCandidate && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={prepare}
          >
            <PackagePlus
              className={
                busy === `prepare:${availableCandidate.fulfillmentItemId}`
                  ? "animate-pulse"
                  : ""
              }
            />
            Зарезервировать КМ
          </Button>
        )}
      </div>

      {blocker && assignments.length < item.quantity && !availableCandidate && (
        <div className="mb-2 flex items-center gap-2 text-xs text-amber-700">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          {blocker}
        </div>
      )}

      <div className="space-y-2">
        {assignments.map((assignment) => (
          <div
            key={assignment.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t py-2 first:border-t-0"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-medium">
                  Единица {assignment.unitOrdinal}/{assignment.itemQuantity}
                </span>
                <Badge variant="outline">{labelState(assignment.labelState)}</Badge>
                <Badge variant="outline">ГИС МТ: {crptState(assignment.crptState)}</Badge>
                <Badge variant="outline">Ozon: {ozonState(assignment.ozonState)}</Badge>
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                GTIN {assignment.gtin} · КМ {assignment.codeFingerprint}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {assignment.shippingBlocker}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {assignment.renderCount === 0 && assignment.canRenderLabel && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Скачать КМ 58x40"
                  disabled={busy !== null}
                  onClick={() => download(assignment)}
                >
                  <Download
                    className={
                      busy === `label:${assignment.id}` ? "animate-pulse" : ""
                    }
                  />
                </Button>
              )}
              {assignment.renderCount > 0 && assignment.canReprintLabel && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Повторная печать той же этикетки"
                  disabled={busy !== null}
                  onClick={() => download(assignment)}
                >
                  <Printer
                    className={
                      busy === `label:${assignment.id}` ? "animate-pulse" : ""
                    }
                  />
                </Button>
              )}
              {assignment.canConfirmApplied && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Подтвердить нанесение КМ"
                  disabled={busy !== null}
                  onClick={() => setApplyItem(assignment)}
                >
                  <BadgeCheck />
                </Button>
              )}
              {assignment.canValidateOzon && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Проверить КМ в Ozon"
                  disabled={busy !== null}
                  onClick={() => ozonOperation(assignment, "validate")}
                >
                  <ShieldCheck />
                </Button>
              )}
              {assignment.canSubmitOzon && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Передать КМ в Ozon"
                  disabled={busy !== null}
                  onClick={() => ozonOperation(assignment, "submit")}
                >
                  <Send />
                </Button>
              )}
              {assignment.canCancel && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Отменить подготовку"
                  disabled={busy !== null}
                  onClick={() => {
                    setReason("");
                    setCancelItem(assignment);
                  }}
                >
                  <XCircle />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog
        open={applyItem !== null}
        onOpenChange={(open) => !open && setApplyItem(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Подтвердить нанесение КМ</DialogTitle>
            <DialogDescription>
              Подтвердите, что этикетка физически распечатана и нанесена на
              единицу {applyItem?.unitOrdinal ?? "—"}. После подтверждения
              будут списаны заготовка и принт/вышивка.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={!applyItem || busy !== null}
              onClick={apply}
            >
              {busy?.startsWith("apply:") && (
                <RefreshCw className="animate-spin" />
              )}
              КМ нанесён
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelItem !== null}
        onOpenChange={(open) => !open && setCancelItem(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Отменить подготовку</DialogTitle>
            <DialogDescription>
              После выдачи этикетки КМ будет помещён в карантин.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`marking-cancel-${cancelItem?.id ?? "none"}`}>
              Причина
            </Label>
            <Textarea
              id={`marking-cancel-${cancelItem?.id ?? "none"}`}
              value={reason}
              maxLength={1_000}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3 || busy !== null}
              onClick={cancel}
            >
              {busy?.startsWith("cancel:") && (
                <RefreshCw className="animate-spin" />
              )}
              Отменить подготовку
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function labelState(value: string) {
  return ({
    not_rendered: "этикетки нет",
    label_rendered: "этикетка готова",
    printed: "напечатан",
    applied: "КМ нанесён",
  } as Record<string, string>)[value] ?? value;
}

function crptState(value: string) {
  return ({
    emitted: "выпущен",
    applied: "нанесён",
    introduced: "введён",
    in_circulation: "в обороте",
  } as Record<string, string>)[value] ?? value;
}

function ozonState(value: string) {
  return ({
    not_started: "не передан",
    prepared: "подготовлен",
    validating: "проверяется",
    validation_rejected: "проверка не пройдена",
    validated: "проверен",
    submitting: "передаётся",
    polling: "обрабатывается",
    accepted: "принят",
    rejected: "отклонён",
    manual_review: "нужна проверка",
    superseded: "заменён",
  } as Record<string, string>)[value] ?? value;
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
