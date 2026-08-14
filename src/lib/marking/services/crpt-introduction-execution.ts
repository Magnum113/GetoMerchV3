import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { queryServerDatabase } from "@/lib/db/pool";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import { enqueueJob } from "@/lib/jobs/queue";
import { CrptApiError, CrptTokenManager, CrptTrueApiClient } from "@/lib/marking/adapters/crpt/client";
import { normalizeCrptCodeState } from "@/lib/marking/adapters/crpt/contracts";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import {
  buildLpIntroduceGoodsPayload,
  CRPT_INTRODUCTION_CONTRACT_VERSION,
  extractIdentificationCode,
} from "@/lib/marking/domain/crpt-introduction";
import {
  confirmIntroductionCirculation,
  getIntroductionDocumentMaterial,
  prepareIntroductionDocument,
  recordIntroductionManualReview,
  recordIntroductionPoll,
  recordIntroductionCirculationReview,
  reconcileIntroductionSubmission,
  recordIntroductionSubmitted,
  recordIntroductionSubmitStarted,
  storeIntroductionPayload,
  storeIntroductionSignature,
} from "@/lib/marking/repositories/documents";
import { loadMarkingKeyring, type MarkingKeyring } from "@/lib/marking/security/keyring";
import { redactText } from "@/lib/marking/security/redaction";
import { loadMarkingSignerClient, type MarkingSignerClient } from "@/lib/marking/signer/client";
import { createRemoteMarkingSignerClient } from "@/lib/marking/signer/remote-client";

type Runtime = {
  query: DatabaseQueryExecutor;
  config: MarkingRuntimeConfig;
  keyring: MarkingKeyring;
  signer: MarkingSignerClient;
  tokens: CrptTokenManager;
  client: CrptTrueApiClient;
};
type Dependencies = Partial<Runtime>;
let runtimePromise: Promise<Runtime> | null = null;

