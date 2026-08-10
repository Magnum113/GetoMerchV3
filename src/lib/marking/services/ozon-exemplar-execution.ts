import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { queryServerDatabase } from "@/lib/db/pool";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  OzonExemplarAdapter,
  OzonExemplarContractError,
  type OzonExemplarProductInput,
} from "@/lib/marking/adapters/ozon/exemplars";
import {
  getMarkingRuntimeConfig,
  type MarkingRuntimeConfig,
} from "@/lib/marking/config";
import {
  getOzonSubmissionBatch,
  getOzonSubmissionMaterial,
  listOzonSubmissionUnits,
  recordOzonBatchFailure,
  recordOzonExemplarMapping,
  recordOzonPoll,
  recordOzonSetQueuedForPoll,
  recordOzonValidation,
  type OzonSubmissionMaterial,
  type OzonSubmissionUnit,
} from "@/lib/marking/repositories/ozon-exemplars";
import {
  loadMarkingKeyring,
  type MarkingKeyring,
} from "@/lib/marking/security/keyring";
import { redactText } from "@/lib/marking/security/redaction";
import {
  assertOzonOperator,
  assertOzonUnitAccess,
} from "@/lib/marking/services/ozon-exemplar-service";
import { OzonApiError } from "@/lib/ozon/client";

type ExecutionDependencies = {
  query?: DatabaseQueryExecutor;
  config?: MarkingRuntimeConfig;
  keyring?: MarkingKeyring;
  adapter?: OzonExemplarAdapter;
};

export async function executeOzonExemplarValidation(
  context: JobExecutionContext,
  dependencies: ExecutionDependencies = {},
) {
  const batchId = batchIdFromPayload(context.job.payload);
  const runtime = await createExecutionRuntime(context, batchId, dependencies);
  try {
    await context.report({ phase: "create_or_get", batchId }, "ozon_exemplars_create_or_get");
    const created = await runtime.adapter.createOrGetExemplars(
      runtime.batch.postingNumber,
      context.signal,
    );
    if (created.postingNumber !== runtime.batch.postingNumber) {
      throw new OzonExemplarContractError("Ozon returned a different posting number");
    }
    const mapping = mapCreatedExemplars(runtime.units, created.products);
    await recordOzonExemplarMapping(runtime.query, {
      batchId,
      mapping,
      multiBoxQuantity: created.multiBoxQuantity,
      responseRedacted: {
        operation: "create_or_get",
        multiBoxQuantity: created.multiBoxQuantity,
        products: created.products.map((product) => ({
          productId: product.productId,
          quantity: product.quantity,
          exemplarCount: product.exemplarIds.length,
          mandatoryMarkNeeded: product.mandatoryMarkNeeded,
          mandatoryMarkPossible: product.mandatoryMarkPossible,
        })),
      },
      actorId: context.job.actor,
    });

    const materials = await loadMaterials(runtime, batchId, "validate", context.job.actor);
    try {
      const products = buildProducts(materials);
      await context.report({ phase: "validate", batchId }, "ozon_exemplars_validation_started");
      const validation = await runtime.adapter.validateExemplars(
        runtime.batch.postingNumber,
        products,
        context.signal,
      );
      const results = mapValidation(materials, validation);
      const status = await recordOzonValidation(runtime.query, {
        batchId,
        results,
        responseRedacted: {
          operation: "validate",
          products: validation.map((product) => ({
            productId: product.productId,
            valid: product.valid,
            error: product.error ? redactText(product.error) : null,
            exemplars: product.exemplars.map((exemplar) => ({
              valid: exemplar.valid,
              errorCodes: exemplar.errorCodes.map(redactText),
            })),
          })),
        },
      });
      return { batchId, status, unitCount: materials.length };
    } finally {
      clearMaterials(materials);
    }
  } catch (error) {
    if (error instanceof OzonExemplarContractError) {
      const status = await recordOzonBatchFailure(runtime.query, {
        batchId,
        phase: "validate",
        errorCode: error.code,
        errorMessage: redactText(error.message),
      });
      return { batchId, status, contractError: true };
    }
    if (["MZ821", "MZ822", "MZ823"].includes(nestedErrorCode(error))) {
      const status = await recordOzonBatchFailure(runtime.query, {
        batchId,
        phase: "validate",
        errorCode: nestedErrorCode(error),
        errorMessage: "Posting или назначение изменились перед проверкой Ozon",
      });
      return { batchId, status, stateConflict: true };
    }
    throw error;
  }
}

