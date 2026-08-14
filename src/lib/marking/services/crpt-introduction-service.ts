import "server-only";

import { createHash } from "node:crypto";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import { queryServerDatabase } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import { enqueueJob } from "@/lib/jobs/queue";
import { CrptTokenManager, CrptTrueApiClient } from "@/lib/marking/adapters/crpt/client";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  prepareIntroductionDocument,
  reconcileIntroductionSubmission,
} from "@/lib/marking/repositories/documents";
import { loadMarkingKeyring } from "@/lib/marking/security/keyring";
import { redactText } from "@/lib/marking/security/redaction";
import { loadMarkingSignerClient } from "@/lib/marking/signer/client";
import { createRemoteMarkingSignerClient } from "@/lib/marking/signer/remote-client";

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

export async function reconcileCrptIntroduction(
  input: { documentId: string; externalDocumentId: string },
  context: ServerMutationContext,
  dependencies: {
    config?: MarkingRuntimeConfig;
    client?: Pick<CrptTrueApiClient, "getDocumentStatus">;
  } = {},
) {
  if (!/^[0-9a-f-]{36}$/i.test(input.documentId)) {
    throw new MarkingDomainError("invalid_crpt_document", "Некорректный документ ввода в оборот");
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.externalDocumentId)) {
    throw new MarkingDomainError("invalid_crpt_document", "Некорректный ID документа ГИС МТ");
  }
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  if (!config.enabled || !config.crptReadEnabled || !config.signerEnabled
      || !config.allowedAdminIds.includes(context.actor)) {
    throw new MarkingDomainError("crpt_read_disabled", "Сверка с ГИС МТ сейчас недоступна");
  }
  const local = (await queryServerDatabase<{
    status: string;
    error_code: string | null;
    external_document_id: string | null;
    payload_hash: string | null;
  }>(
    `SELECT status, error_code, external_document_id, payload_hash
     FROM getomerch_marking.document_safe
     WHERE id = $1::uuid AND document_type = 'introduction'`,
    [input.documentId],
  )).rows[0];
  if (!local) {
    throw new MarkingDomainError("invalid_crpt_document", "Документ ввода в оборот не найден");
  }
  if (local.status !== "requires_manual_review"
      || local.error_code !== "crpt_submit_outcome_unknown"
      || local.external_document_id !== null) {
    throw new MarkingDomainError(
      "invalid_crpt_document",
      "Документ не ожидает сверки неизвестного результата отправки",
    );
  }

  const client = dependencies.client ?? await createReadClient(config);
  const remote = await client.getDocumentStatus(
    input.externalDocumentId,
    "lp",
    { includeContent: true },
  );
  if ((remote.type && remote.type !== "LP_INTRODUCE_GOODS")
      || (remote.productGroup && remote.productGroup !== "lp")) {
    throw new MarkingDomainError(
      "invalid_crpt_document",
      "В ГИС МТ найден документ другого типа или товарной группы",
    );
  }
  if (!config.crptInn || remote.senderInn !== config.crptInn) {
    throw new MarkingDomainError(
      "invalid_crpt_document",
      "ИНН отправителя документа ГИС МТ не совпадает с рабочим участником",
    );
  }
  if (!local.payload_hash || !remote.content
      || createHash("sha256").update(remote.content, "utf8").digest("hex") !== local.payload_hash) {
    throw new MarkingDomainError(
      "invalid_crpt_document",
      "Содержимое документа ГИС МТ не совпадает с локально подписанным документом",
    );
  }
  const errorCode = remote.errorCode
    ? stableExternalErrorCode(remote.errorCode)
    : null;
  const errorMessage = remote.errorMessage
    ? redactText(remote.errorMessage).slice(0, 1000)
    : null;
  return runServerMutation({
    operation: "marking.crpt.introduction.reconcile",
    payload: {
      documentId: input.documentId,
      externalDocumentId: input.externalDocumentId,
      remoteStatus: remote.status,
    },
    context,
    execute: async (query, checkpoint) => {
      const status = await reconcileIntroductionSubmission(query, {
        documentId: input.documentId,
        externalDocumentId: input.externalDocumentId,
        remoteStatus: remote.status,
        response: {
          number: remote.number,
          type: remote.type,
          status: remote.status,
          productGroup: remote.productGroup,
          senderInn: remote.senderInn,
          contentVerified: true,
        },
        errorCode,
        errorMessage,
        actorId: context.actor,
      });
      let jobId: string | null = null;
      if (status === "processing" || status === "accepted") {
        const queued = await enqueueJob({
          type: "marking_crpt_document_poll",
          dedupeKey: `crpt-introduction-poll:${input.documentId}`,
          idempotencyKey: `crpt-introduction-reconcile-poll:${context.idempotencyKey}`,
          payload: { documentId: input.documentId },
          actor: context.actor,
          requestId: context.requestId,
          maxAttempts: 20,
        }, { query, scope: "marking" });
        jobId = queued.job.id;
      }
      checkpoint("crpt_introduction_reconciled");
      return {
        data: { documentId: input.documentId, status, jobId },
        audit: {
          entityType: "marking_document",
          entityId: input.documentId,
          before: local,
          after: {
            status,
            externalDocumentId: input.externalDocumentId,
            remoteStatus: remote.status,
          },
        },
      };
    },
  });
}

async function createReadClient(config: MarkingRuntimeConfig) {
  const keyring = await loadMarkingKeyring(config.keyringFile);
  const signer = config.signerTransport === "remote"
    ? createRemoteMarkingSignerClient({ query: queryServerDatabase, keyring })
    : await loadMarkingSignerClient({
        socketPath: config.signerSocketPath,
        caller: config.signerClientId,
        secretFile: config.signerClientSecretFile,
      });
  const tokens = new CrptTokenManager({
    contour: config.crptContour,
    inn: config.crptInn || undefined,
    signer,
  });
  return new CrptTrueApiClient({ contour: config.crptContour, tokenManager: tokens });
}

function stableExternalErrorCode(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9_:-]+/g, "_").slice(0, 120);
  return normalized.length >= 2 ? normalized : "crpt_document_rejected";
}