export async function executeCrptApplicationConfirmation(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const assignmentId = requiredUuid(context.job.payload.assignmentId, "assignmentId");
  const runtime = await createRuntime(dependencies);
  assertIntroduction(runtime.config, context.job.actor);
  const prepared = await prepareIntroductionDocument(runtime.query, {
    assignmentId,
    actorId: context.job.actor,
    requestId: context.job.requestId,
  });
  if (["accepted", "processing", "signed", "submitting"].includes(prepared.status)) {
    const queued = await enqueueIntroductionSubmit(context, prepared.id);
    return { documentId: prepared.id, status: prepared.status, jobId: queued.id, reused: true };
  }
  if (["rejected", "requires_manual_review", "superseded"].includes(prepared.status)) {
    return { documentId: prepared.id, status: prepared.status, reused: true };
  }

  let material = await getIntroductionDocumentMaterial(runtime.query, prepared.id, context.job.actor);
  assertContractVersion(material.contractVersion);
  if (!inCanaryScope(runtime.config, material.gtin, material.offerId)) {
    await recordIntroductionManualReview(runtime.query, {
      documentId: prepared.id,
      errorCode: "crpt_canary_scope_denied",
      errorMessage: "GTIN или offer ID не входит в разрешённый контур ввода в оборот",
      phase: "scope",
    });
    return { documentId: prepared.id, status: "requires_manual_review" };
  }
  if (material.status === "draft" && material.conformityDocuments.length === 0) {
    await recordIntroductionManualReview(runtime.query, {
      documentId: prepared.id,
      errorCode: "crpt_conformity_document_missing",
      errorMessage: "Для ввода в оборот у GTIN не указан действующий документ соответствия",
      phase: "conformity_document",
    });
    return { documentId: prepared.id, status: "requires_manual_review" };
  }
  if (material.status === "draft") {
    await context.report({ phase: "application_report", documentId: prepared.id }, "crpt_application_report_check_started");
    const code = runtime.keyring.decryptBytes(material.encryptedCode);
    let identificationCode: Buffer | null = null;
    let payload: Buffer | null = null;
    try {
      identificationCode = Buffer.from(extractIdentificationCode(code), "ascii");
      const remote = await runtime.client.getCodeStatus(identificationCode, "lp");
      const state = normalizeCrptCodeState(remote.status);
      if (remote.errorCode) {
        await recordIntroductionManualReview(runtime.query, {
          documentId: prepared.id,
          errorCode: stableErrorCode(remote.errorCode, "crpt_code_status_error"),
          errorMessage: remote.errorMessage ?? "ГИС МТ не подтвердила статус КМ",
          phase: "application_report",
        });
        return { documentId: prepared.id, status: "requires_manual_review" };
      }
      if (remote.gtin !== material.gtin || (runtime.config.crptInn && remote.ownerInn !== runtime.config.crptInn)) {
        await recordIntroductionManualReview(runtime.query, {
          documentId: prepared.id,
          errorCode: "crpt_code_ownership_mismatch",
          errorMessage: "GTIN или владелец КМ не совпадает с профилем товара",
          phase: "application_report",
        });
        return { documentId: prepared.id, status: "requires_manual_review" };
      }
      if (!["applied", "introduced", "in_circulation"].includes(state)) {
        if (context.job.attemptCount >= context.job.maxAttempts) {
          await recordIntroductionManualReview(runtime.query, {
            documentId: prepared.id,
            errorCode: "crpt_application_report_not_confirmed",
            errorMessage: "ГИС МТ не подтвердила автоматический отчёт о нанесении в отведённое время",
            phase: "application_report",
          });
          return { documentId: prepared.id, status: "requires_manual_review" };
        }
        throw new CrptApiError(
          "crpt_application_report_pending",
          "Автоматический отчёт о нанесении ещё не подтверждён ГИС МТ",
          true,
        );
      }
      if (state === "introduced" || state === "in_circulation") {
        await recordIntroductionManualReview(runtime.query, {
          documentId: prepared.id,
          errorCode: "crpt_code_already_progressed",
          errorMessage: "КМ уже вводился в оборот; автоматическая повторная подача остановлена",
          phase: "application_report",
        });
        return { documentId: prepared.id, status: "requires_manual_review" };
      }
      const built = buildLpIntroduceGoodsPayload({
        inn: requiredInn(runtime.config.crptInn),
        gtin: material.gtin,
        tnvedCode: material.tnvedCode,
        productionDate: material.productionDate,
        markingCode: code,
        conformityDocuments: material.conformityDocuments,
      });
      payload = built.bytes;
      const digest = sha256(payload);
      const encrypted = runtime.keyring.encryptBytes(payload);
      await storeIntroductionPayload(runtime.query, {
        documentId: prepared.id,
        payloadHash: digest,
        encrypted,
        actorId: context.job.actor,
      });
    } finally {
      code.fill(0);
      identificationCode?.fill(0);
      payload?.fill(0);
    }
    material = await getIntroductionDocumentMaterial(runtime.query, prepared.id, context.job.actor);
    assertContractVersion(material.contractVersion);
  }

  if (material.status === "payload_built") {
    if (!material.encryptedPayload || !material.payloadHash) {
      throw new Error("Built CRPT document has no encrypted payload");
    }
    const payload = runtime.keyring.decryptBytes(material.encryptedPayload);
    try {
      if (sha256(payload) !== material.payloadHash) {
        throw new Error("CRPT payload digest changed before signing");
      }
      await context.report({ phase: "signing", documentId: prepared.id }, "crpt_introduction_sign_started");
      const signed = await runtime.signer.sign(payload, "crpt_document_detached_cades_bes");
      if (runtime.config.crptInn && signed.certificate.inn !== runtime.config.crptInn) {
        throw new Error("Signing certificate INN does not match CRPT participant");
      }
      const signature = Buffer.from(signed.signatureBase64, "base64");
      try {
        await storeIntroductionSignature(runtime.query, {
          documentId: prepared.id,
          signatureHash: sha256(signature),
          encrypted: runtime.keyring.encryptBytes(signature),
          certificateThumbprint: signed.certificate.thumbprint,
          actorId: context.job.actor,
        });
      } finally {
        signature.fill(0);
      }
    } finally {
      payload.fill(0);
    }
  }
  const queued = await enqueueIntroductionSubmit(context, prepared.id);
  return { documentId: prepared.id, status: "signed", jobId: queued.id };
}