export async function executeOzonExemplarSubmit(
  context: JobExecutionContext,
  dependencies: ExecutionDependencies = {},
) {
  const batchId = batchIdFromPayload(context.job.payload);
  const runtime = await createExecutionRuntime(context, batchId, dependencies);
  try {
    if (runtime.batch.status === "accepted") {
      return { batchId, status: "accepted", reused: true };
    }
    if (runtime.batch.status === "polling") {
      if (runtime.batch.operationKind === "correction") {
        await runtime.adapter.updateExemplars(runtime.batch.postingNumber, context.signal);
      }
      const pollJob = await enqueuePoll(context, runtime.batch.id);
      return { batchId, status: "polling", pollJobId: pollJob.id, reused: true };
    }
    if (runtime.batch.status === "submitting") {
      const probe = await runtime.adapter.getExemplarStatus(
        runtime.batch.postingNumber,
        context.signal,
      );
      await recordOzonSetQueuedForPoll(runtime.query, {
        batchId,
        requestHash: runtime.batch.requestHash,
        responseRedacted: { operation: "set_recovery_probe", status: probe.status },
      });
      const status = await recordStatus(runtime.query, batchId, probe);
      if (status === "polling") {
        const pollJob = await enqueuePoll(context, batchId);
        return { batchId, status, pollJobId: pollJob.id, recovered: true };
      }
      return { batchId, status, recovered: true };
    }

    const materials = await loadMaterials(runtime, batchId, "set", context.job.actor);
    try {
      const products = buildProducts(materials);
      const requestHash = hashSubmission(runtime.batch.postingNumber, products);
      await context.report({ phase: "set", batchId }, "ozon_exemplars_set_started");
      await runtime.adapter.setExemplars(
        runtime.batch.postingNumber,
        products,
        runtime.batch.multiBoxQuantity,
        context.signal,
      );
      await recordOzonSetQueuedForPoll(runtime.query, {
        batchId,
        requestHash,
        responseRedacted: { operation: "set", httpAccepted: true },
      });
      if (runtime.batch.operationKind === "correction") {
        await runtime.adapter.updateExemplars(runtime.batch.postingNumber, context.signal);
      }
      const pollJob = await enqueuePoll(context, batchId);
      return { batchId, status: "polling", pollJobId: pollJob.id };
    } finally {
      clearMaterials(materials);
    }
  } catch (error) {
    if (error instanceof OzonExemplarContractError) {
      const status = await recordOzonBatchFailure(runtime.query, {
        batchId,
        phase: "set",
        errorCode: error.code,
        errorMessage: redactText(error.message),
      });
      return { batchId, status, contractError: true };
    }
    if (["MZ821", "MZ822", "MZ823"].includes(nestedErrorCode(error))) {
      const status = await recordOzonBatchFailure(runtime.query, {
        batchId,
        phase: "set",
        errorCode: nestedErrorCode(error),
        errorMessage: "Posting или назначение изменились перед передачей в Ozon",
      });
      return { batchId, status, stateConflict: true };
    }
    throw error;
  }
}

export async function executeOzonExemplarPoll(
  context: JobExecutionContext,
  dependencies: ExecutionDependencies = {},
) {
  const batchId = batchIdFromPayload(context.job.payload);
  const runtime = await createExecutionRuntime(context, batchId, dependencies);
  if (["accepted", "rejected", "partially_rejected", "manual_review"].includes(runtime.batch.status)) {
    return { batchId, status: runtime.batch.status, reused: true };
  }
  try {
    const response = await runtime.adapter.getExemplarStatus(
      runtime.batch.postingNumber,
      context.signal,
    );
    if (response.postingNumber !== runtime.batch.postingNumber) {
      throw new OzonExemplarContractError("Ozon returned a different posting number");
    }
    if (
      response.status === "validation_in_process"
      && context.job.attemptCount >= context.job.maxAttempts
    ) {
      const status = await recordOzonPoll(runtime.query, {
        batchId,
        remoteStatus: "timeout",
        results: [],
        responseRedacted: {
          operation: "status",
          remoteStatus: response.status,
          timeoutAfterAttempts: context.job.attemptCount,
        },
      });
      return { batchId, status };
    }
    const status = await recordStatus(runtime.query, batchId, response);
    if (status === "polling") {
      throw new OzonApiError("Ozon exemplar validation is still in progress", {
        retryable: true,
        code: "ozon_exemplar_pending",
      });
    }
    return { batchId, status };
  } catch (error) {
    if (error instanceof OzonExemplarContractError) {
      const status = await recordOzonBatchFailure(runtime.query, {
        batchId,
        phase: "poll",
        errorCode: error.code,
        errorMessage: redactText(error.message),
      });
      return { batchId, status, contractError: true };
    }
    throw error;
  }
}

