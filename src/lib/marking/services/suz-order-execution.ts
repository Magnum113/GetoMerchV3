import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { queryServerDatabase } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import { enqueueJob } from "@/lib/jobs/queue";
import { CrptTokenManager } from "@/lib/marking/adapters/crpt/client";
import { SuzApiClient, SuzApiError, SuzPendingError } from "@/lib/marking/adapters/suz/client";
import { buildSuzLpOrder, SUZ_CONTRACT_VERSION } from "@/lib/marking/adapters/suz/contracts";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { parseAndEncryptMarkingCodes } from "@/lib/marking/domain/code-pool";
import { applyCodeImport, createCodeImportPreview } from "@/lib/marking/repositories/code-pool";
import {
  attachSuzCodeBlock,
  confirmSuzUtilisation,
  getSuzOrderMaterial,
  recordSuzManualReview,
  recordSuzOrderStatus,
  recordSuzSubmitted,
  recordSuzSubmitStarted,
  type SuzOrderMaterial,
} from "@/lib/marking/repositories/suz-orders";
import { loadMarkingKeyring, type MarkingKeyring } from "@/lib/marking/security/keyring";
import { redactText } from "@/lib/marking/security/redaction";
import { loadMarkingSignerClient, type MarkingSignerClient } from "@/lib/marking/signer/client";
import { createRemoteMarkingSignerClient, RemoteSignerError } from "@/lib/marking/signer/remote-client";

type Runtime = {
  query: DatabaseQueryExecutor;
  config: MarkingRuntimeConfig;
  keyring: MarkingKeyring;
  signer: MarkingSignerClient;
  tokens: CrptTokenManager;
  client: SuzApiClient;
};
type Dependencies = Partial<Runtime>;
let runtimePromise: Promise<Runtime> | null = null;

export async function executeSuzOrderSubmit(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const orderId = requiredUuid(context.job.payload.orderId, "orderId");
  const runtime = await createRuntime(dependencies);
  assertSuzRuntime(runtime.config, context.job.actor);
  const material = await requiredMaterial(runtime.query, orderId);
  assertOrderScope(runtime.config, material);
  if (["submitted", "ready", "receiving", "awaiting_utilisation", "completed"].includes(material.orderStatus)) {
    const poll = material.orderStatus === "completed" ? null : await enqueuePoll(context, orderId);
    return { orderId, status: material.orderStatus, pollJobId: poll?.id ?? null, reused: true };
  }
  if (material.orderStatus === "submitting") {
    await recordSuzManualReview(runtime.query, {
      orderId,
      errorCode: "suz_submit_outcome_unknown",
      errorMessage: "Worker был прерван во время отправки заказа КМ",
      reason: "Сверьте заказ в СУЗ перед повторной отправкой",
    });
    return { orderId, status: "manual_review", ambiguous: true };
  }
  if (material.orderStatus !== "approved") {
    return { orderId, status: material.orderStatus, reused: true };
  }

  const built = buildSuzLpOrder({ gtin: material.gtin, quantity: material.requestedQuantity });
  let signatureBase64 = "";
  try {
    await context.report({ phase: "signing", orderId }, "suz_order_sign_started");
    const signed = await runtime.signer.sign(
      built.bytes,
      "crpt_suz_order_detached_cades_bes",
    );
    if (runtime.config.crptInn && signed.certificate.inn !== runtime.config.crptInn) {
      throw new Error("Signing certificate INN does not match the SUZ participant");
    }
    signatureBase64 = signed.signatureBase64;
    const signature = Buffer.from(signatureBase64, "base64");
    try {
      await recordSuzSubmitStarted(runtime.query, {
        orderId,
        requestHash: built.requestHash,
        signatureHash: sha256(signature),
        certificateThumbprint: signed.certificate.thumbprint,
        actorId: context.job.actor,
      });
    } finally {
      signature.fill(0);
    }
    await context.report({ phase: "submitting", orderId }, "suz_order_submit_started");
    let created;
    try {
      created = await runtime.client.createOrder(built.bytes, signatureBase64);
    } catch (error) {
      const safe = safeError(error, "suz_submit_outcome_unknown");
      await recordSuzManualReview(runtime.query, {
        orderId,
        errorCode: "suz_submit_outcome_unknown",
        errorMessage: safe.message,
        reason: "Результат создания заказа КМ неизвестен; нужна сверка в СУЗ",
      });
      return { orderId, status: "manual_review", ambiguous: true };
    }
    if (created.omsId !== runtime.config.suzOmsId) {
      await recordSuzManualReview(runtime.query, {
        orderId,
        errorCode: "suz_oms_mismatch",
        errorMessage: "СУЗ вернула другой OMS ID",
        reason: "Ответ не соответствует настроенному устройству СУЗ",
      });
      return { orderId, status: "manual_review" };
    }
    await recordSuzSubmitted(runtime.query, {
      orderId,
      omsId: created.omsId,
      externalOrderId: created.orderId,
      expectedCompletionTimeMs: created.expectedCompletionTimeMs,
      responseRedacted: {
        omsIdMatched: true,
        externalOrderId: created.orderId,
        expectedCompletionTimeMs: created.expectedCompletionTimeMs,
      },
    });
    const poll = await enqueuePoll(context, orderId);
    return { orderId, status: "submitted", externalOrderId: created.orderId, pollJobId: poll.id };
  } finally {
    signatureBase64 = "";
    built.bytes.fill(0);
  }
}