export async function executeCrptIntroductionSubmit(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const documentId = requiredUuid(context.job.payload.documentId, "documentId");
  const runtime = await createRuntime(dependencies);
  assertIntroduction(runtime.config, context.job.actor);
  const material = await getIntroductionDocumentMaterial(runtime.query, documentId, context.job.actor);
  assertContractVersion(material.contractVersion);
  if (material.status === "accepted" || material.status === "processing") {
    const poll = await enqueueIntroductionPoll(context, documentId);
    return { documentId, status: material.status, pollJobId: poll.id, reused: true };
  }
  if (material.status === "submitting") {
    await recordIntroductionManualReview(runtime.query, {
      documentId,
      errorCode: "crpt_submit_outcome_unknown",
      errorMessage: "Worker был прерван во время отправки; результат нужно сверить в личном кабинете",
      phase: "submit_recovery",
    });
    return { documentId, status: "requires_manual_review", ambiguous: true };
  }
  if (material.status !== "signed" || !material.encryptedPayload || !material.encryptedSignature
      || !material.payloadHash || !material.signatureHash) {
    return { documentId, status: material.status, reused: true };
  }
  if (!inCanaryScope(runtime.config, material.gtin, material.offerId)) {
    await recordIntroductionManualReview(runtime.query, {
      documentId,
      errorCode: "crpt_canary_scope_denied",
      errorMessage: "GTIN или offer ID больше не входит в разрешённый контур ввода в оборот",
      phase: "scope",
    });
    return { documentId, status: "requires_manual_review" };
  }
  const payload = runtime.keyring.decryptBytes(material.encryptedPayload);
  const signature = runtime.keyring.decryptBytes(material.encryptedSignature);
  try {
    if (sha256(payload) !== material.payloadHash || sha256(signature) !== material.signatureHash) {
      await recordIntroductionManualReview(runtime.query, {
        documentId,
        errorCode: "crpt_signed_material_stale",
        errorMessage: "Подписанный документ изменился до отправки",
        phase: "submit",
      });
      return { documentId, status: "requires_manual_review" };
    }
    await context.report({ phase: "submitting", documentId }, "crpt_introduction_submit_started");
    await recordIntroductionSubmitStarted(runtime.query, {
      documentId,
      actorId: context.job.actor,
    });
    let created;
    try {
      created = await runtime.client.createManualDocument({
        documentType: "LP_INTRODUCE_GOODS",
        productDocument: payload,
        detachedSignatureBase64: signature.toString("base64"),
      });
    } catch (error) {
      const safe = safeError(error);
      await recordIntroductionManualReview(runtime.query, {
        documentId,
        errorCode: "crpt_submit_outcome_unknown",
        errorMessage: `Результат отправки в ГИС МТ неизвестен: ${safe.message}`.slice(0, 1000),
        phase: "submit_ambiguous",
      });
      return { documentId, status: "requires_manual_review", ambiguous: true };
    }
    const status = await recordIntroductionSubmitted(runtime.query, {
      documentId,
      externalDocumentId: created.externalDocumentId,
      actorId: context.job.actor,
    });
    const poll = await enqueueIntroductionPoll(context, documentId);
    return { documentId, status, externalDocumentId: created.externalDocumentId, pollJobId: poll.id };
  } finally {
    payload.fill(0);
    signature.fill(0);
  }
}

