import { createHash } from "node:crypto";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  MARKING_FULFILLMENT_MODES,
  MARKING_PROFILE_CHANNELS,
  MARKING_PROFILE_OPERATIONAL_STATUSES,
  MARKING_PRODUCTION_MODES,
  MARKING_REQUIREMENTS,
  type MarkingFulfillmentMode,
  type MarkingProfileChannel,
  type MarkingProfileOperationalStatus,
  type MarkingProductionMode,
  type MarkingRequirement,
} from "@/lib/marking/domain/states";

export function assertProfilePolicy(input: {
  markingRequirement: MarkingRequirement;
  requirementSource?: string | null;
  requirementObservedAt?: string | null;
  productionMode: MarkingProductionMode;
  fulfillmentMode: MarkingFulfillmentMode;
  channel: MarkingProfileChannel;
}) {
  assertEnum(input.markingRequirement, MARKING_REQUIREMENTS, "marking requirement");
  assertEnum(input.productionMode, MARKING_PRODUCTION_MODES, "production mode");
  assertEnum(input.fulfillmentMode, MARKING_FULFILLMENT_MODES, "fulfillment mode");
  assertEnum(input.channel, MARKING_PROFILE_CHANNELS, "profile channel");

  const minor = input.productionMode === "pre_marked_minor_customization";
  if (minor !== (input.fulfillmentMode === "pre_marked_minor_customization")) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      "Production and fulfillment marking modes are incompatible",
    );
  }
  if (
    input.markingRequirement !== "unknown"
    && (
      !validText(input.requirementSource, 200)
      || !isIsoTimestamp(input.requirementObservedAt)
    )
  ) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      "Known marking requirement needs a source and observation time",
    );
  }
}

export function assertOperationalChange(input: {
  status: MarkingProfileOperationalStatus;
  reason?: string | null;
}) {
  assertEnum(input.status, MARKING_PROFILE_OPERATIONAL_STATUSES, "operational status");
  if (input.status === "draft") {
    throw new MarkingDomainError(
      "invalid_product_profile",
      "Operational command accepts only enabled or paused",
    );
  }
  if (input.status === "paused" && !validText(input.reason, 1000)) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      "Paused profile requires a reason",
    );
  }
}

export function assertEvidenceInput(input: {
  evidenceType: string;
  source: string;
  externalReference?: string | null;
  payloadHash: string;
  scope?: Record<string, unknown>;
  details?: Record<string, unknown>;
}) {
  if (!validText(input.evidenceType, 120) || !validText(input.source, 120)) {
    throw new MarkingDomainError(
      "invalid_product_evidence",
      "Evidence type and source are required",
    );
  }
  if (input.externalReference && !validText(input.externalReference, 500)) {
    throw new MarkingDomainError(
      "invalid_product_evidence",
      "Evidence reference is too long",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.payloadHash)) {
    throw new MarkingDomainError(
      "invalid_product_evidence",
      "Evidence payload hash must be SHA-256",
    );
  }
  assertSmallObject(input.scope, "scope");
  assertSmallObject(input.details, "details");
}

export function readinessSnapshotHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

export function assertSourceSnapshot(value: Record<string, unknown>) {
  if (
    Object.keys(value).length === 0
    || Buffer.byteLength(JSON.stringify(value), "utf8") > 32_768
  ) {
    throw new MarkingDomainError(
      "invalid_product_evidence",
      "Source snapshot must be a non-empty object up to 32 KiB",
    );
  }
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

export function assertPositiveRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MarkingDomainError(
      "profile_revision_conflict",
      "Expected profile revision must be a positive integer",
    );
  }
}

function assertEnum(value: string, allowed: readonly string[], label: string) {
  if (!allowed.includes(value)) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      `Unknown ${label}`,
    );
  }
}

function assertSmallObject(value: Record<string, unknown> | undefined, label: string) {
  if (!value) return;
  if (
    Array.isArray(value)
    || typeof value !== "object"
    || Buffer.byteLength(JSON.stringify(value), "utf8") > 16_384
  ) {
    throw new MarkingDomainError(
      "invalid_product_evidence",
      `Evidence ${label} must be a small object`,
    );
  }
}

function validText(value: string | null | undefined, max: number) {
  const length = value?.trim().length ?? 0;
  return length >= 1 && length <= max;
}

function isIsoTimestamp(value: string | null | undefined) {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}
