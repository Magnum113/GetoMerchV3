export const MARKING_EVENT_TYPES = [
  "process_created",
  "process_transitioned",
] as const;

export type MarkingEventType = (typeof MARKING_EVENT_TYPES)[number];

export type MarkingEventActorType = "admin" | "worker" | "system" | "migration";

export type MarkingProcessEventDetails = {
  status?: string;
  fromStatus?: string;
  toStatus?: string;
  currentStep: string;
  nextAction?: string | null;
  version: number;
};
