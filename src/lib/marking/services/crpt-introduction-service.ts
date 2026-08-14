import "server-only";

import { createHash } from "node:crypto";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import { enqueueJob } from "@/lib/jobs/queue";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { prepareIntroductionDocument } from "@/lib/marking/repositories/documents";

export async function retryCrptIntroduction(
  assignmentId: string,
  context: ServerMutationContext,
  dependencies: { config?: MarkingRuntimeConfig } = {},
) {
  if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) {
    throw new MarkingDomainError("invalid_crpt_document", "Некорректное назначение КМ");
  }
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  if (!config.crptIntroductionEnabled || !config.allowedAdminIds.includes(context.actor)) {
    throw new MarkingDomainError("crpt_write_disabled", "Ввод в оборот ГИС МТ пока выключен");
  }
  return withServerDatabaseTransaction(async (query) => {
    const current = (await query<{
      status: string;
      error_code: string | null;
    }>(
      `SELECT document.status, document.error_code
       FROM getomerch_marking.document_safe AS document
       JOIN getomerch_marking.document_code_safe AS code
         ON code.document_id = document.id
       WHERE code.assignment_id = $1::uuid AND code.link_state = 'active'
       LIMIT 1`,
      [assignmentId],
    )).rows[0];
    if (current?.error_code === "crpt_submit_outcome_unknown") {
      throw new MarkingDomainError(
        "invalid_crpt_document",
        "Сначала сверьте неизвестный результат отправки в личном кабинете Честного знака",
      );
    }
    const document = await prepareIntroductionDocument(query, {
      assignmentId,
      actorId: context.actor,
      requestId: context.requestId,
      forceCorrection: shouldForceIntroductionCorrection(current),
    });
    const queued = await enqueueJob({
      type: "marking_crpt_application_submit",
      dedupeKey: `crpt-application:${assignmentId}:r${document.revision}`,
      idempotencyKey: introductionRetryJobIdempotencyKey({
        assignmentId,
        documentRevision: document.revision,
        requestIdempotencyKey: context.idempotencyKey,
      }),
      payload: { assignmentId }, actor: context.actor, requestId: context.requestId,
      maxAttempts: 5,
    }, { query });
    return { document, job: queued.job, reused: queued.reused };
  });
}

export function shouldForceIntroductionCorrection(
  current: { status: string } | undefined,
) {
  return current != null
    && ["rejected", "requires_manual_review"].includes(current.status);
}

export function introductionRetryJobIdempotencyKey(input: {
  assignmentId: string;
  documentRevision: number;
  requestIdempotencyKey: string;
}) {
  const digest = createHash("sha256")
    .update(`${input.assignmentId}:${input.documentRevision}:${input.requestIdempotencyKey}`)
    .digest("hex");
  return `crpt-application-retry:${digest}`;
}

export async function retryCrptCirculationConfirmation(
  documentId: string,
  context: ServerMutationContext,
  dependencies: { config?: MarkingRuntimeConfig } = {},
) {
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) {
    throw new MarkingDomainError("invalid_crpt_document", "Некорректный документ ввода в оборот");
  }
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  if (!config.enabled || !config.crptReadEnabled || !config.signerEnabled
      || !config.allowedAdminIds.includes(context.actor)) {
    throw new MarkingDomainError("crpt_read_disabled", "Проверка статуса КМ в ГИС МТ пока выключена");
  }
  return withServerDatabaseTransaction(async (query) => {
    const document = (await query<{
      status: string;
      circulation_state: string;
    }>(
      `SELECT status, circulation_state
       FROM getomerch_marking.document_safe
       WHERE id = $1::uuid`,
      [documentId],
    )).rows[0];
    if (!document || document.status !== "accepted"
        || document.circulation_state !== "requires_manual_review") {
      throw new MarkingDomainError(
        "invalid_crpt_document",
        "Повторная проверка доступна только для принятого документа без подтверждённого статуса КМ",
      );
    }
    const queued = await enqueueJob({
      type: "marking_crpt_document_poll",
      dedupeKey: `crpt-circulation-recheck:${documentId}`,
      idempotencyKey: context.idempotencyKey,
      payload: { documentId }, actor: context.actor, requestId: context.requestId,
      maxAttempts: 20,
    }, { query });
    return { documentId, job: queued.job, reused: queued.reused };
  });
}
