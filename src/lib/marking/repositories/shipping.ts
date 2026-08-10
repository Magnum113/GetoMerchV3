import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { MarkingShippingGateMode } from "@/lib/marking/config";

export type ShippingGateEvaluation = {
  id: string;
  allowed: boolean;
  mode: MarkingShippingGateMode;
  blockers: string[];
  evidenceVersion: string;
  evaluatedAt: string;
};

export async function hasRequiredMarking(
  query: DatabaseQueryExecutor,
  fulfillmentOrderId: string,
) {
  const row = (await query<{ required: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM public.merch_fulfillment_order_items AS item
      WHERE item.fulfillment_order_id = $1::uuid
        AND item.source_active
        AND item.marking_requirement = 'required'
    ) AS required`,
    [fulfillmentOrderId],
  )).rows[0];
  return row?.required === true;
}

export async function evaluateShippingGate(
  query: DatabaseQueryExecutor,
  input: {
    fulfillmentOrderId: string;
    mode: MarkingShippingGateMode;
    actorId: string;
    requestId: string;
  },
): Promise<ShippingGateEvaluation> {
  const row = (await query<{
    evaluation_id: string;
    allowed: boolean;
    mode: MarkingShippingGateMode;
    blockers: string[];
    evidence_version: string;
    evaluated_at: Date | string;
  }>(
    `SELECT evaluation_id, allowed, mode, blockers, evidence_version, evaluated_at
     FROM getomerch_marking.evaluate_shipping_gate($1::uuid,$2,$3,$4::uuid)`,
    [input.fulfillmentOrderId, input.mode, input.actorId, input.requestId],
  )).rows[0];
  return {
    id: row.evaluation_id,
    allowed: row.allowed,
    mode: row.mode,
    blockers: row.blockers ?? [],
    evidenceVersion: row.evidence_version,
    evaluatedAt: new Date(row.evaluated_at).toISOString(),
  };
}

export async function recordShippingHandover(
  query: DatabaseQueryExecutor,
  input: {
    fulfillmentOrderId: string;
    gateEvaluationId: string;
    actorId: string;
    requestId: string;
    idempotencyKey: string;
  },
) {
  const row = (await query<{
    handover_id: string;
    document_id: string | null;
    document_status: string | null;
    gate_allowed: boolean;
    blockers: string[];
    reused: boolean;
  }>(
    `SELECT handover_id, document_id, document_status, gate_allowed, blockers, reused
     FROM getomerch_marking.record_shipping_handover(
       $1::uuid,$2::uuid,$3,$4::uuid,$5
     )`,
    [input.fulfillmentOrderId, input.gateEvaluationId, input.actorId,
      input.requestId, input.idempotencyKey],
  )).rows[0];
  return {
    id: row.handover_id,
    documentId: row.document_id,
    documentStatus: row.document_status,
    gateAllowed: row.gate_allowed,
    blockers: row.blockers ?? [],
    reused: row.reused,
  };
}

export async function hasShippingHandover(
  query: DatabaseQueryExecutor,
  fulfillmentOrderId: string,
) {
  return (await query<{ present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM public.merch_marking_handovers
      WHERE fulfillment_order_id = $1::uuid
    ) AS present`,
    [fulfillmentOrderId],
  )).rows[0]?.present === true;
}