export async function executeCrptIntroductionPoll(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const documentId = requiredUuid(context.job.payload.documentId, "documentId");
  const runtime = await createRuntime(dependencies);
  assertIntroductionRead(runtime.config, context.job.actor);
  let material = await getIntroductionDocumentMaterial(runtime.query, documentId, context.job.actor);
  assertContractVersion(material.contractVersion);
  if (material.status === "processing") {
    if (!material.externalDocumentId) throw new Error("CRPT document ID is missing");
    const remote = await runtime.client.getDocumentStatus(material.externalDocumentId, "lp");
    if ((remote.type && remote.type !== "LP_INTRODUCE_GOODS")
        || (remote.productGroup && remote.productGroup !== "lp")) {
      await recordIntroductionManualReview(runtime.query, {
        documentId,
        errorCode: "crpt_document_type_mismatch",
        errorMessage: "ГИС МТ вернула другой тип документа",
        phase: "poll",
      });
      return { documentId, status: "requires_manual_review" };
    }
    const status = await recordIntroductionPoll(runtime.query, {
      documentId,
      remoteStatus: remote.status,
      response: { number: remote.number, type: remote.type, status: remote.status,
        productGroup: remote.productGroup },
      errorCode: remote.errorCode
        ? stableErrorCode(remote.errorCode, "crpt_document_rejected") : null,
      errorMessage: remote.errorMessage,
    });
    if (status === "processing") {
      if (context.job.attemptCount >= context.job.maxAttempts) {
        await recordIntroductionManualReview(runtime.query, {
          documentId,
          errorCode: "crpt_document_poll_exhausted",
          errorMessage: "ГИС МТ не завершила обработку документа в отведённое время",
          phase: "poll",
        });
        return { documentId, status: "requires_manual_review" };
      }
      throw new CrptApiError("crpt_document_processing", "Документ ГИС МТ ещё обрабатывается", true);
    }
    if (status !== "accepted") return { documentId, status };
    material = await getIntroductionDocumentMaterial(runtime.query, documentId, context.job.actor);
  }
  if (material.status === "accepted") {
    const code = runtime.keyring.decryptBytes(material.encryptedCode);
    let identificationCode: Buffer | null = null;
    try {
      identificationCode = Buffer.from(extractIdentificationCode(code), "ascii");
      const remote = await runtime.client.getCodeStatus(identificationCode, "lp");
      const state = normalizeCrptCodeState(remote.status);
      if (remote.errorCode) {
        await recordIntroductionCirculationReview(runtime.query, {
          documentId,
          errorCode: stableErrorCode(remote.errorCode, "crpt_code_status_error"),
          errorMessage: remote.errorMessage ?? "ГИС МТ не вернула состояние принятого КМ",
          rawStatus: remote.status,
        });
        return { documentId, status: "accepted", circulationState: "requires_manual_review" };
      }
      if (remote.gtin !== material.gtin || (runtime.config.crptInn && remote.ownerInn !== runtime.config.crptInn)) {
        await recordIntroductionCirculationReview(runtime.query, {
          documentId,
          errorCode: "crpt_code_ownership_mismatch",
          errorMessage: "Статус принятого КМ не совпал с профилем товара",
          rawStatus: remote.status,
        });
        return { documentId, status: "accepted", circulationState: "requires_manual_review" };
      }
      if (state !== "in_circulation") {
        if (context.job.attemptCount >= context.job.maxAttempts) {
          await recordIntroductionCirculationReview(runtime.query, {
            documentId,
            errorCode: "crpt_circulation_not_confirmed",
            errorMessage: "Документ принят, но статус КМ «В обороте» не подтверждён",
            rawStatus: [remote.status, remote.statusEx].filter(Boolean).join(":") || null,
          });
          return {
            documentId,
            status: "accepted",
            circulationState: "requires_manual_review",
          };
        }
        throw new CrptApiError("crpt_circulation_pending", "ГИС МТ ещё не подтвердила статус «В обороте»", true);
      }
      await confirmIntroductionCirculation(runtime.query, {
        documentId,
        rawStatus: [remote.status, remote.statusEx].filter(Boolean).join(":"),
        actorId: context.job.actor,
      });
      return { documentId, status: "accepted", codeState: "in_circulation" };
    } finally {
      code.fill(0);
      identificationCode?.fill(0);
    }
  }
  return { documentId, status: material.status, reused: true };
}

