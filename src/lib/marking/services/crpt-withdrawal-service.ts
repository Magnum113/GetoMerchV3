import "server-only";

import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import { enqueueJob } from "@/lib/jobs/queue";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { prepareWithdrawalDocument } from "@/lib/marking/repositories/withdrawals";

export async function retryCrptWithdrawal(
  handoverId: string,
  context: ServerMutationContext,
  config: MarkingRuntimeConfig = getMarkingRuntimeConfig(),
) {
  if (!config.enabled || !config.withdrawalEnabled) {
    throw new MarkingDomainError("crpt_withdrawal_disabled", "Вывод из оборота пока выключен");
  }
  if (!config.allowedAdminIds.includes(context.actor)) {
    throw new MarkingDomainError("assignment_access_denied", "Нет доступа к выводу из оборота");
  }
  return withServerDatabaseTransaction(async (query) => {
    const document = await prepareWithdrawalDocument(query, {
      handoverId,
      actorId: context.actor,
      requestId: context.requestId,
      forceCorrection: true,
    });
    const queued = await enqueueJob({
      type: "marking_withdrawal_submit",
      dedupeKey: `crpt-withdrawal-submit:${document.id}`,
      idempotencyKey: context.idempotencyKey,
      payload: { documentId: document.id },
      actor: context.actor,
      requestId: context.requestId,
      maxAttempts: 2,
    }, { query, scope: "marking" });
    return { document, job: queued.job, reused: queued.reused };
  });
}
