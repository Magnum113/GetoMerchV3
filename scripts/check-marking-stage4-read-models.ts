import assert from "node:assert/strict";
import { closeServerDatabasePool } from "@/lib/db/pool";
import { PostgresMarkingReadRepository } from "@/lib/marking/read-models/repository";

async function main() {
  const repository = new PostgresMarkingReadRepository();
  try {
    const pilotPage = await repository.listReadiness({
      limit: 20,
      search: "D15-TSH-PRT-WHT-S",
    });
    const pilot = pilotPage.items.find((item) => item.sku === "D15-TSH-PRT-WHT-S");
    assert.ok(pilot);
    assert.equal(pilot.gtin, "04628837736075");
    assert.equal(pilot.nationalCatalogCardId, "1056097470");
    assert.ok(pilot.warnings.includes("document_reference_attention"));
    assert.equal(
      pilot.blockerReasons.includes("document_reference_attention"),
      false,
      "Document reference warning must not become a readiness blocker",
    );

    const conflicts = await repository.listConflicts({ limit: 100 });
    assert.ok(
      conflicts.some(
        (item) => item.conflictType === "catalog_attribute_mismatch"
          && item.severity === "blocking",
      ),
    );
    assert.ok(
      conflicts.some(
        (item) => item.conflictType === "ozon_requirement_mismatch"
          && item.severity === "blocking",
      ),
    );
    assert.ok(
      conflicts.some(
        (item) => item.conflictType === "document_reference_warning"
          && item.severity === "warning",
      ),
    );

    const conflictProducts = await repository.listReadiness({
      limit: 20,
      conflictsOnly: true,
    });
    assert.ok(conflictProducts.items.length >= 2);
    assert.ok(conflictProducts.items.every((item) => item.conflictCount > 0));

    const firstPage = await repository.listReadiness({ limit: 2 });
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.page.hasMore, true);
    assert.ok(firstPage.page.nextCursor);
    const secondPage = await repository.listReadiness({
      limit: 2,
      cursor: firstPage.page.nextCursor,
    });
    const firstIds = new Set(firstPage.items.map((item) => item.productId));
    assert.equal(
      secondPage.items.some((item) => firstIds.has(item.productId)),
      false,
      "Readiness cursor must paginate by product ID without duplicates",
    );

    const runs = await repository.listProfileBackfills(10);
    assert.ok(runs.length >= 1);
    const detail = await repository.getProfileBackfill(runs[0].id);
    assert.ok(detail);
    assert.equal(detail.run.status, "applied");
    assert.ok(detail.items.some((item) => item.applyStatus === "applied"));
    assert.ok(
      detail.items.some(
        (item) => item.exactGtin === "04628837736075"
          && item.appliedProfileId !== null,
      ),
    );

    const events = await repository.listEvents({
      limit: 100,
      source: "product_readiness",
    });
    assert.ok(
      events.items.some(
        (item) => item.productProfileId !== null && item.processId === null,
      ),
    );

    assertNoSecretFields({
      pilotPage,
      conflicts,
      conflictProducts,
      firstPage,
      secondPage,
      runs,
      detail,
      events,
    });
    console.log("Stage 4 read models, conflicts, cursor and safe projection checks passed");
  } finally {
    await closeServerDatabasePool();
  }
}

function assertNoSecretFields(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "payload_envelope",
    "payloadEnvelope",
    "signature_envelope",
    "signatureEnvelope",
    "fullMarkingCode",
    "plaintextCode",
    "service_role",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `Projection contains ${forbidden}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
