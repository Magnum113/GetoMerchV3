import {
  MARKING_PROCESS_STATUSES,
  type MarkingProcessStatus,
} from "@/lib/marking/domain/states";
import { MarkingDomainError } from "@/lib/marking/domain/errors";

const TRANSITIONS: Readonly<Record<MarkingProcessStatus, readonly MarkingProcessStatus[]>> = {
  open: [
    "waiting_user",
    "waiting_external",
    "ready",
    "manual_review",
    "failed",
    "cancelled",
  ],
  waiting_user: [
    "open",
    "waiting_external",
    "ready",
    "manual_review",
    "failed",
    "cancelled",
  ],
  waiting_external: [
    "waiting_user",
    "ready",
    "manual_review",
    "failed",
    "cancelled",
  ],
  ready: [
    "waiting_user",
    "waiting_external",
    "completed",
    "manual_review",
    "failed",
    "cancelled",
  ],
  manual_review: [
    "open",
    "waiting_user",
    "waiting_external",
    "ready",
    "failed",
    "cancelled",
  ],
  failed: ["open", "manual_review", "cancelled"],
  completed: [],
  cancelled: [],
};

export function isMarkingProcessStatus(value: string): value is MarkingProcessStatus {
  return (MARKING_PROCESS_STATUSES as readonly string[]).includes(value);
}

export function allowedMarkingProcessTransitions(status: MarkingProcessStatus) {
  return TRANSITIONS[status];
}

export function canTransitionMarkingProcess(
  from: MarkingProcessStatus,
  to: MarkingProcessStatus,
) {
  return TRANSITIONS[from].includes(to);
}

export function assertMarkingProcessTransition(
  from: MarkingProcessStatus,
  to: MarkingProcessStatus,
) {
  if (!canTransitionMarkingProcess(from, to)) {
    throw new MarkingDomainError(
      "invalid_process_transition",
      `Marking process transition ${from} -> ${to} is not allowed`,
    );
  }
}

export function requireMarkingProcessStatus(value: string) {
  if (!isMarkingProcessStatus(value)) {
    throw new MarkingDomainError(
      "invalid_process_status",
      `Unknown marking process status: ${value}`,
    );
  }
  return value;
}
