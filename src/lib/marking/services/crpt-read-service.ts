import "server-only";

import { createHash } from "node:crypto";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { queryServerDatabase } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import { enqueueJob } from "@/lib/jobs/queue";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { getCodeState } from "@/lib/marking/repositories/code-pool";
import {
  createCrptReadQuery,
  listCrptReadQueries,
  type CrptReadQueryType,
} from "@/lib/marking/repositories/crpt-read";
import {
  getLatestCrptAuthorization,
  getSignatureRequestSummary,
  listSignatureRequests,
  listSigningAgents,
} from "@/lib/marking/repositories/remote-signer";
import { listMarkingDocuments } from "@/lib/marking/repositories/documents";

export async function requestCrptReadCheck(
  input: {
    queryType: CrptReadQueryType;
    markingCodeId?: string;
    externalDocumentId?: string;
  },
  context: ServerMutationContext,
  dependencies: { config?: MarkingRuntimeConfig } = {},
) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertCrptReadOperator(config, context.actor);
  validateInput(input);
  if (input.queryType === "code_status") {
    const code = await getCodeState(queryServerDatabase, input.markingCodeId!);
    if (!code) throw new MarkingDomainError("code_not_found", "Код маркировки не найден");
    if (!config.allowedGtins.includes(code.gtin)) {
      throw new MarkingDomainError("assignment_access_denied", "GTIN не входит в разрешённый контур ГИС МТ");
    }
  }

  return withServerDatabaseTransaction(async (query) => {
    const queryId = await createCrptReadQuery(query, {
      ...input,
      actorId: context.actor,
      requestId: context.requestId,
    });
    const jobType = input.queryType === "code_status"
      ? "marking_crpt_code_status_sync"
      : "marking_crpt_document_poll";
    const queued = await enqueueJob({
      type: jobType,
      dedupeKey: `crpt-read:${queryId}`,
      idempotencyKey: context.idempotencyKey,
      payload: { queryId },
      actor: context.actor,
      requestId: context.requestId,
      maxAttempts: 5,
    }, { query });
    return { queryId, job: queued.job, reused: queued.reused };
  });
}

export async function requestCrptAuthRefresh(
  context: ServerMutationContext,
  dependencies: { config?: MarkingRuntimeConfig } = {},
) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertCrptReadOperator(config, context.actor);
  return enqueueJob({
    type: "marking_crpt_auth_refresh",
    dedupeKey: "crpt-auth-refresh",
    idempotencyKey: context.idempotencyKey,
    payload: {},
    actor: context.actor,
    requestId: context.requestId,
    maxAttempts: 3,
  });
}

export async function getCrptReadWorkspace(config = getMarkingRuntimeConfig()) {
  const [queries, signingAgents, signatureSummary, signatureRequests, authorization, documents] =
    await Promise.all([
      listCrptReadQueries(100),
      listSigningAgents(queryServerDatabase, 20),
      getSignatureRequestSummary(queryServerDatabase),
      listSignatureRequests(queryServerDatabase, 50),
      getLatestCrptAuthorization(queryServerDatabase),
      listMarkingDocuments(queryServerDatabase, 100),
    ]);
  return {
    runtime: {
      enabled: config.enabled,
      readEnabled: config.crptReadEnabled,
      signerEnabled: config.signerEnabled,
      writeEnabled: config.crptWriteEnabled,
      introductionEnabled: config.crptIntroductionEnabled,
      withdrawalEnabled: config.withdrawalEnabled,
      returnsEnabled: config.returnsEnabled,
      contour: config.crptContour,
      innConfigured: Boolean(config.crptInn),
      signerTransport: config.signerTransport,
    },
    signingAgents,
    signatureSummary,
    signatureRequests,
    authorization,
    queries,
    documents,
  };
}

function assertCrptReadOperator(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.crptReadEnabled || !config.signerEnabled) {
    throw new MarkingDomainError("crpt_read_disabled", "Проверка ГИС МТ пока выключена");
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new MarkingDomainError("assignment_access_denied", "Оператор не входит в разрешённый контур ГИС МТ");
  }
}

function validateInput(input: {
  queryType: CrptReadQueryType;
  markingCodeId?: string;
  externalDocumentId?: string;
}) {
  if (input.queryType === "code_status") {
    if (!isUuid(input.markingCodeId) || input.externalDocumentId) {
      throw new MarkingDomainError("invalid_crpt_query", "Некорректный запрос статуса КМ");
    }
    return;
  }
  if (
    input.queryType !== "document_status"
    || input.markingCodeId
    || !input.externalDocumentId
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.externalDocumentId)
  ) {
    throw new MarkingDomainError("invalid_crpt_query", "Некорректный идентификатор документа ГИС МТ");
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function crptDocumentReferenceFingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