async function createExecutionRuntime(
  context: JobExecutionContext,
  batchId: string,
  dependencies: ExecutionDependencies,
) {
  const query = dependencies.query ?? queryServerDatabase;
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertOzonOperator(config, context.job.actor);
  const batch = await getOzonSubmissionBatch(query, batchId);
  if (!batch) throw new OzonExemplarContractError("Ozon submission batch not found");
  const units = await listOzonSubmissionUnits(query, batchId);
  assertOzonUnitAccess(config, units);
  return {
    query,
    config,
    batch,
    units,
    adapter: dependencies.adapter ?? new OzonExemplarAdapter(),
    keyring: dependencies.keyring ?? await loadMarkingKeyring(config.keyringFile),
  };
}

async function loadMaterials(
  runtime: Awaited<ReturnType<typeof createExecutionRuntime>>,
  batchId: string,
  operation: "validate" | "set",
  actorId: string,
) {
  const rows = await getOzonSubmissionMaterial(runtime.query, {
    batchId,
    operation,
    actorId,
  });
  const output: Array<OzonSubmissionMaterial & { markingCode: Buffer }> = [];
  try {
    for (const row of rows) {
      const markingCode = runtime.keyring.decryptBytes({
        algorithm: "aes-256-gcm",
        keyVersion: row.encryptionKeyVersion,
        ciphertext: row.codeCiphertext.toString("base64"),
        iv: row.codeNonce.toString("base64"),
        authTag: row.codeAuthTag.toString("base64"),
      });
      output.push({ ...row, markingCode });
    }
    return output;
  } catch (error) {
    clearMaterials(output);
    throw error;
  } finally {
    for (const row of rows) {
      row.codeCiphertext.fill(0);
      row.codeNonce.fill(0);
      row.codeAuthTag.fill(0);
    }
  }
}

function buildProducts(
  materials: Array<OzonSubmissionMaterial & { markingCode: Buffer }>,
): OzonExemplarProductInput[] {
  const grouped = new Map<number, OzonExemplarProductInput>();
  for (const material of materials) {
    const product = grouped.get(material.productId) ?? {
      productId: material.productId,
      exemplars: [],
    };
    product.exemplars.push({
      assignmentId: material.assignmentId,
      exemplarId: material.exemplarId,
      markingCode: material.markingCode,
    });
    grouped.set(material.productId, product);
  }
  return [...grouped.values()].sort((left, right) => left.productId - right.productId);
}

function mapCreatedExemplars(
  units: OzonSubmissionUnit[],
  products: Array<{
    productId: number;
    quantity: number;
    mandatoryMarkNeeded: boolean;
    mandatoryMarkPossible: boolean;
    exemplarIds: number[];
  }>,
) {
  const responseByProduct = new Map(products.map((product) => [product.productId, product]));
  if (responseByProduct.size !== products.length) {
    throw new OzonExemplarContractError("Ozon returned duplicate product IDs");
  }
  const grouped = groupUnits(units);
  for (const product of products) {
    if (product.mandatoryMarkNeeded && !grouped.has(product.productId)) {
      throw new OzonExemplarContractError(
        `Ozon returned an unexpected mandatory-mark product ${product.productId}`,
      );
    }
  }
  const mapping: Array<{ assignmentId: string; exemplarId: number }> = [];
  for (const [productId, expected] of grouped) {
    const actual = responseByProduct.get(productId);
    if (
      !actual
      || !actual.mandatoryMarkNeeded
      || !actual.mandatoryMarkPossible
      || actual.quantity !== expected.length
      || actual.exemplarIds.length !== expected.length
    ) {
      throw new OzonExemplarContractError(
        `Ozon exemplar quantity or requirement mismatch for product ${productId}`,
      );
    }
    expected.forEach((unit, index) => {
      mapping.push({ assignmentId: unit.assignmentId, exemplarId: actual.exemplarIds[index] });
    });
  }
  if (mapping.length !== units.length) {
    throw new OzonExemplarContractError("Ozon exemplar mapping is incomplete");
  }
  return mapping;
}