export async function executeSuzOrderPoll(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const orderId = requiredUuid(context.job.payload.orderId, "orderId");
  const runtime = await createRuntime(dependencies);
  assertSuzRuntime(runtime.config, context.job.actor);
  let material = await requiredMaterial(runtime.query, orderId);
  assertOrderScope(runtime.config, material);
  if (["completed", "rejected", "manual_review", "cancelled"].includes(material.orderStatus)) {
    return { orderId, status: material.orderStatus, reused: true };
  }
  const externalOrderId = material.externalOrderId;
  if (!externalOrderId) {
    throw new Error("SUZ external order ID is missing");
  }

  if (["submitted", "ready"].includes(material.orderStatus)) {
    await context.report({ phase: "order_status", orderId }, "suz_order_status_check_started");
    const remote = await runtime.client.getOrderStatus(externalOrderId, material.gtin);
    if (remote.orderId !== externalOrderId
        || remote.productGroup !== "lp" || remote.templateId !== 10) {
      await recordSuzManualReview(runtime.query, {
        orderId,
        errorCode: "suz_order_contract_mismatch",
        errorMessage: "Ответ статуса СУЗ не соответствует локальному заказу",
        reason: "Остановлена автоматическая выдача кодов",
      });
      return { orderId, status: "manual_review" };
    }
    const status = await recordSuzOrderStatus(runtime.query, {
      orderId,
      remoteOrderStatus: remote.orderStatus,
      remoteBufferStatus: remote.bufferStatus,
      remoteAvailableCodes: remote.availableCodes,
      responseRedacted: {
        orderStatus: remote.orderStatus,
        bufferStatus: remote.bufferStatus,
        availableCodes: remote.availableCodes,
        templateId: remote.templateId,
      },
    });
    if (status === "rejected") return { orderId, status };
    if (status !== "ready") throw new SuzPendingError("Заказ КМ ещё формируется в СУЗ");
    material = await requiredMaterial(runtime.query, orderId);
  }

  if (["ready", "receiving"].includes(material.orderStatus)) {
    material = await recoverKnownBlocks(context, runtime, material);
    if (material.orderStatus === "manual_review") {
      return { orderId, status: "manual_review" };
    }
    if (material.receivedQuantity < material.requestedQuantity) {
      const remaining = material.requestedQuantity - material.receivedQuantity;
      let issued;
      try {
        await context.report({ phase: "codes", orderId, remaining }, "suz_code_block_request_started");
        issued = await runtime.client.getCodes(externalOrderId, material.gtin, remaining);
      } catch (error) {
        if (error instanceof SuzApiError && error.outcomeUnknown) {
          await recordSuzManualReview(runtime.query, {
            orderId,
            errorCode: "suz_code_issue_outcome_unknown",
            errorMessage: safeError(error, "suz_code_issue_outcome_unknown").message,
            reason: "Неизвестно, выдал ли СУЗ новый блок; используйте сверку блоков",
          });
          return { orderId, status: "manual_review", ambiguous: true };
        }
        throw error;
      }
      if (issued.omsId !== runtime.config.suzOmsId) {
        await recordSuzManualReview(runtime.query, {
          orderId,
          errorCode: "suz_oms_mismatch",
          errorMessage: "Блок кодов получен от другого OMS ID",
          reason: "Полученный блок не импортирован",
        });
        return { orderId, status: "manual_review" };
      }
      await ingestBlock(context, runtime, material, issued.blockId, issued.codes);
      material = await requiredMaterial(runtime.query, orderId);
      if (material.orderStatus === "manual_review") {
        return { orderId, status: "manual_review" };
      }
    }
    if (material.receivedQuantity < material.requestedQuantity) {
      throw new SuzPendingError("СУЗ выдала только часть заказанных кодов");
    }
  }

  if (material.orderStatus !== "awaiting_utilisation") {
    material = await requiredMaterial(runtime.query, orderId);
  }
  if (material.orderStatus !== "awaiting_utilisation") {
    throw new SuzPendingError("Получение заказа КМ ещё не завершено");
  }
  await context.report({ phase: "utilisation", orderId }, "suz_utilisation_receipt_check_started");
  const receipt = await runtime.client.findUtilisationReceipt(externalOrderId, material.gtin);
  if (!receipt) throw new SuzPendingError("Отчёт REPORT_UTILIZE ещё не сформирован СУЗ");
  const confirmed = await confirmSuzUtilisation(runtime.query, {
    orderId,
    receiptId: receipt.receiptId,
    state: receipt.state,
    code: receipt.code,
    processed: receipt.processed,
    total: receipt.total,
    responseRedacted: {
      receiptId: receipt.receiptId,
      workflow: receipt.workflow,
      state: receipt.state,
      code: receipt.code,
      processed: receipt.processed,
      total: receipt.total,
    },
  });
  return { orderId, status: confirmed.status, released: confirmed.released };
}

