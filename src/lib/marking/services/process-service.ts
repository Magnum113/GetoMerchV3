import "server-only";

import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { assertMarkingProcessTransition } from "@/lib/marking/domain/transitions";
import type { MarkingProcessStatus } from "@/lib/marking/domain/states";
import type { MarkingEventActorType } from "@/lib/marking/events/types";
import {
  getMarkingProcessState,
  insertMarkingProcess,
  updateMarkingProcessState,
} from "@/lib/marking/repositories/processes";

type ActorInput = {
  actorType: MarkingEventActorType;
  actorId?: string | null;
};

export async function createMarkingProcess(
  input: {
    processType: string;
    fulfillmentOrderId?: string | null;
    fulfillmentItemId?: string | null;
    source: string;
    sourceKey: string;
    priority?: number;
    currentStep: string;
    nextAction?: string | null;
    deadlineAt?: string | null;
  } & ActorInput,
  context: ServerMutationContext,
) {
  validateProcessText(input.processType, "processType", 120);
  validateProcessText(input.source, "source", 120);
  validateProcessText(input.sourceKey, "sourceKey", 500);
  validateProcessText(input.currentStep, "currentStep", 120);
  const priority = input.priority ?? 50;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
    throw new MarkingDomainError(
      "invalid_process_status",
      "Marking process priority must be between 0 and 100",
    );
  }

  return runServerMutation({
    operation: "marking.process.create",
    payload: {
      processType: input.processType,
      fulfillmentOrderId: input.fulfillmentOrderId ?? null,
      fulfillmentItemId: input.fulfillmentItemId ?? null,
      source: input.source,
      sourceKey: input.sourceKey,
      priority,
      currentStep: input.currentStep,
      nextAction: input.nextAction ?? null,
      deadlineAt: input.deadlineAt ?? null,
    },
    context,
    execute: async (query, checkpoint) => {
      const process = await insertMarkingProcess(query, { ...input, priority });
      checkpoint("process_and_event_created");
      return {
        data: process,
        audit: {
          entityType: "marking_process",
          entityId: process.id,
          after: process,
        },
      };
    },
  });
}

export async function transitionMarkingProcess(
  input: {
    processId: string;
    expectedVersion: number;
    toStatus: MarkingProcessStatus;
    currentStep: string;
    nextAction?: string | null;
    deadlineAt?: string | null;
    manualReviewReason?: string | null;
    lastErrorCode?: string | null;
    owner?: string | null;
    source: string;
  } & ActorInput,
  context: ServerMutationContext,
) {
  validateProcessText(input.currentStep, "currentStep", 120);
  validateProcessText(input.source, "source", 120);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new MarkingDomainError(
      "process_version_conflict",
      "Expected process version must be a positive integer",
    );
  }
  if (input.toStatus === "manual_review") {
    validateProcessText(input.manualReviewReason ?? "", "manualReviewReason", 1000);
  }
  if (input.toStatus === "failed") {
    validateProcessText(input.lastErrorCode ?? "", "lastErrorCode", 120);
  }

  return runServerMutation({
    operation: "marking.process.transition",
    payload: {
      processId: input.processId,
      expectedVersion: input.expectedVersion,
      toStatus: input.toStatus,
      currentStep: input.currentStep,
      nextAction: input.nextAction ?? null,
      deadlineAt: input.deadlineAt ?? null,
      manualReviewReason: input.manualReviewReason ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      owner: input.owner ?? null,
      source: input.source,
    },
    context,
    execute: async (query, checkpoint) => {
      const before = await getMarkingProcessState(query, input.processId);
      if (!before) {
        throw new MarkingDomainError("process_not_found", "Marking process not found");
      }
      if (before.version !== input.expectedVersion) {
        throw new MarkingDomainError(
          "process_version_conflict",
          "Marking process has already changed",
        );
      }
      assertMarkingProcessTransition(before.status, input.toStatus);
      const process = await updateMarkingProcessState(query, input);
      checkpoint("process_and_event_transitioned");
      return {
        data: process,
        audit: {
          entityType: "marking_process",
          entityId: process.id,
          before,
          after: process,
        },
      };
    },
  });
}

function validateProcessText(value: string, name: string, max: number) {
  const length = value.trim().length;
  if (length < 1 || length > max) {
    throw new MarkingDomainError(
      "invalid_process_status",
      `${name} must contain between 1 and ${max} characters`,
    );
  }
}
