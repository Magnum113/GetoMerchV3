import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { produceInternal } from "@/lib/db/mutations/inventory-actions";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import {
  getMarkingRuntimeConfig,
  type MarkingRuntimeConfig,
} from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  cancelJitAssignment,
  completeJitApplication,
  enqueueCrptApplicationPreparation,
  getJitAssignmentAccessContext,
  getJitCandidateAccessContext,
  lockJitAssignmentForApply,
  prepareJitAssignment,
} from "@/lib/marking/repositories/assignments";

type AssignmentDependencies = {
  config?: MarkingRuntimeConfig;
};

export async function prepareMarkingAssignment(
  input: { fulfillmentItemId: string; warehouseId: string },
  context: ServerMutationContext,
  dependencies: AssignmentDependencies = {},
) {
  assertUuid(input.fulfillmentItemId, "fulfillmentItemId");
  assertUuid(input.warehouseId, "warehouseId");
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  return runServerMutation({
    operation: "marking.assignment.prepare",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const access = await getJitCandidateAccessContext(
        query,
        input.fulfillmentItemId,
        input.warehouseId,
      );
      if (!access) {
        throw new MarkingDomainError(
          "assignment_not_found",
          "Строка заказа не готова к назначению КМ",
        );
      }
      assertJitAccess(config, context.actor, access.gtin, access.offerId);
      const prepared = await prepareJitAssignment(query, {
        ...input,
        actorId: context.actor,
      });
      checkpoint("assignment_prepared");
      return {
        data: prepared,
        audit: {
          entityType: "marking_assignment",
          entityId: prepared.assignmentId,
          after: {
            assignmentId: prepared.assignmentId,
            markingUnitId: prepared.markingUnitId,
            processId: prepared.processId,
            fulfillmentItemId: input.fulfillmentItemId,
            unitOrdinal: prepared.unitOrdinal,
            gtin: prepared.gtin,
            codeFingerprint: prepared.codeFingerprint,
            warehouseId: prepared.warehouseId,
            stockChanged: false,
          },
        },
      };
    },
  });
}

export async function confirmMarkingCodeApplied(
  input: { assignmentId: string; expectedRevision: number },
  context: ServerMutationContext,
  dependencies: AssignmentDependencies = {},
) {
  assertUuid(input.assignmentId, "assignmentId");
  assertRevision(input.expectedRevision);
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  return runServerMutation({
    operation: "marking.assignment.apply",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const access = await requireAssignmentAccess(query, input.assignmentId);
      assertJitAccess(config, context.actor, access.gtin, access.offerId);
      const locked = await lockJitAssignmentForApply(query, {
        ...input,
        actorId: context.actor,
      });
      checkpoint("assignment_locked");
      const production = await produceInternal(query, {
        blankProductId: locked.blankProductId,
        finishedProductId: locked.finishedProductId,
        warehouseId: locked.warehouseId,
        quantity: 1,
        notes: `JIT marking assignment ${locked.assignmentId}`,
      }, checkpoint);
      checkpoint("inventory_committed_to_transaction");
      const transition = await completeJitApplication(query, {
        assignmentId: input.assignmentId,
        expectedRevision: locked.assignmentRevision,
        stockTransactionId: production.movementId,
        actorId: context.actor,
      });
      checkpoint("application_completed");
      const jobPayload = {
        assignmentId: locked.assignmentId,
        markingUnitId: locked.markingUnitId,
        codeBindingId: locked.codeBindingId,
        gtin: locked.gtin,
      };
      const crptJobId = await enqueueCrptApplicationPreparation(query, {
        ...jobPayload,
        actorId: context.actor,
        requestId: context.requestId,
        requestHash: createHash("sha256")
          .update(JSON.stringify(jobPayload))
          .digest("hex"),
      });
      checkpoint("crpt_job_enqueued");
      return {
        data: {
          ...transition,
          stockTransactionId: production.movementId,
          crptJobId,
        },
        audit: {
          entityType: "marking_assignment",
          entityId: input.assignmentId,
          before: {
            assignmentRevision: input.expectedRevision,
            unitState: "preparing",
            stockChanged: false,
          },
          after: {
            ...transition,
            stockTransactionId: production.movementId,
            crptJobId,
            productChanges: production.productChanges,
            printChanges: production.printChanges,
          },
        },
      };
    },
  });
}

export async function cancelMarkingAssignment(
  input: {
    assignmentId: string;
    expectedRevision: number;
    reason: string;
  },
  context: ServerMutationContext,
  dependencies: AssignmentDependencies = {},
) {
  assertUuid(input.assignmentId, "assignmentId");
  assertRevision(input.expectedRevision);
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1000) {
    throw new MarkingDomainError(
      "invalid_assignment",
      "Укажите причину отмены от 3 до 1000 символов",
    );
  }
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  return runServerMutation({
    operation: "marking.assignment.cancel",
    payload: { ...input, reason },
    context,
    execute: async (query, checkpoint) => {
      const access = await requireAssignmentAccess(query, input.assignmentId);
      assertJitAccess(config, context.actor, access.gtin, access.offerId);
      const transition = await cancelJitAssignment(query, {
        ...input,
        reason,
        actorId: context.actor,
      });
      checkpoint("assignment_cancelled");
      return {
        data: transition,
        audit: {
          entityType: "marking_assignment",
          entityId: input.assignmentId,
          before: { assignmentRevision: input.expectedRevision },
          after: { ...transition, reason },
        },
      };
    },
  });
}

export function assertJitAccess(
  config: MarkingRuntimeConfig,
  actor: string,
  gtin: string,
  offerId: string,
) {
  if (!config.enabled || !config.justInTimeEnabled) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "JIT-маркировка отключена",
    );
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Оператор не включён в контур JIT-маркировки",
    );
  }
  if (!config.allowedGtins.includes(gtin)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "GTIN не включён в пилот JIT-маркировки",
    );
  }
  if (!config.allowedOffers.includes(offerId)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Артикул не включён в пилот JIT-маркировки",
    );
  }
}

async function requireAssignmentAccess(
  query: DatabaseQueryExecutor,
  assignmentId: string,
) {
  const access = await getJitAssignmentAccessContext(query, assignmentId);
  if (!access) {
    throw new MarkingDomainError(
      "assignment_not_found",
      "Назначение КМ не найдено",
    );
  }
  return access;
}

function assertRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MarkingDomainError(
      "invalid_assignment",
      "Некорректная версия назначения",
    );
  }
}

function assertUuid(value: string, name: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)) {
    throw new MarkingDomainError(
      "invalid_assignment",
      `${name}: некорректный идентификатор`,
    );
  }
}
