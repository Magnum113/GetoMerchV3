import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { queryServerDatabase } from "@/lib/db/pool";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  CrptApiError,
  CrptTokenManager,
  CrptTrueApiClient,
} from "@/lib/marking/adapters/crpt/client";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import {
  buildLpRemoteSaleReturnPayload,
  CRPT_RETURN_CONTRACT_VERSION,
} from "@/lib/marking/domain/crpt-return";
import {
  recordIntroductionSubmitted,
  recordIntroductionSubmitStarted,
  storeIntroductionPayload,
  storeIntroductionSignature,
} from "@/lib/marking/repositories/documents";
import {
  getReturnDocumentMaterial,
  recordReturnManualReview,
  recordReturnPoll,
} from "@/lib/marking/repositories/returns";
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

export async function executeCrptReturnSubmit(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const documentId = requiredUuid(context.job.payload.documentId, "documentId");
  const runtime = await createRuntime(dependencies);
  assertReturnWrite(runtime.config, context.job.actor);
  let material = await getReturnDocumentMaterial(runtime.query, documentId, context.job.actor);
  assertContractVersion(material.contractVersion);
  if (["accepted", "rejected", "requires_manual_review", "superseded"].includes(material.status)) {
    return { documentId, status: material.status, reused: true };
  }
  if (material.status === "processing") {
    const poll = await enqueueReturnPoll(context, documentId);
    return { documentId, status: material.status, pollJobId: poll.id, reused: true };
  }
  if (material.status === "submitting") {
    await manual(runtime, documentId, "crpt_submit_outcome_unknown",
      "Worker был прерван во время LP_RETURN; результат нужно сверить в личном кабинете",
      "submit_recovery");
    return { documentId, status: "requires_manual_review", ambiguous: true };
  }
  if (!inCanaryScope(runtime.config, material.gtin, material.offerId)) {
    await manual(runtime, documentId, "crpt_canary_scope_denied",
      "GTIN или offer ID не входит в разрешённый контур возвратов", "scope");
    return { documentId, status: "requires_manual_review" };
  }

  if (material.status === "draft") {
    const code = runtime.keyring.decryptBytes(material.encryptedCode);
    let payload: Buffer | null = null;
    try {
      const built = buildLpRemoteSaleReturnPayload({
        inn: requiredInn(runtime.config.crptInn),
        actionDate: material.actionDate,
        returnReference: material.sourceReturnId,
        paid: material.paid,
        gtin: material.gtin,
        markingCode: code,
      });
      payload = built.bytes;
      await storeIntroductionPayload(runtime.query, {
        documentId,
        payloadHash: sha256(payload),
        encrypted: runtime.keyring.encryptBytes(payload),
        actorId: context.job.actor,
      });
    } finally {
      code.fill(0);
      payload?.fill(0);
    }
    material = await getReturnDocumentMaterial(runtime.query, documentId, context.job.actor);
  }

  if (material.status === "payload_built") {
    if (!material.encryptedPayload || !material.payloadHash) {
      throw new Error("Built LP_RETURN has no encrypted payload");
    }
    const payload = runtime.keyring.decryptBytes(material.encryptedPayload);
    try {
      if (sha256(payload) !== material.payloadHash) {
        throw new Error("LP_RETURN payload digest changed before signing");
      }
      await context.report({ phase: "signing", documentId }, "crpt_return_sign_started");
      const signed = await runtime.signer.sign(payload, "crpt_document_detached_cades_bes");
      if (runtime.config.crptInn && signed.certificate.inn !== runtime.config.crptInn) {
        throw new Error("Signing certificate INN does not match CRPT participant");
      }
      const signature = Buffer.from(signed.signatureBase64, "base64");
      try {
        await storeIntroductionSignature(runtime.query, {
          documentId,
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
    material = await getReturnDocumentMaterial(runtime.query, documentId, context.job.actor);
  }

  if (material.status !== "signed" || !material.encryptedPayload
      || !material.encryptedSignature || !material.payloadHash || !material.signatureHash) {
    return { documentId, status: material.status, reused: true };
  }
  const payload = runtime.keyring.decryptBytes(material.encryptedPayload);
  const signature = runtime.keyring.decryptBytes(material.encryptedSignature);
  try {
    if (sha256(payload) !== material.payloadHash || sha256(signature) !== material.signatureHash) {
      await manual(runtime, documentId, "crpt_signed_material_stale",
        "Подписанный LP_RETURN изменился до отправки", "submit");
      return { documentId, status: "requires_manual_review" };
    }
    await context.report({ phase: "submitting", documentId }, "crpt_return_submit_started");
    await recordIntroductionSubmitStarted(runtime.query, {
      documentId,
      actorId: context.job.actor,
    });
    let created;
    try {
      created = await runtime.client.createManualDocument({
        documentType: "LP_RETURN",
        productDocument: payload,
        detachedSignatureBase64: signature.toString("base64"),
      });
    } catch (error) {
      const safe = safeError(error);
      await manual(runtime, documentId, "crpt_submit_outcome_unknown",
        `Результат отправки LP_RETURN неизвестен: ${safe.message}`.slice(0, 1000),
        "submit_ambiguous");
      return { documentId, status: "requires_manual_review", ambiguous: true };
    }
    const status = await recordIntroductionSubmitted(runtime.query, {
      documentId,
      externalDocumentId: created.externalDocumentId,
      actorId: context.job.actor,
    });
    const poll = await enqueueReturnPoll(context, documentId);
    return { documentId, status, externalDocumentId: created.externalDocumentId,
      pollJobId: poll.id };
  } finally {
    payload.fill(0);
    signature.fill(0);
  }
}

export async function executeCrptReturnPoll(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const documentId = requiredUuid(context.job.payload.documentId, "documentId");
  const runtime = await createRuntime(dependencies);
  assertReturnRead(runtime.config, context.job.actor);
  const material = await getReturnDocumentMaterial(runtime.query, documentId, context.job.actor);
  assertContractVersion(material.contractVersion);
  if (material.status !== "processing") {
    return { documentId, status: material.status, reused: true };
  }
  if (!material.externalDocumentId) throw new Error("CRPT LP_RETURN document ID is missing");
  const remote = await runtime.client.getDocumentStatus(material.externalDocumentId, "lp");
  if ((remote.type && remote.type !== "LP_RETURN")
      || (remote.productGroup && remote.productGroup !== "lp")) {
    await manual(runtime, documentId, "crpt_document_type_mismatch",
      "ГИС МТ вернула другой тип документа вместо LP_RETURN", "poll");
    return { documentId, status: "requires_manual_review" };
  }
  const status = await recordReturnPoll(runtime.query, {
    documentId,
    remoteStatus: remote.status,
    response: { number: remote.number, type: remote.type,
      status: remote.status, productGroup: remote.productGroup },
    actorId: context.job.actor,
    errorCode: remote.errorCode ? stableErrorCode(remote.errorCode, "crpt_return_rejected") : null,
    errorMessage: remote.errorMessage,
  });
  if (status === "processing") {
    if (context.job.attemptCount >= context.job.maxAttempts) {
      await manual(runtime, documentId, "crpt_document_poll_exhausted",
        "ГИС МТ не завершила LP_RETURN в отведённое время", "poll");
      return { documentId, status: "requires_manual_review" };
    }
    throw new CrptApiError("crpt_document_processing", "LP_RETURN ещё обрабатывается", true);
  }
  return { documentId, status };
}

async function enqueueReturnPoll(context: JobExecutionContext, documentId: string) {
  return (await enqueueJob({
    type: "marking_crpt_document_poll",
    dedupeKey: `crpt-return-poll:${documentId}`,
    idempotencyKey: `crpt-return-poll:${documentId}`,
    payload: { documentId },
    actor: context.job.actor,
    requestId: context.job.requestId,
    maxAttempts: 20,
  })).job;
}

async function manual(
  runtime: Runtime,
  documentId: string,
  errorCode: string,
  errorMessage: string,
  phase: string,
) {
  return recordReturnManualReview(runtime.query, { documentId, errorCode, errorMessage, phase });
}

async function createRuntime(dependencies: Dependencies): Promise<Runtime> {
  if (Object.keys(dependencies).length > 0) return buildRuntime(dependencies);
  if (!runtimePromise) {
    runtimePromise = buildRuntime({ query: queryServerDatabase })
      .catch((error) => { runtimePromise = null; throw error; });
  }
  return runtimePromise;
}

async function buildRuntime(dependencies: Dependencies): Promise<Runtime> {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  const query = dependencies.query ?? queryServerDatabase;
  const keyring = dependencies.keyring ?? await loadMarkingKeyring(config.keyringFile);
  const signer = dependencies.signer ?? (config.signerTransport === "remote"
    ? createRemoteMarkingSignerClient({ query, keyring })
    : await loadMarkingSignerClient({
      socketPath: config.signerSocketPath,
      caller: config.signerClientId,
      secretFile: config.signerClientSecretFile,
    }));
  const tokens = dependencies.tokens ?? new CrptTokenManager({
    contour: config.crptContour,
    inn: config.crptInn || undefined,
    signer,
  });
  return { query, config, keyring, signer, tokens,
    client: dependencies.client ?? new CrptTrueApiClient({
      contour: config.crptContour,
      tokenManager: tokens,
    }) };
}

function assertReturnWrite(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.returnsEnabled || !config.crptReadEnabled
      || !config.crptWriteEnabled || !config.signerEnabled) {
    throw new Error("CRPT return write is disabled");
  }
  if (!config.allowedAdminIds.includes(actor)) throw new Error("CRPT return actor is denied");
}

function assertReturnRead(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.returnsEnabled || !config.crptReadEnabled
      || !config.signerEnabled) {
    throw new Error("CRPT return polling is disabled");
  }
  if (!config.allowedAdminIds.includes(actor)) throw new Error("CRPT return actor is denied");
}

function inCanaryScope(config: MarkingRuntimeConfig, gtin: string, offerId: string | null) {
  return config.allowedGtins.includes(gtin)
    && offerId !== null && config.allowedOffers.includes(offerId);
}

function requiredUuid(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function requiredInn(value: string) {
  if (!/^\d{10}(?:\d{2})?$/.test(value)) {
    throw new Error("CRPT participant INN is not configured");
  }
  return value;
}

function assertContractVersion(value: string) {
  if (value !== CRPT_RETURN_CONTRACT_VERSION) {
    throw new Error("CRPT LP_RETURN contract version is not supported");
  }
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error: unknown) {
  return { message: redactText(error instanceof Error
    ? error.message : "Результат отправки LP_RETURN неизвестен").slice(0, 1000) };
}

function stableErrorCode(value: string, fallback: string) {
  const normalized = value.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 120);
  return normalized.length >= 2 ? normalized : fallback;
}