async function recoverKnownBlocks(
  context: JobExecutionContext,
  runtime: Runtime,
  material: SuzOrderMaterial,
) {
  if (!material.externalOrderId) return material;
  const blockList = await runtime.client.listCodeBlocks(material.externalOrderId, material.gtin);
  for (const block of blockList.blocks) {
    if (material.blockIds.includes(block.blockId)) continue;
    await context.report({ phase: "block_recovery", orderId: material.orderId }, "suz_code_block_recovery_started");
    const recovered = await runtime.client.getCodesByBlock(block.blockId, block.quantity);
    if (recovered.omsId !== runtime.config.suzOmsId || recovered.blockId !== block.blockId) {
      await recordSuzManualReview(runtime.query, {
        orderId: material.orderId,
        errorCode: "suz_block_recovery_mismatch",
        errorMessage: "Повторно полученный блок не совпал со списком блоков СУЗ",
        reason: "Блок не импортирован",
      });
      return requiredMaterial(runtime.query, material.orderId);
    }
    await ingestBlock(context, runtime, material, recovered.blockId, recovered.codes);
    material = await requiredMaterial(runtime.query, material.orderId);
  }
  return material;
}

async function ingestBlock(
  context: JobExecutionContext,
  runtime: Runtime,
  material: SuzOrderMaterial,
  blockId: string,
  codes: string[],
) {
  let parsed;
  try {
    parsed = parseAndEncryptMarkingCodes({
      codes,
      expectedGtin: material.gtin,
      keyring: runtime.keyring,
    });
  } finally {
    codes.fill("");
  }
  return withServerDatabaseTransaction(async (query) => {
    const batchId = await createCodeImportPreview(query, {
      source: "suz_api",
      filename: null,
      contentType: "application/json",
      fileSha256: parsed.fileSha256,
      fileSizeBytes: parsed.fileSizeBytes,
      expectedGtin: material.gtin,
      acquisitionMode: "own_suz_emission",
      rows: parsed.rows,
      actorId: context.job.actor,
    });
    const summary = await applyCodeImport(query, batchId, context.job.actor);
    const received = numberSummary(summary, "total");
    const applied = numberSummary(summary, "applied");
    const duplicate = numberSummary(summary, "duplicate");
    const rejected = numberSummary(summary, "rejected");
    const attached = await attachSuzCodeBlock(query, {
      orderItemId: material.orderItemId,
      importBatchId: batchId,
      blockId,
      received,
      applied,
      duplicate,
      rejected,
      actorId: context.job.actor,
    });
    await context.report({ phase: "codes_ingested", orderId: material.orderId,
      received: attached.received, ingested: attached.ingested }, "suz_code_block_ingested");
    return attached;
  });
}

