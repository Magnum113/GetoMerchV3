import "server-only";

import { createHash } from "node:crypto";
import { queryServerDatabase } from "@/lib/db/pool";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  getMarkingRuntimeConfig,
  type MarkingRuntimeConfig,
} from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  getOzonSubmissionBatch,
  listOzonOrderAccessUnits,
  listOzonSubmissionUnits,
  prepareOzonSubmissionBatch,
} from "@/lib/marking/repositories/ozon-exemplars";

export async function requestOzonExemplarOperation(
  input: {
    fulfillmentOrderId: string;
    operation: "validate" | "submit";
    forceCorrection?: boolean;
  },
  context: ServerMutationContext,
  dependencies: { config?: MarkingRuntimeConfig } = {},
) {
  assertUuid(input.fulfillmentOrderId);
  if (input.operation !== "validate" && input.operation !== "submit") {
    throw new MarkingDomainError("invalid_ozon_submission", "Некорректная операция Ozon");
  }
  if (input.forceCorrection && input.operation !== "validate") {
    throw new MarkingDomainError(
      "invalid_ozon_submission",
      "Исправление сначала необходимо повторно проверить в Ozon",
    );
  }
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertOzonOperator(config, context.actor);
  const accessUnits = await listOzonOrderAccessUnits(
    queryServerDatabase,
    input.fulfillmentOrderId,
  );
  assertOzonUnitAccess(config, accessUnits);
  const prepared = await prepareOzonSubmissionBatch(queryServerDatabase, {
    fulfillmentOrderId: input.fulfillmentOrderId,
    actorId: context.actor,
    forceCorrection: input.forceCorrection === true,
  });
  const units = await listOzonSubmissionUnits(queryServerDatabase, prepared.batchId);
  assertOzonUnitAccess(config, units);
  const batch = await getOzonSubmissionBatch(queryServerDatabase, prepared.batchId);
  if (!batch) {
    throw new MarkingDomainError("invalid_ozon_submission", "Пакет Ozon не найден");
  }

  const jobType = input.operation === "validate"
    ? "marking_ozon_validate" as const
    : "marking_ozon_submit" as const;
  const executable = input.operation === "validate"
    ? ["prepared", "validation_failed", "validating"].includes(batch.status)
    : ["validated", "submitting", "polling"].includes(batch.status);
  if (!executable) {
    const alreadyDone = input.operation === "validate"
      ? ["validated", "submitting", "polling", "accepted"].includes(batch.status)
      : batch.status === "accepted";
    if (alreadyDone) return { batch, job: null, reused: true };
    throw new MarkingDomainError(
      "ozon_submission_not_ready",
      input.operation === "submit"
        ? "КМ ещё не прошли проверку Ozon"
        : "Пакет нельзя отправить на проверку Ozon",
    );
  }

  const operationKey = `${batch.postingNumber}:${batch.postingSnapshotHash}:${input.operation}`;
  const queued = await enqueueJob({
    type: jobType,
    dedupeKey: `marking-ozon:${batch.id}:${input.operation}`,
    idempotencyKey: `marking-ozon:${digest(`${context.idempotencyKey}:${operationKey}`)}`,
    payload: { batchId: batch.id },
    actor: context.actor,
    requestId: context.requestId,
    maxAttempts: 4,
  });
  return { batch, job: queued.job, reused: prepared.reused || queued.reused };
}

export function assertOzonOperator(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.ozonWriteEnabled) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Передача КМ в Ozon отключена",
    );
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new MarkingDomainError(
      "assignment_access_denied",
      "Оператор не включён в контур передачи КМ в Ozon",
    );
  }
}

export function assertOzonUnitAccess(
  config: MarkingRuntimeConfig,
  units: Array<{ gtin: string; offerId: string | null }>,
) {
  if (units.length === 0) {
    throw new MarkingDomainError("invalid_ozon_submission", "В пакете Ozon нет единиц");
  }
  for (const unit of units) {
    if (!config.allowedGtins.includes(unit.gtin)) {
      throw new MarkingDomainError(
        "assignment_access_denied",
        "GTIN не включён в контур передачи КМ в Ozon",
      );
    }
    if (!unit.offerId || !config.allowedOffers.includes(unit.offerId)) {
      throw new MarkingDomainError(
        "assignment_access_denied",
        "Артикул не включён в контур передачи КМ в Ozon",
      );
    }
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MarkingDomainError(
      "invalid_ozon_submission",
      "Некорректный идентификатор заказа",
    );
  }
}
