import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { applyInventoryDeltas, insertMovement } from "@/lib/db/mutations/inventory";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import { enqueueJob } from "@/lib/jobs/queue";
import type { BackgroundJob } from "@/lib/jobs/types";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  confirmReturnDirection,
  confirmReturnFboTransfer,
  getReturnCaseAccess,
  lockSellerReceiptContext,
  prepareReturnDocument,
  recordSellerReturnReceipt,
} from "@/lib/marking/repositories/returns";

type Dependencies = { config?: MarkingRuntimeConfig };

export async function requestOzonReturnsSync(
  context: ServerMutationContext,
  dependencies: Dependencies = {},
) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertReturnOperator(config, context.actor, true);
  return runServerMutation({
    operation: "marking.returns.sync",
    payload: { contract: "ozon-v3-fbs-returns" },
    context,
    execute: async (query, checkpoint) => {
      const queued = await enqueueJob({
        type: "marking_returns_sync",
        dedupeKey: "marking-returns-sync:ozon-fbs",
        idempotencyKey: `marking-returns-sync:${digest(context.idempotencyKey)}`,
        payload: {},
        actor: context.actor,
        requestId: context.requestId,
        maxAttempts: 4,
      }, { query, scope: "marking" });
      checkpoint("returns_sync_enqueued");
      return {
        data: { job: queued.job, reused: queued.reused },
        audit: {
          entityType: "marking_return_sync",
          entityId: queued.job.id,
          after: { jobId: queued.job.id, reused: queued.reused },
        },
      };
    },
  });
}

export async function setReturnDirection(
  input: {
    returnCaseId: string;
    expectedVersion: number;
    destination: "to_seller" | "to_ozon_fbo";
    paid: boolean;
  },
  context: ServerMutationContext,
  dependencies: Dependencies = {},
) {
  validateCaseInput(input.returnCaseId, input.expectedVersion);
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  return runServerMutation({
    operation: "marking.return.direction",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      await assertCaseAccess(query, config, context.actor, input.returnCaseId);
      const result = await confirmReturnDirection(query, {
        ...input,
        actorId: context.actor,
        requestId: context.requestId,
      });
      checkpoint("return_direction_confirmed");
      return {
        data: { id: result.return_case_id, version: Number(result.case_version),
          processStatus: result.process_status, destination: result.destination },
        audit: { entityType: "marking_return_case", entityId: input.returnCaseId,
          before: { version: input.expectedVersion }, after: result },
      };
    },
  });
}

export async function requestReturnToCirculation(
  input: { returnCaseId: string; forceCorrection?: boolean },
  context: ServerMutationContext,
  dependencies: Dependencies = {},
) {
  assertUuid(input.returnCaseId);
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  return runServerMutation<{
    documentId: string | null;
    status: string;
    revision: number;
    reused: boolean;
    noOp: boolean;
    job: BackgroundJob | null;
  }>({
    operation: input.forceCorrection
      ? "marking.return.retry"
      : "marking.return.prepare",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      await assertCaseAccess(query, config, context.actor, input.returnCaseId);
      const prepared = await prepareReturnDocument(query, {
        returnCaseId: input.returnCaseId,
        actorId: context.actor,
        requestId: context.requestId,
        forceCorrection: input.forceCorrection,
      });
      checkpoint("return_document_prepared");
      if (prepared.noOp || !prepared.documentId || prepared.status === "accepted") {
        return {
          data: { ...prepared, job: null },
          audit: { entityType: "marking_return_case", entityId: input.returnCaseId,
            after: { ...prepared, crptMutation: false } },
        };
      }
      const queued = await enqueueJob({
        type: "marking_return_to_circulation_submit",
        dedupeKey: `marking-return-submit:${prepared.documentId}`,
        idempotencyKey: `marking-return-submit:${digest(
          `${context.idempotencyKey}:${prepared.documentId}`,
        )}`,
        payload: { documentId: prepared.documentId },
        actor: context.actor,
        requestId: context.requestId,
        maxAttempts: 4,
      }, { query, scope: "marking" });
      checkpoint("return_submit_enqueued");
      return {
        data: { ...prepared, job: queued.job },
        audit: { entityType: "marking_return_case", entityId: input.returnCaseId,
          after: { ...prepared, jobId: queued.job.id } },
      };
    },
  });
}

