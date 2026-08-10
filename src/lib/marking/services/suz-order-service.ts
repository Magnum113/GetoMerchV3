import "server-only";

import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import { queryServerDatabase } from "@/lib/db/pool";
import { enqueueJob } from "@/lib/jobs/queue";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  approveSuzOrder,
  cancelSuzOrder,
  createSuzOrderDraft,
  getSuzForecast,
  listSuzOrders,
  listSuzPoolForecasts,
  updateSuzPoolPolicy,
} from "@/lib/marking/repositories/suz-orders";

export async function getSuzOrderWorkspace(config = getMarkingRuntimeConfig()) {
  const [forecasts, orders] = await Promise.all([
    listSuzPoolForecasts(queryServerDatabase),
    listSuzOrders(queryServerDatabase, 100),
  ]);
  return {
    forecasts,
    orders,
    runtime: {
      enabled: config.enabled,
      draftEnabled: config.enabled && config.importEnabled,
      writeEnabled: config.suzWriteEnabled,
      signerEnabled: config.signerEnabled,
      contour: config.crptContour,
      omsConfigured: Boolean(config.suzOmsId && config.suzOmsConnection),
    },
  };
}

export async function changeSuzPoolPolicy(input: {
  tradeItemId: string;
  expectedRevision: number;
  enabled: boolean;
  minimum: number;
  target: number;
  leadTimeHours: number;
  averageWindowDays: number;
  orderLimit: number;
}, context: ServerMutationContext, dependencies: { config?: MarkingRuntimeConfig } = {}) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertSuzOperator(config, context.actor, false);
  validateUuid(input.tradeItemId, "tradeItemId");
  return runServerMutation({
    operation: "marking.suz-pool-policy.update",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const before = await getSuzForecast(query, input.tradeItemId);
      if (!before) throw new MarkingDomainError("suz_order_not_found", "Профиль GTIN не найден");
      assertAllowedGtin(config, before.gtin);
      const changed = await updateSuzPoolPolicy(query, { ...input, actorId: context.actor });
      checkpoint("suz_pool_policy_updated");
      return {
        data: changed,
        audit: {
          entityType: "marking_trade_item",
          entityId: input.tradeItemId,
          before,
          after: { ...input, policyRevision: changed.policyRevision },
        },
      };
    },
  });
}

export async function createSuzDraft(input: {
  tradeItemId: string;
  quantity?: number | null;
}, context: ServerMutationContext, dependencies: { config?: MarkingRuntimeConfig } = {}) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertSuzOperator(config, context.actor, false);
  validateUuid(input.tradeItemId, "tradeItemId");
  return runServerMutation({
    operation: "marking.suz-order.create-draft",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const forecast = await getSuzForecast(query, input.tradeItemId);
      if (!forecast) throw new MarkingDomainError("suz_order_not_found", "Прогноз GTIN не найден");
      assertAllowedGtin(config, forecast.gtin);
      const quantity = input.quantity ?? forecast.recommendedQuantity;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > forecast.orderLimit) {
        throw new MarkingDomainError(
          "invalid_suz_order",
          "Количество должно быть положительным и не превышать лимит политики GTIN",
        );
      }
      const created = await createSuzOrderDraft(query, {
        tradeItemId: input.tradeItemId,
        quantity,
        contour: config.crptContour,
        source: input.quantity == null ? "forecast" : "manual",
        idempotencyKey: context.idempotencyKey,
        forecastSnapshot: {
          available: forecast.available,
          pendingUtilisation: forecast.pendingUtilisation,
          activeDemand: forecast.activeDemand,
          inbound: forecast.inbound,
          calculatedTarget: forecast.calculatedTarget,
          recommendedQuantity: forecast.recommendedQuantity,
          policyRevision: forecast.policyRevision,
        },
        actorId: context.actor,
      });
      checkpoint("suz_order_draft_created");
      return {
        data: created,
        audit: {
          entityType: "marking_suz_order",
          entityId: created.orderId,
          after: {
            orderId: created.orderId,
            gtin: forecast.gtin,
            quantity,
            contour: config.crptContour,
            reused: created.reused,
          },
        },
      };
    },
  });
}

