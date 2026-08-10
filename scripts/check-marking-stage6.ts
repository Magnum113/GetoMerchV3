#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import { assertJitAccess } from "@/lib/marking/services/assignment-service";

const ROOT = process.cwd();
const GTIN = "04628837736075";
const OFFER = "STAGE6-JIT-S";

main().catch((error) => {
  console.error("Stage 6 JIT assignment checks failed", error);
  process.exitCode = 1;
});

async function main() {
  const config = parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_JUST_IN_TIME_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_GTINS: GTIN,
    GETOMERCH_MARKING_ALLOWED_OFFERS: OFFER,
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
  });
  assertJitAccess(config, "owner", GTIN, OFFER);
  assert.throws(() => assertJitAccess(config, "other", GTIN, OFFER));
  assert.throws(() => assertJitAccess(config, "owner", GTIN, "OTHER"));
  assert.throws(() => parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_JUST_IN_TIME_ENABLED: "true",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
  }));

  const service = await readFile(
    `${ROOT}/src/lib/marking/services/assignment-service.ts`,
    "utf8",
  );
  assert.match(service, /runServerMutation/);
  assert.match(service, /produceInternal/);
  assert.match(service, /lockJitAssignmentForApply/);
  assert.match(service, /completeJitApplication/);
  assert.match(service, /enqueueCrptApplicationPreparation/);
  const applyBody = service.slice(
    service.indexOf("export async function confirmMarkingCodeApplied"),
    service.indexOf("export async function cancelMarkingAssignment"),
  );
  assert.match(
    applyBody,
    /lockJitAssignmentForApply[\s\S]*produceInternal[\s\S]*completeJitApplication[\s\S]*enqueueCrptApplicationPreparation/,
  );

  const repository = await readFile(
    `${ROOT}/src/lib/marking/repositories/assignments.ts`,
    "utf8",
  );
  assert.doesNotMatch(repository, /SELECT\s+\*/i);
  assert.doesNotMatch(
    repository,
    /code_(?:ciphertext|nonce|auth_tag|hmac)|dedup_hmacs|\bserial\b/i,
  );

  for (const file of [
    "src/app/api/admin/marking/assignments/route.ts",
    "src/app/api/admin/marking/assignments/[id]/apply/route.ts",
    "src/app/api/admin/marking/assignments/[id]/cancel/route.ts",
  ]) {
    const source = await readFile(`${ROOT}/${file}`, "utf8");
    assert.match(source, /requireMarkingMutationContext/);
  }

  const migration = await readFile(
    `${ROOT}/db/migrations/0010_marking_jit_assignments.sql`,
    "utf8",
  );
  assert.match(migration, /FOR UPDATE SKIP LOCKED/i);
  assert.match(migration, /merch_marking_assignments_active_slot/i);
  assert.match(migration, /security_barrier\s*=\s*true/i);
  assert.match(migration, /stockChanged', false/i);
  assert.doesNotMatch(
    migration,
    /\b(?:plaintext_code|full_marking_code|raw_marking_code)\b/i,
  );

  const page = await readFile(`${ROOT}/src/app/marking/page.tsx`, "utf8");
  assert.match(page, /Назначения/);
  assert.doesNotMatch(page, /КМ нанесен|КМ нанесён.*onClick/);
  console.log("Stage 6 JIT configuration, transaction boundary and API checks passed");
}
