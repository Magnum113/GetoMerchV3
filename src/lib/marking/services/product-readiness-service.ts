import "server-only";

import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { normalizeGtin14 } from "@/lib/marking/domain/invariants";
import {
  assertEvidenceInput,
  assertOperationalChange,
  assertPositiveRevision,
  assertProfilePolicy,
  assertSourceSnapshot,
  isUuid,
  readinessSnapshotHash,
} from "@/lib/marking/domain/product-readiness";
import {
  MARKING_EVIDENCE_VERIFICATION_STATUSES,
  type MarkingEvidenceVerificationStatus,
  type MarkingFulfillmentMode,
  type MarkingProfileChannel,
  type MarkingProfileOperationalStatus,
  type MarkingProductionMode,
  type MarkingRequirement,
} from "@/lib/marking/domain/states";
import {
  applyProfileBackfillRun,
  getProductProfileState,
  insertProductProfileEvidence,
  insertProfileBackfillPreview,
  listProductBackfillCandidates,
  updateProductProfileOperationalStatus,
  upsertProductProfileDraft,
  verifyTradeItemAndProfile,
} from "@/lib/marking/repositories/product-profiles";

type ActorInput = {
  actorType?: "admin" | "system" | "migration";
  actorId?: string | null;
};

export async function upsertMarkingProductProfile(
  input: {
    productId: string;
    expectedRevision?: number | null;
    markingRequirement: MarkingRequirement;
    requirementSource?: string | null;
    requirementObservedAt?: string | null;
    productionMode: MarkingProductionMode;
    fulfillmentMode: MarkingFulfillmentMode;
    channel: MarkingProfileChannel;
    offerId?: string | null;
    externalProductId?: string | null;
    externalSku?: string | null;
    sourceSnapshot?: Record<string, unknown>;
  } & ActorInput,
  context: ServerMutationContext,
) {
  assertUuid(input.productId, "productId");
  if (input.expectedRevision != null) {
    assertPositiveRevision(input.expectedRevision);
  }
  assertProfilePolicy(input);
  assertOptionalText(input.offerId, "offerId", 300);
  assertOptionalText(input.externalProductId, "externalProductId", 200);
  assertOptionalText(input.externalSku, "externalSku", 200);
  const actorId = input.actorId?.trim() || context.actor;
  const sourceSnapshotHash = input.sourceSnapshot
    ? readinessSnapshotHash(input.sourceSnapshot)
    : null;
  return runServerMutation({
    operation: "marking.product-profile.upsert",
    payload: {
      ...input,
      actorType: undefined,
      actorId: undefined,
      sourceSnapshotHash,
    },
    context,
    execute: async (query, checkpoint) => {
      const profile = await upsertProductProfileDraft(query, {
        ...input,
        sourceSnapshotHash,
        actorType: input.actorType ?? "admin",
        actorId,
      });
      checkpoint("product_profile_upserted");
      return {
        data: profile,
        audit: {
          entityType: "marking_product_profile",
          entityId: profile.profileId,
          after: profile,
        },
      };
    },
  });
}