export async function executeCrptIntroductionReconciliation(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const documentId = requiredUuid(context.job.payload.reconcileDocumentId, "reconcileDocumentId");
  const externalDocumentId = requiredExternalDocumentId(context.job.payload.externalDocumentId);
  const runtime = await createRuntime(dependencies);
  assertIntroductionRead(runtime.config, context.job.actor);
  const local = (await runtime.query<{
    status: string;
    error_code: string | null;
    external_document_id: string | null;
    payload_hash: string | null;
  }>(
    `SELECT status, error_code, external_document_id, payload_hash
     FROM getomerch_marking.document_safe
     WHERE id = $1::uuid AND document_type = 'introduction'`,
    [documentId],
  )).rows[0];
  if (!local) throw new Error("CRPT introduction document was not found");
  if (local.external_document_id === externalDocumentId
      && ["processing", "accepted", "rejected"].includes(local.status)) {
    const pollJobId = local.status === "processing" || local.status === "accepted"
      ? (await enqueueIntroductionPoll(context, documentId)).id
      : null;
    return {
      documentId,
      externalDocumentId,
      status: local.status,
      pollJobId,
      reused: true,
    };
  }
  if (local.status !== "requires_manual_review"
      || local.error_code !== "crpt_submit_outcome_unknown"
      || local.external_document_id !== null) {
    throw new Error("CRPT introduction document is not awaiting reconciliation");
  }

  await context.report(
    { phase: "reconciliation", documentId },
    "crpt_introduction_reconciliation_started",
  );
  const remote = await runtime.client.getDocumentStatus(
    externalDocumentId,
    "lp",
    { includeContent: true },
  );
  if (!matchesCrptIntroductionMetadata(remote, runtime.config.crptInn)) {
    throw new Error("CRPT reconciliation metadata does not match the local introduction document");
  }
  if (!local.payload_hash || !remote.content
      || !matchesCrptDocumentContentHash(remote.content, local.payload_hash)) {
    throw new Error("CRPT reconciliation content does not match the locally signed document");
  }

  const status = await reconcileIntroductionSubmission(runtime.query, {
    documentId,
    externalDocumentId,
    remoteStatus: remote.status,
    response: {
      number: remote.number,
      type: remote.type,
      status: remote.status,
      productGroup: remote.productGroup,
      senderInn: remote.senderInn,
      contentVerified: true,
    },
    errorCode: remote.errorCode
      ? stableErrorCode(remote.errorCode, "crpt_document_rejected")
      : null,
    errorMessage: remote.errorMessage
      ? redactText(remote.errorMessage).slice(0, 1000)
      : null,
    actorId: context.job.actor,
  });
  let pollJobId: string | null = null;
  if (status === "processing" || status === "accepted") {
    pollJobId = (await enqueueIntroductionPoll(context, documentId)).id;
  }
  await context.report(
    { phase: "reconciled", documentId, status },
    "crpt_introduction_reconciled",
  );
  return { documentId, externalDocumentId, status, pollJobId };
}

