import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import {
  assertEvidenceInput,
  assertOperationalChange,
  assertProfilePolicy,
  assertSourceSnapshot,
  readinessSnapshotHash,
} from "@/lib/marking/domain/product-readiness";
import { normalizeGtin14 } from "@/lib/marking/domain/invariants";

assert.equal(normalizeGtin14("4628837736075"), "04628837736075");
assert.throws(
  () => normalizeGtin14("4628837736074"),
  (error) => error instanceof MarkingDomainError && error.code === "invalid_gtin",
);

assert.doesNotThrow(() => assertProfilePolicy({
  markingRequirement: "unknown",
  productionMode: "own_production",
  fulfillmentMode: "jit_after_order",
  channel: "ozon_fbs",
}));
assert.throws(
  () => assertProfilePolicy({
    markingRequirement: "required",
    productionMode: "own_production",
    fulfillmentMode: "jit_after_order",
    channel: "ozon_fbs",
  }),
  (error) => error instanceof MarkingDomainError
    && error.code === "invalid_product_profile",
);
assert.throws(
  () => assertProfilePolicy({
    markingRequirement: "unknown",
    productionMode: "pre_marked_minor_customization",
    fulfillmentMode: "jit_after_order",
    channel: "ozon_fbs",
  }),
  (error) => error instanceof MarkingDomainError
    && error.code === "invalid_product_profile",
);
assert.throws(
  () => assertOperationalChange({ status: "paused", reason: "" }),
  (error) => error instanceof MarkingDomainError
    && error.code === "invalid_product_profile",
);

const firstHash = readinessSnapshotHash({ size: "S", color: "white" });
const secondHash = readinessSnapshotHash({ color: "white", size: "S" });
assert.equal(firstHash, secondHash);
assert.match(firstHash, /^[0-9a-f]{64}$/);
assert.doesNotThrow(() => assertEvidenceInput({
  evidenceType: "product_profile_mapping",
  source: "stage4_test",
  payloadHash: firstHash,
}));
assert.throws(
  () => assertSourceSnapshot({}),
  (error) => error instanceof MarkingDomainError
    && error.code === "invalid_product_evidence",
);

const migration = read("db/migrations/0008_marking_product_readiness.sql");
const repository = read("src/lib/marking/repositories/product-profiles.ts");
const readModels = read("src/lib/marking/read-models/repository.ts");
const service = read("src/lib/marking/services/product-readiness-service.ts");
const page = read("src/app/marking/page.tsx");

for (const table of [
  "merch_marking_product_profile_channels",
  "merch_marking_profile_backfill_runs",
  "merch_marking_profile_backfill_items",
]) {
  assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}`));
}
for (const command of [
  "upsert_product_profile_draft",
  "verify_trade_item_and_profile",
  "attach_product_profile_evidence",
  "set_product_profile_operational_status",
  "create_profile_backfill_preview",
  "apply_profile_backfill",
]) {
  assert.match(migration, new RegExp(`getomerch_marking\\.${command}`));
}
assert.doesNotMatch(
  migration,
  /candidate\.exact_gtin IS NOT NULL/,
  "An exact GTIN hint must not prevent safe draft creation",
);
assert.match(migration, /profile\.trade_item_id is not null/i);
assert.match(migration, /Stage 4 backfill never auto-confirms this GTIN/);
assert.match(migration, /MZ106/);
assert.match(migration, /MZ107/);

assert.doesNotMatch(repository, /SELECT\s+\*/i);
assert.doesNotMatch(readModels, /SELECT\s+\*/i);
assert.match(service, /runServerMutation/g);
assert.match(service, /inference:\s*"disabled"/);
assert.match(service, /confirmsGtin:\s*false/);
assert.match(service, /enablesProfile:\s*false/);
assert.doesNotMatch(service, /design|productName|ozonName/i);
assert.match(page, /Сформировать preview/);
assert.match(page, /Применить этот preview/);

const apiRoutes = [
  "src/app/api/admin/marking/profiles/route.ts",
  "src/app/api/admin/marking/profiles/[id]/verify-gtin/route.ts",
  "src/app/api/admin/marking/profiles/[id]/evidence/route.ts",
  "src/app/api/admin/marking/profiles/[id]/operational-status/route.ts",
  "src/app/api/admin/marking/profile-backfills/preview/route.ts",
  "src/app/api/admin/marking/profile-backfills/[id]/apply/route.ts",
];
for (const route of apiRoutes) {
  const source = read(route);
  assert.match(source, /requireMarkingMutationContext/);
  assert.match(source, /markingMutationError/);
}

const combined = [migration, repository, readModels, service, page]
  .join("\n")
  .toLowerCase();
for (const forbidden of [
  "next_public_getomerch",
  "service_role",
  "payload_envelope",
  "full_marking_code",
  "plaintext_code",
]) {
  assert.equal(combined.includes(forbidden), false, `Stage 4 contains ${forbidden}`);
}

console.log("Stage 4 product readiness domain, API and safety checks passed");

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}