export async function verifyMarkingProductGtin(
  input: {
    profileId: string;
    expectedRevision: number;
    gtin: string;
    productGroup: string;
    tnvedCode?: string | null;
    nationalCatalogCardId?: string | null;
    nationalCatalogStatus?: string | null;
    declaredProductType?: string | null;
    declaredFabric?: string | null;
    declaredColor?: string | null;
    declaredSizeInt?: string | null;
    declaredSizeRu?: string | null;
    declaredComposition?: string | null;
    verificationSource: string;
    externalReference?: string | null;
    sourceSnapshot: Record<string, unknown>;
  } & ActorInput,
  context: ServerMutationContext,
) {
  assertUuid(input.profileId, "profileId");
  assertPositiveRevision(input.expectedRevision);
  const gtin = normalizeGtin14(input.gtin);
  assertSourceSnapshot(input.sourceSnapshot);
  assertRequiredText(input.productGroup, "productGroup", 120);
  assertOptionalPattern(input.tnvedCode, "tnvedCode", /^[0-9]{4,10}$/);
  assertRequiredText(input.verificationSource, "verificationSource", 120);
  assertOptionalText(input.externalReference, "externalReference", 500);
  assertOptionalText(input.nationalCatalogCardId, "nationalCatalogCardId", 300);
  assertOptionalText(input.nationalCatalogStatus, "nationalCatalogStatus", 120);
  assertOptionalText(input.declaredProductType, "declaredProductType", 200);
  assertOptionalText(input.declaredFabric, "declaredFabric", 200);
  assertOptionalText(input.declaredColor, "declaredColor", 200);
  assertOptionalText(input.declaredSizeInt, "declaredSizeInt", 80);
  assertOptionalText(input.declaredSizeRu, "declaredSizeRu", 80);
  assertOptionalText(input.declaredComposition, "declaredComposition", 500);
  const sourceSnapshotHash = readinessSnapshotHash(input.sourceSnapshot);
  const actorId = input.actorId?.trim() || context.actor;
  return runServerMutation({
    operation: "marking.product-profile.verify-gtin",
    payload: {
      ...input,
      gtin,
      actorType: undefined,
      actorId: undefined,
      sourceSnapshotHash,
    },
    context,
    execute: async (query, checkpoint) => {
      const before = await getProductProfileState(query, input.profileId);
      if (!before) {
        throw new MarkingDomainError("profile_not_found", "Marking profile not found");
      }
      if (before.revision !== input.expectedRevision) {
        throw new MarkingDomainError(
          "profile_revision_conflict",
          "Marking profile has already changed",
        );
      }
      const profile = await verifyTradeItemAndProfile(query, {
        ...input,
        gtin,
        sourceSnapshotHash,
        actorType: input.actorType ?? "admin",
        actorId,
      });
      checkpoint("product_gtin_verified");
      return {
        data: profile,
        audit: {
          entityType: "marking_product_profile",
          entityId: profile.profileId,
          before,
          after: profile,
        },
      };
    },
  });
}

export async function attachMarkingProductEvidence(
  input: {
    profileId: string;
    expectedRevision: number;
    evidenceType: string;
    source: string;
    externalReference?: string | null;
    scope?: Record<string, unknown>;
    details?: Record<string, unknown>;
    verificationStatus: MarkingEvidenceVerificationStatus;
    sourceSnapshot: Record<string, unknown>;
  } & ActorInput,
  context: ServerMutationContext,
) {
  assertUuid(input.profileId, "profileId");
  assertPositiveRevision(input.expectedRevision);
  if (!MARKING_EVIDENCE_VERIFICATION_STATUSES.includes(input.verificationStatus)) {
    throw new MarkingDomainError(
      "invalid_product_evidence",
      "Unknown evidence verification status",
    );
  }
  const payloadHash = readinessSnapshotHash(input.sourceSnapshot);
  assertSourceSnapshot(input.sourceSnapshot);
  assertEvidenceInput({
    ...input,
    payloadHash,
    scope: input.scope,
    details: input.details,
  });
  const actorId = input.actorId?.trim() || context.actor;
  return runServerMutation({
    operation: "marking.product-profile.attach-evidence",
    payload: {
      ...input,
      actorType: undefined,
      actorId: undefined,
      payloadHash,
    },
    context,
    execute: async (query, checkpoint) => {
      const before = await getProductProfileState(query, input.profileId);
      if (!before) {
        throw new MarkingDomainError("profile_not_found", "Marking profile not found");
      }
      if (before.revision !== input.expectedRevision) {
        throw new MarkingDomainError(
          "profile_revision_conflict",
          "Marking profile has already changed",
        );
      }
      const evidence = await insertProductProfileEvidence(query, {
        ...input,
        scope: input.scope ?? {},
        details: input.details ?? {},
        payloadHash,
        actorType: input.actorType ?? "admin",
        actorId,
      });
      checkpoint("product_evidence_attached");
      return {
        data: evidence,
        audit: {
          entityType: "marking_product_profile",
          entityId: input.profileId,
          before,
          after: evidence,
        },
      };
    },
  });
}

export async function setMarkingProductOperationalStatus(
  input: {
    profileId: string;
    expectedRevision: number;
    operationalStatus: Exclude<MarkingProfileOperationalStatus, "draft">;
    reason?: string | null;
  } & ActorInput,
  context: ServerMutationContext,
) {
  assertUuid(input.profileId, "profileId");
  assertPositiveRevision(input.expectedRevision);
  assertOperationalChange({
    status: input.operationalStatus,
    reason: input.reason,
  });
  const actorId = input.actorId?.trim() || context.actor;
  return runServerMutation({
    operation: "marking.product-profile.operational-status",
    payload: {
      ...input,
      actorType: undefined,
      actorId: undefined,
    },
    context,
    execute: async (query, checkpoint) => {
      const before = await getProductProfileState(query, input.profileId);
      if (!before) {
        throw new MarkingDomainError("profile_not_found", "Marking profile not found");
      }
      if (before.revision !== input.expectedRevision) {
        throw new MarkingDomainError(
          "profile_revision_conflict",
          "Marking profile has already changed",
        );
      }
      const profile = await updateProductProfileOperationalStatus(query, {
        ...input,
        actorType: input.actorType ?? "admin",
        actorId,
      });
      checkpoint("product_profile_status_changed");
      return {
        data: profile,
        audit: {
          entityType: "marking_product_profile",
          entityId: profile.profileId,
          before,
          after: profile,
        },
      };
    },
  });
}

