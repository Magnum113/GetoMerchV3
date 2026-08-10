#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  OzonExemplarAdapter,
  OzonExemplarContractError,
} from "@/lib/marking/adapters/ozon/exemplars";
import { OZON_EXEMPLAR_ENDPOINTS } from "@/lib/marking/adapters/ozon/exemplar-contract";
import type { ozonPost } from "@/lib/ozon/client";

type Fixture = { request?: unknown; response?: unknown };

main().catch((error) => {
  console.error("Stage 8 Ozon exemplar checks failed", error);
  process.exitCode = 1;
});

async function main() {
  const create = await fixture("exemplar-create-or-get.success.json");
  const validate = await fixture("exemplar-validate.success.json");
  const set = await fixture("exemplar-set.request.json");
  const pending = await fixture("exemplar-status.validation-in-process.json");
  const accepted = await fixture("exemplar-status.ship-available.json");
  const update = await fixture("exemplar-update.request.json");
  const calls: Array<{ path: string; body: unknown }> = [];
  const responses = [
    create.response,
    validate.response,
    {},
    pending.response,
    accepted.response,
    {},
  ];
  const transport = (async (path: string, body: unknown) => {
    calls.push({ path, body });
    return responses.shift();
  }) as typeof ozonPost;
  const adapter = new OzonExemplarAdapter(transport);
  const code = Buffer.from(
    "]d2010460123456789021STAGE8-SYNTHETIC\u001d91ABCD\u001d92SYNTHETICSIGNATURE",
    "utf8",
  );
  try {
    const created = await adapter.createOrGetExemplars("SANITIZED-FBS-POSTING-1");
    assert.equal(created.products[0].exemplarIds[0], 1001);
    assert.equal(created.multiBoxQuantity, 0);
    const products = [{
      productId: 900000001,
      exemplars: [{ assignmentId: "assignment-1", exemplarId: 1001, markingCode: code }],
    }];
    const validated = await adapter.validateExemplars(created.postingNumber, products);
    assert.equal(validated[0].valid, true);
    await adapter.setExemplars(created.postingNumber, products, created.multiBoxQuantity);
    assert.equal((calls[2].body as { products: Array<{ exemplars: Array<{ marks: Array<{ mark: string }> }> }> })
      .products[0].exemplars[0].marks[0].mark, code.subarray(3).toString("utf8"));
    assert.equal(JSON.stringify(calls[2].body).includes("mandatory_mark"), true);
    assert.equal(JSON.stringify(set.request).includes("SANITIZED_FULL_MARKING_CODE"), true);
    assert.equal((await adapter.getExemplarStatus(created.postingNumber)).status, "validation_in_process");
    assert.equal((await adapter.getExemplarStatus(created.postingNumber)).status, "ship_available");
    await adapter.updateExemplars(created.postingNumber);
    assert.deepEqual(calls.map((call) => call.path), [
      OZON_EXEMPLAR_ENDPOINTS.createOrGet,
      OZON_EXEMPLAR_ENDPOINTS.validate,
      OZON_EXEMPLAR_ENDPOINTS.set,
      OZON_EXEMPLAR_ENDPOINTS.status,
      OZON_EXEMPLAR_ENDPOINTS.status,
      OZON_EXEMPLAR_ENDPOINTS.update,
    ]);
    assert.deepEqual(calls[0].body, create.request);
    assert.deepEqual(calls[5].body, update.request);

    const unknown = new OzonExemplarAdapter((async () => ({
      posting_number: "SANITIZED-FBS-POSTING-1",
      products: [],
      status: "new_undocumented_status",
    })) as typeof ozonPost);
    await assert.rejects(
      unknown.getExemplarStatus("SANITIZED-FBS-POSTING-1"),
      OzonExemplarContractError,
    );

    const executionSource = await readFile(
      "src/lib/marking/services/ozon-exemplar-execution.ts",
      "utf8",
    );
    assert.match(executionSource, /clearMaterials\(materials\)/);
    assert.match(executionSource, /status === "submitting"[\s\S]*getExemplarStatus/);
    assert.doesNotMatch(executionSource, /console\.(?:log|error).*markingCode/);
    const route = await readFile("src/app/api/admin/marking/ozon/route.ts", "utf8");
    assert.match(route, /requireMarkingMutationContext/);
    assert.match(route, /requestOzonExemplarOperation/);
    assert.match(route, /forceCorrection/);
    const markingPage = await readFile("src/app/marking/page.tsx", "utf8");
    assert.match(markingPage, /correctOzonBatch/);
    assert.match(markingPage, /ozon:correct:/);
    const migration = await readFile(
      "db/migrations/0012_marking_ozon_exemplars.sql",
      "utf8",
    );
    assert.match(migration, /order_binding\.label_state = 'applied'/);
    assert.match(migration, /LEFT JOIN LATERAL \([\s\S]*candidate\.assignment_id/);
    console.log("Stage 8 Ozon contract, unknown-status and duplicate-set safety checks passed");
  } finally {
    code.fill(0);
  }
}

async function fixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(`tests/fixtures/marking/ozon/${name}`, "utf8"));
}