export async function approveSuzDraft(
  input: { orderId: string; expectedRevision: number },
  context: ServerMutationContext,
  dependencies: { config?: MarkingRuntimeConfig } = {},
) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertSuzOperator(config, context.actor, true);
  validateUuid(input.orderId, "orderId");
  return runServerMutation({
    operation: "marking.suz-order.approve",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const approved = await approveSuzOrder(query, { ...input, actorId: context.actor });
      const queued = await enqueueJob({
        type: "marking_suz_order_submit",
        dedupeKey: `suz-submit:${input.orderId}`,
        idempotencyKey: context.idempotencyKey,
        payload: { orderId: input.orderId },
        actor: context.actor,
        requestId: context.requestId,
        maxAttempts: 3,
      }, { query, scope: "marking" });
      checkpoint("suz_order_approved_and_queued");
      return {
        data: { ...approved, job: queued.job, reused: queued.reused },
        audit: {
          entityType: "marking_suz_order",
          entityId: input.orderId,
          after: {
            status: approved.status,
            revision: approved.revision,
            submitJobId: queued.job.id,
          },
        },
      };
    },
  });
}

export async function cancelSuzDraft(input: {
  orderId: string;
  expectedRevision: number;
  reason: string;
}, context: ServerMutationContext, dependencies: { config?: MarkingRuntimeConfig } = {}) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertSuzOperator(config, context.actor, false);
  validateUuid(input.orderId, "orderId");
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 1000) {
    throw new MarkingDomainError("invalid_suz_order", "Укажите причину отмены");
  }
  return runServerMutation({
    operation: "marking.suz-order.cancel",
    payload: { ...input, reason },
    context,
    execute: async (query, checkpoint) => {
      const cancelled = await cancelSuzOrder(query, { ...input, reason, actorId: context.actor });
      checkpoint("suz_order_cancelled");
      return {
        data: cancelled,
        audit: {
          entityType: "marking_suz_order",
          entityId: input.orderId,
          after: { status: cancelled.status, reason },
        },
      };
    },
  });
}

export async function requestSuzOrderPoll(
  input: { orderId: string },
  context: ServerMutationContext,
  dependencies: { config?: MarkingRuntimeConfig } = {},
) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertSuzOperator(config, context.actor, true);
  validateUuid(input.orderId, "orderId");
  return enqueueJob({
    type: "marking_suz_order_poll",
    dedupeKey: `suz-poll:${input.orderId}`,
    idempotencyKey: context.idempotencyKey,
    payload: { orderId: input.orderId },
    actor: context.actor,
    requestId: context.requestId,
    maxAttempts: 10,
  }, { scope: "marking" });
}

function assertSuzOperator(config: MarkingRuntimeConfig, actor: string, write: boolean) {
  if (!config.enabled || !config.importEnabled) {
    throw new MarkingDomainError("suz_write_disabled", "Контур пополнения пула КМ выключен");
  }
  if (write && (!config.suzWriteEnabled || !config.signerEnabled
      || !config.suzOmsId || !config.suzOmsConnection)) {
    throw new MarkingDomainError("suz_write_disabled", "Отправка заказов КМ в СУЗ выключена");
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new MarkingDomainError("assignment_access_denied", "Оператор не допущен к заказам КМ");
  }
}

function assertAllowedGtin(config: MarkingRuntimeConfig, gtin: string) {
  if (!config.allowedGtins.includes(gtin)) {
    throw new MarkingDomainError("assignment_access_denied", "GTIN не входит в разрешённый контур СУЗ");
  }
}

function validateUuid(value: string, name: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MarkingDomainError("invalid_suz_order", `Некорректный ${name}`);
  }
}