export async function previewMarkingProfileBackfill(
  input: { channel: MarkingProfileChannel },
  context: ServerMutationContext,
) {
  assertProfilePolicy({
    markingRequirement: "unknown",
    productionMode: "own_production",
    fulfillmentMode: "jit_after_order",
    channel: input.channel,
  });
  return runServerMutation({
    operation: "marking.product-profile.backfill-preview",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const candidates = await listProductBackfillCandidates(query);
      if (candidates.length === 0) {
        throw new MarkingDomainError(
          "invalid_profile_backfill",
          "No sellable products found for profile backfill",
        );
      }
      const items = candidates.map((candidate) => {
        const errors: string[] = [];
        const warnings: string[] = [];
        let action: "create_draft" | "skip" | "conflict" = "create_draft";
        if (candidate.activeProfileId) {
          action = "skip";
          warnings.push("active_profile_exists");
        } else if (!candidate.sku) {
          action = "conflict";
          errors.push("sku_missing");
        } else if (candidate.duplicateSkuCount > 1) {
          action = "conflict";
          errors.push("sku_not_unique");
        } else {
          warnings.push("marking_requirement_requires_manual_confirmation");
          if (!candidate.ozonProductId && input.channel === "ozon_fbs") {
            warnings.push("ozon_product_id_missing");
          }
        }
        return {
          productId: candidate.productId,
          action,
          channel: input.channel,
          offerId: candidate.sku,
          externalProductId: candidate.ozonProductId,
          externalSku: candidate.ozonProductId,
          markingRequirement: "unknown",
          productionMode: "own_production",
          fulfillmentMode: "jit_after_order",
          gtin: candidate.exactGtin,
          plan: {
            createsInactiveDraftOnly: action === "create_draft",
            confirmsGtin: false,
            enablesProfile: false,
          },
          errors,
          warnings,
        };
      });
      const runId = await insertProfileBackfillPreview(query, {
        source: "merch_products_exact_identifiers",
        options: {
          channel: input.channel,
          inference: "disabled",
          confirmGtin: false,
          enableProfiles: false,
        },
        items,
        actorId: context.actor,
      });
      checkpoint("profile_backfill_preview_created");
      return {
        data: { runId },
        audit: {
          entityType: "marking_profile_backfill",
          entityId: runId,
          after: {
            runId,
            total: items.length,
            createDraft: items.filter((item) => item.action === "create_draft").length,
            conflicts: items.filter((item) => item.action === "conflict").length,
          },
        },
      };
    },
  });
}

export async function applyMarkingProfileBackfill(
  input: { runId: string },
  context: ServerMutationContext,
) {
  assertUuid(input.runId, "runId");
  return runServerMutation({
    operation: "marking.product-profile.backfill-apply",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const summary = await applyProfileBackfillRun(query, input.runId, context.actor);
      checkpoint("profile_backfill_applied");
      return {
        data: { runId: input.runId, summary },
        audit: {
          entityType: "marking_profile_backfill",
          entityId: input.runId,
          after: summary,
        },
      };
    },
  });
}

function assertUuid(value: string, name: string) {
  if (!isUuid(value)) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      `${name} must be a UUID`,
    );
  }
}

function assertRequiredText(value: string, name: string, max: number) {
  const length = value.trim().length;
  if (length < 1 || length > max) {
    throw new MarkingDomainError(
      "invalid_product_profile",
      `${name} must contain between 1 and ${max} characters`,
    );
  }
}

function assertOptionalText(
  value: string | null | undefined,
  name: string,
  max: number,
) {
  if (value == null || value === "") return;
  assertRequiredText(value, name, max);
}

function assertOptionalPattern(
  value: string | null | undefined,
  name: string,
  pattern: RegExp,
) {
  if (value == null || value === "") return;
  if (!pattern.test(value)) {
    throw new MarkingDomainError("invalid_product_profile", `${name} is invalid`);
  }
}
