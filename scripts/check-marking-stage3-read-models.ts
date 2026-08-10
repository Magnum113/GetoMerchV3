import assert from "node:assert/strict";
import { closeServerDatabasePool } from "@/lib/db/pool";
import { PostgresMarkingReadRepository } from "@/lib/marking/read-models/repository";

async function main() {
  const repository = new PostgresMarkingReadRepository();
  try {
    const readiness = await repository.listReadiness({ limit: 2 });
    const processes = await repository.listProcesses({ limit: 1 });
    const events = await repository.listEvents({ limit: 1 });

    assertPage(readiness);
    assertPage(processes);
    assertPage(events);
    assertNoSecretFields({ readiness, processes, events });

    if (process.env.EXPECT_EMPTY_MARKING_SCHEMA === "true") {
      assert.equal(readiness.items.length, 0);
      assert.equal(processes.items.length, 0);
      assert.equal(events.items.length, 0);
      console.log("Stage 3 read models passed on an empty marking schema");
      return;
    }

    if (processes.items.length > 0) {
      const detail = await repository.getProcess(processes.items[0].id);
      assert.ok(detail);
      assert.equal(detail.process.id, processes.items[0].id);
      assertNoSecretFields(detail);
    }
    if (processes.page.hasMore) {
      assert.ok(processes.page.nextCursor);
      const second = await repository.listProcesses({
        limit: 1,
        cursor: processes.page.nextCursor,
      });
      assert.notEqual(second.items[0]?.id, processes.items[0]?.id);
    }
    if (events.page.hasMore) {
      assert.ok(events.page.nextCursor);
      const second = await repository.listEvents({
        limit: 1,
        cursor: events.page.nextCursor,
      });
      assert.notEqual(second.items[0]?.id, events.items[0]?.id);
    }
    console.log("Stage 3 read model SQL, cursor and safe projection checks passed");
  } finally {
    await closeServerDatabasePool();
  }
}

function assertPage(value: {
  items: unknown[];
  page: { hasMore: boolean; nextCursor: string | null };
}) {
  assert.ok(Array.isArray(value.items));
  assert.equal(typeof value.page.hasMore, "boolean");
  assert.ok(value.page.nextCursor === null || typeof value.page.nextCursor === "string");
}

function assertNoSecretFields(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "payload_envelope",
    "payloadEnvelope",
    "signature_envelope",
    "signatureEnvelope",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `Projection contains ${forbidden}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