export async function receiveSellerReturn(
  input: {
    returnCaseId: string;
    expectedVersion: number;
    condition: "intact" | "relabel_same_code" | "remark_required" | "destroy_pending";
    warehouseId: string;
  },
  context: ServerMutationContext,
  dependencies: Dependencies = {},
) {
  validateCaseInput(input.returnCaseId, input.expectedVersion);
  assertUuid(input.warehouseId);
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  return runServerMutation({
    operation: "marking.return.receive_seller",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      await assertCaseAccess(query, config, context.actor, input.returnCaseId);
      const receipt = await lockSellerReceiptContext(query, input.returnCaseId);
      if (!receipt) throw new MarkingDomainError("return_not_found", "Возврат не найден");
      if (Number(receipt.version) !== input.expectedVersion) {
        throw new MarkingDomainError("return_revision_conflict", "Возврат уже изменён. Обновите страницу");
      }
      if (receipt.seller_received_at) {
        throw new MarkingDomainError("return_not_ready", "Возврат уже был принят");
      }
      let inventoryTransactionId: string | null = null;
      let inventoryChanges: unknown[] = [];
      if (input.condition === "intact") {
        inventoryChanges = await applyInventoryDeltas(query, [{
          productId: receipt.product_id_snapshot,
          warehouseId: input.warehouseId,
          delta: 1,
        }]);
        checkpoint("return_inventory_incremented");
        inventoryTransactionId = await insertMovement(query, {
          type: "receive",
          productId: receipt.product_id_snapshot,
          toWarehouseId: input.warehouseId,
          quantity: 1,
          notes: `Marked Ozon return ${input.returnCaseId}`,
        });
        checkpoint("return_inventory_movement_created");
      }
      const result = await recordSellerReturnReceipt(query, {
        ...input,
        inventoryTransactionId,
        actorId: context.actor,
        requestId: context.requestId,
      });
      checkpoint("seller_return_received");
      return {
        data: result,
        audit: { entityType: "marking_return_case", entityId: input.returnCaseId,
          before: { version: input.expectedVersion, stockReceived: false },
          after: { ...result, inventoryTransactionId, inventoryChanges } },
      };
    },
  });
}

export async function confirmFboReturnTransfer(
  input: {
    returnCaseId: string;
    expectedVersion: number;
    fboIntakeReference: string;
    edoDocumentReference: string;
  },
  context: ServerMutationContext,
  dependencies: Dependencies = {},
) {
  validateCaseInput(input.returnCaseId, input.expectedVersion);
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  return runServerMutation({
    operation: "marking.return.confirm_fbo",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      await assertCaseAccess(query, config, context.actor, input.returnCaseId);
      const result = await confirmReturnFboTransfer(query, {
        ...input,
        fboIntakeReference: bounded(input.fboIntakeReference, "Ссылка на приёмку FBO"),
        edoDocumentReference: bounded(input.edoDocumentReference, "Ссылка на ЭДО"),
        actorId: context.actor,
        requestId: context.requestId,
      });
      checkpoint("fbo_return_transfer_confirmed");
      return {
        data: result,
        audit: { entityType: "marking_return_case", entityId: input.returnCaseId,
          before: { version: input.expectedVersion, custody: "ozon" },
          after: { ...result, custody: "ozon_fbo", stockReceived: false } },
      };
    },
  });
}

async function assertCaseAccess(
  query: DatabaseQueryExecutor,
  config: MarkingRuntimeConfig,
  actor: string,
  returnCaseId: string,
) {
  assertReturnOperator(config, actor, false);
  const access = await getReturnCaseAccess(query, returnCaseId);
  if (!access) throw new MarkingDomainError("return_not_found", "Возврат не найден");
  if (!access.gtin || !config.allowedGtins.includes(access.gtin)
      || !access.offer_id || !config.allowedOffers.includes(access.offer_id)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Возврат не входит в разрешённый контур маркировки",
    );
  }
  return access;
}

function assertReturnOperator(
  config: MarkingRuntimeConfig,
  actor: string,
  requireSync: boolean,
) {
  if (!config.enabled || !config.returnsEnabled
      || (requireSync && !config.ozonReturnsSyncEnabled)) {
    throw new MarkingDomainError("crpt_write_disabled", "Работа с возвратами отключена");
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new MarkingDomainError("assignment_access_denied", "Оператор не включён в контур возвратов");
  }
}

function validateCaseInput(id: string, version: number) {
  assertUuid(id);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new MarkingDomainError("invalid_return", "Некорректная версия возврата");
  }
}

function assertUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MarkingDomainError("invalid_return", "Некорректный идентификатор возврата");
  }
}

function bounded(value: string, label: string) {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 300) {
    throw new MarkingDomainError("invalid_return", `${label}: от 1 до 300 символов`);
  }
  return normalized;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
