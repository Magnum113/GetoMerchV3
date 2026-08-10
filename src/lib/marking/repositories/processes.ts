import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { MarkingProcessStatus } from "@/lib/marking/domain/states";
import type { MarkingEventActorType } from "@/lib/marking/events/types";

type ProcessFunctionRow = {
  id: string;
  status: MarkingProcessStatus;
  version: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type MarkingProcessMutationResult = {
  id: string;
  status: MarkingProcessStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export async function getMarkingProcessState(
  query: DatabaseQueryExecutor,
  processId: string,
) {
  const result = await query<{
    id: string;
    status: MarkingProcessStatus;
    version: string;
  }>(
    `
      SELECT id, status, version
      FROM public.merch_marking_processes
      WHERE id = $1::uuid
    `,
    [processId],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, status: row.status, version: Number(row.version) }
    : null;
}

export async function insertMarkingProcess(
  query: DatabaseQueryExecutor,
  input: {
    processType: string;
    fulfillmentOrderId?: string | null;
    fulfillmentItemId?: string | null;
    source: string;
    sourceKey: string;
    priority: number;
    currentStep: string;
    nextAction?: string | null;
    deadlineAt?: string | null;
    actorType: MarkingEventActorType;
    actorId?: string | null;
  },
) {
  const result = await query<ProcessFunctionRow>(
    `
      SELECT id, status, version, created_at, updated_at
      FROM getomerch_marking.create_process(
        $1,
        $2::uuid,
        $3::uuid,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::timestamptz,
        $10,
        $11
      )
    `,
    [
      input.processType,
      input.fulfillmentOrderId ?? null,
      input.fulfillmentItemId ?? null,
      input.source,
      input.sourceKey,
      input.priority,
      input.currentStep,
      input.nextAction ?? null,
      input.deadlineAt ?? null,
      input.actorType,
      input.actorId ?? null,
    ],
  );
  return mapProcessFunctionRow(result.rows[0]);
}

export async function updateMarkingProcessState(
  query: DatabaseQueryExecutor,
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
    actorType: MarkingEventActorType;
    actorId?: string | null;
    source: string;
  },
) {
  const result = await query<ProcessFunctionRow>(
    `
      SELECT id, status, version, created_at, updated_at
      FROM getomerch_marking.transition_process(
        $1::uuid,
        $2::bigint,
        $3,
        $4,
        $5,
        $6::timestamptz,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12
      )
    `,
    [
      input.processId,
      input.expectedVersion,
      input.toStatus,
      input.currentStep,
      input.nextAction ?? null,
      input.deadlineAt ?? null,
      input.manualReviewReason ?? null,
      input.lastErrorCode ?? null,
      input.owner ?? null,
      input.actorType,
      input.actorId ?? null,
      input.source,
    ],
  );
  return mapProcessFunctionRow(result.rows[0]);
}

function mapProcessFunctionRow(row: ProcessFunctionRow | undefined) {
  if (!row) throw new Error("Marking process mutation returned no row");
  return {
    id: row.id,
    status: row.status,
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  } satisfies MarkingProcessMutationResult;
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