export function isRetryableSuzError(error: unknown) {
  if (error instanceof SuzPendingError) return true;
  if (error instanceof SuzApiError) return error.retryable && !error.outcomeUnknown;
  if (error instanceof RemoteSignerError) return error.retryable;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "") : "";
  return ["signer_unavailable", "signer_timeout", "signer_remote_pending"].includes(code);
}

async function enqueuePoll(context: JobExecutionContext, orderId: string) {
  return (await enqueueJob({
    type: "marking_suz_order_poll",
    dedupeKey: `suz-poll:${orderId}`,
    idempotencyKey: `suz-poll:${orderId}`,
    payload: { orderId }, actor: context.job.actor,
    requestId: context.job.requestId, maxAttempts: 10,
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
    ? createRemoteMarkingSignerClient({ query, keyring, requestedBy: "marking-suz-worker" })
    : await loadMarkingSignerClient({
      socketPath: config.signerSocketPath,
      caller: config.signerClientId,
      secretFile: config.signerClientSecretFile,
    }));
  const tokens = dependencies.tokens ?? new CrptTokenManager({
    contour: config.crptContour,
    inn: config.crptInn || undefined,
    omsConnection: config.suzOmsConnection,
    signer,
  });
  return {
    query,
    config,
    keyring,
    signer,
    tokens,
    client: dependencies.client ?? new SuzApiClient({
      contour: config.crptContour,
      omsId: config.suzOmsId,
      tokenManager: tokens,
    }),
  };
}

function assertSuzRuntime(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.importEnabled || !config.suzWriteEnabled
      || !config.signerEnabled || !config.suzOmsId || !config.suzOmsConnection) {
    throw new Error("SUZ code ordering is disabled");
  }
  if (!config.allowedAdminIds.includes(actor)) throw new Error("SUZ order actor is denied");
}

function assertOrderScope(config: MarkingRuntimeConfig, material: SuzOrderMaterial) {
  if (material.contour !== config.crptContour || !config.allowedGtins.includes(material.gtin)) {
    throw new Error("SUZ order is outside the configured contour");
  }
}

async function requiredMaterial(query: DatabaseQueryExecutor, orderId: string) {
  const material = await getSuzOrderMaterial(query, orderId);
  if (!material) throw new Error("SUZ order not found");
  return material;
}

function requiredUuid(value: unknown, name: string) {
  if (typeof value !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function numberSummary(summary: Record<string, unknown>, key: string) {
  const value = Number(summary[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid secure import summary");
  return value;
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message : fallback;
  return { message: redactText(raw).replace(/[\u0000\r\n]/g, " ").slice(0, 1000) };
}

export { SUZ_CONTRACT_VERSION };