function mapValidation(
  materials: OzonSubmissionMaterial[],
  products: Array<{
    productId: number;
    valid: boolean;
    error: string | null;
    exemplars: Array<{ valid: boolean; errorCodes: string[] }>;
  }>,
) {
  const responseByProduct = new Map(products.map((product) => [product.productId, product]));
  if (responseByProduct.size !== products.length) {
    throw new OzonExemplarContractError("Ozon returned duplicate validation products");
  }
  const grouped = groupUnits(materials);
  if (
    responseByProduct.size !== grouped.size
    || [...responseByProduct.keys()].some((productId) => !grouped.has(productId))
  ) {
    throw new OzonExemplarContractError("Ozon validation product set mismatch");
  }
  const results: Array<{
    assignmentId: string;
    valid: boolean;
    errorCodes: string[];
    errorMessage: string | null;
  }> = [];
  for (const [productId, expected] of grouped) {
    const actual = responseByProduct.get(productId);
    if (!actual || actual.exemplars.length !== expected.length) {
      throw new OzonExemplarContractError(
        `Ozon validation quantity mismatch for product ${productId}`,
      );
    }
    expected.forEach((unit, index) => {
      const exemplar = actual.exemplars[index];
      results.push({
        assignmentId: unit.assignmentId,
        valid: actual.valid && exemplar.valid,
        errorCodes: exemplar.errorCodes.map(redactText),
        errorMessage: actual.error ? redactText(actual.error) : null,
      });
    });
  }
  if (results.length !== materials.length) {
    throw new OzonExemplarContractError("Ozon validation mapping is incomplete");
  }
  return results;
}

function groupUnits<T extends { productId: number; unitOrdinal: number; assignmentId: string }>(units: T[]) {
  const grouped = new Map<number, T[]>();
  for (const unit of units) {
    const product = grouped.get(unit.productId) ?? [];
    product.push(unit);
    grouped.set(unit.productId, product);
  }
  for (const product of grouped.values()) {
    product.sort((left, right) => left.unitOrdinal - right.unitOrdinal
      || left.assignmentId.localeCompare(right.assignmentId));
  }
  return grouped;
}

async function recordStatus(
  query: DatabaseQueryExecutor,
  batchId: string,
  response: Awaited<ReturnType<OzonExemplarAdapter["getExemplarStatus"]>>,
) {
  const results = response.products.flatMap((product) => product.exemplars.map((exemplar) => ({
    exemplarId: exemplar.exemplarId,
    errorCodes: exemplar.errorCodes.map(redactText),
    errorMessage: exemplar.errorCodes.length > 0 ? "Ozon отклонил exemplar" : null,
  })));
  return recordOzonPoll(query, {
    batchId,
    remoteStatus: response.status,
    results,
    responseRedacted: {
      operation: "status",
      remoteStatus: response.status,
      products: response.products.map((product) => ({
        productId: product.productId,
        exemplars: product.exemplars.map((exemplar) => ({
          exemplarId: exemplar.exemplarId,
          errorCodes: exemplar.errorCodes.map(redactText),
        })),
      })),
    },
  });
}

async function enqueuePoll(context: JobExecutionContext, batchId: string) {
  const queued = await enqueueJob({
    type: "marking_ozon_poll",
    dedupeKey: `marking-ozon:${batchId}:poll`,
    idempotencyKey: `marking-ozon-poll:${batchId}`,
    payload: { batchId },
    actor: context.job.actor,
    requestId: context.job.requestId,
    maxAttempts: 10,
  }, { scope: "marking" });
  return queued.job;
}

function hashSubmission(postingNumber: string, products: OzonExemplarProductInput[]) {
  const hash = createHash("sha256").update(postingNumber);
  for (const product of products) {
    hash.update(`:${product.productId}`);
    for (const exemplar of product.exemplars) {
      hash.update(`:${exemplar.assignmentId}:${exemplar.exemplarId ?? ""}:`);
      hash.update(markingPayload(exemplar.markingCode));
    }
  }
  return hash.digest("hex");
}

function markingPayload(code: Buffer) {
  return code.subarray(0, 3).equals(Buffer.from("]d2", "ascii"))
    ? code.subarray(3)
    : code;
}

function nestedErrorCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return "ozon_submission_state_conflict";
}

function clearMaterials(
  materials: Array<Partial<OzonSubmissionMaterial> & { markingCode?: Buffer }>,
) {
  for (const material of materials) {
    material.markingCode?.fill(0);
    material.codeCiphertext?.fill(0);
    material.codeNonce?.fill(0);
    material.codeAuthTag?.fill(0);
  }
}

function batchIdFromPayload(payload: Record<string, unknown>) {
  const value = payload.batchId;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new OzonExemplarContractError("Invalid Ozon batch job payload");
  }
  if (Object.keys(payload).some((key) => key !== "batchId")) {
    throw new OzonExemplarContractError("Unexpected Ozon batch job payload field");
  }
  return value;
}