export function matchesCrptDocumentContentHash(content: string, expectedHash: string) {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  if (createHash("sha256").update(content, "utf8").digest("hex") === expectedHash) return true;
  if (content.length === 0 || content.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return false;
  const decoded = Buffer.from(content, "base64");
  try {
    if (decoded.toString("base64") !== content) return false;
    return sha256(decoded) === expectedHash;
  } finally {
    decoded.fill(0);
  }
}

export function matchesCrptIntroductionMetadata(
  remote: { type: string | null; productGroup: string | null; senderInn: string | null },
  participantInn: string,
) {
  if (!/^\d{10}(?:\d{2})?$/.test(participantInn)) return false;
  if (remote.type !== null && remote.type.trim().toUpperCase() !== "LP_INTRODUCE_GOODS") {
    return false;
  }
  if (remote.productGroup !== null && remote.productGroup.trim().toLowerCase() !== "lp") {
    return false;
  }
  return remote.senderInn === null || remote.senderInn === participantInn;
}

async function enqueueIntroductionSubmit(context: JobExecutionContext, documentId: string) {
  return (await enqueueJob({
    type: "marking_crpt_introduction_submit",
    dedupeKey: `crpt-introduction-submit:${documentId}`,
    idempotencyKey: `crpt-introduction-submit:${documentId}`,
    payload: { documentId }, actor: context.job.actor, requestId: context.job.requestId,
    maxAttempts: 2,
  }, { scope: "marking" })).job;
}
async function enqueueIntroductionPoll(context: JobExecutionContext, documentId: string) {
  return (await enqueueJob({
    type: "marking_crpt_document_poll",
    dedupeKey: `crpt-introduction-poll:${documentId}`,
    idempotencyKey: `crpt-introduction-poll:${documentId}`,
    payload: { documentId }, actor: context.job.actor, requestId: context.job.requestId,
    maxAttempts: 20,
  }, { scope: "marking" })).job;
}

async function createRuntime(dependencies: Dependencies): Promise<Runtime> {
  if (Object.keys(dependencies).length > 0) return buildRuntime(dependencies);
  if (!runtimePromise) runtimePromise = buildRuntime({ query: queryServerDatabase })
    .catch((error) => { runtimePromise = null; throw error; });
  return runtimePromise;
}
async function buildRuntime(dependencies: Dependencies): Promise<Runtime> {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  const query = dependencies.query ?? queryServerDatabase;
  const keyring = dependencies.keyring ?? await loadMarkingKeyring(config.keyringFile);
  const signer = dependencies.signer ?? (config.signerTransport === "remote"
    ? createRemoteMarkingSignerClient({ query, keyring })
    : await loadMarkingSignerClient({ socketPath: config.signerSocketPath,
      caller: config.signerClientId, secretFile: config.signerClientSecretFile }));
  const tokens = dependencies.tokens ?? new CrptTokenManager({ contour: config.crptContour,
    inn: config.crptInn || undefined, signer });
  return { query, config, keyring, signer, tokens,
    client: dependencies.client ?? new CrptTrueApiClient({ contour: config.crptContour, tokenManager: tokens }) };
}
function assertIntroduction(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.crptIntroductionEnabled || !config.crptReadEnabled
      || !config.crptWriteEnabled || !config.signerEnabled) {
    throw new Error("CRPT introduction is disabled");
  }
  if (!config.allowedAdminIds.includes(actor)) throw new Error("CRPT introduction actor is denied");
}
function assertIntroductionRead(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.crptReadEnabled || !config.signerEnabled) {
    throw new Error("CRPT introduction polling is disabled");
  }
  if (!config.allowedAdminIds.includes(actor)) throw new Error("CRPT introduction actor is denied");
}
function inCanaryScope(config: MarkingRuntimeConfig, gtin: string, offerId: string | null) {
  return config.allowedGtins.includes(gtin)
    && offerId !== null
    && config.allowedOffers.includes(offerId);
}
function requiredUuid(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function requiredExternalDocumentId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error("Invalid externalDocumentId");
  }
  return value;
}
function requiredInn(value: string) {
  if (!/^\d{10}(?:\d{2})?$/.test(value)) throw new Error("CRPT participant INN is not configured");
  return value;
}
function sha256(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function assertContractVersion(value: string) {
  if (value !== CRPT_INTRODUCTION_CONTRACT_VERSION) {
    throw new Error("CRPT introduction contract version is not supported");
  }
}
function safeError(error: unknown) {
  const rawCode = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code) : "crpt_submit_outcome_unknown";
  const normalizedCode = rawCode.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 120);
  return { code: normalizedCode.length >= 2 ? normalizedCode : "crpt_submit_error",
    message: redactText(error instanceof Error ? error.message : "Результат отправки в ГИС МТ неизвестен").slice(0, 1000) };
}
function stableErrorCode(value: string, fallback: string) {
  const normalized = value.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 120);
  return normalized.length >= 2 ? normalized : fallback;
}
