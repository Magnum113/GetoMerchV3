import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MARKING_PROCESS_STATUSES,
  type MarkingProcessStatus,
} from "@/lib/marking/domain/states";
import {
  allowedMarkingProcessTransitions,
  assertMarkingProcessTransition,
  canTransitionMarkingProcess,
} from "@/lib/marking/domain/transitions";
import {
  assertProductProfileInvariant,
  isValidGtin14,
  normalizeGtin14,
} from "@/lib/marking/domain/invariants";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { markingIdempotencyKey } from "@/lib/marking/domain/idempotency";
import {
  decodeMarkingCursor,
  encodeMarkingCursor,
  InvalidMarkingCursorError,
} from "@/lib/marking/read-models/cursor";

const EXPECTED_TRANSITIONS: Record<
  MarkingProcessStatus,
  readonly MarkingProcessStatus[]
> = {
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

for (const from of MARKING_PROCESS_STATUSES) {
  assert.deepEqual(allowedMarkingProcessTransitions(from), EXPECTED_TRANSITIONS[from]);
  for (const to of MARKING_PROCESS_STATUSES) {
    const expected = EXPECTED_TRANSITIONS[from].includes(to);
    assert.equal(canTransitionMarkingProcess(from, to), expected, `${from} -> ${to}`);
    if (expected) {
      assert.doesNotThrow(() => assertMarkingProcessTransition(from, to));
    } else {
      assert.throws(
        () => assertMarkingProcessTransition(from, to),
        (error) =>
          error instanceof MarkingDomainError
          && error.code === "invalid_process_transition",
      );
    }
  }
}

assert.equal(isValidGtin14("04628837736075"), true);
assert.equal(isValidGtin14("04628837736074"), false);
assert.equal(isValidGtin14("00000000000000"), false);
assert.equal(normalizeGtin14("4628837736075"), "04628837736075");
assert.throws(() => normalizeGtin14("04628837736074"), MarkingDomainError);

assert.doesNotThrow(() => assertProductProfileInvariant({
  requiresMarking: true,
  productionMode: "own_production",
  fulfillmentMarkingMode: "jit_after_order",
  verificationStatus: "verified",
  tradeItemId: "trade-item",
  verifiedProductMappingEvidenceCount: 1,
}));
assert.throws(
  () => assertProductProfileInvariant({
    requiresMarking: true,
    productionMode: "own_production",
    fulfillmentMarkingMode: "jit_after_order",
    verificationStatus: "verified",
    verifiedProductMappingEvidenceCount: 0,
  }),
  MarkingDomainError,
);
assert.throws(
  () => assertProductProfileInvariant({
    requiresMarking: true,
    productionMode: "pre_marked_minor_customization",
    fulfillmentMarkingMode: "jit_after_order",
    verificationStatus: "draft",
  }),
  MarkingDomainError,
);

const idempotencyLeft = markingIdempotencyKey("process.create", "ozon:123");
const idempotencyRight = markingIdempotencyKey("process.create", "ozon:123");
assert.equal(idempotencyLeft, idempotencyRight);
assert.notEqual(idempotencyLeft, markingIdempotencyKey("process.create", "ozon:124"));

const cursor = encodeMarkingCursor(
  "processes",
  "2026-07-26T10:00:00.000Z",
  "6f8f873d-884c-42df-a126-a27928fbb3b4",
);
assert.deepEqual(decodeMarkingCursor(cursor, "processes"), {
  timestamp: "2026-07-26T10:00:00.000Z",
  id: "6f8f873d-884c-42df-a126-a27928fbb3b4",
});
assert.throws(
  () => decodeMarkingCursor(cursor, "events"),
  InvalidMarkingCursorError,
);
assert.throws(
  () => decodeMarkingCursor("<invalid>", "events"),
  InvalidMarkingCursorError,
);

const routePaths = [
  "src/app/api/admin/marking/readiness/route.ts",
  "src/app/api/admin/marking/processes/route.ts",
  "src/app/api/admin/marking/processes/[id]/route.ts",
  "src/app/api/admin/marking/events/route.ts",
];
for (const routePath of routePaths) {
  const source = read(routePath);
  assert.match(source, /await requireAdminSession\(\)/, `${routePath} requires auth`);
  assert.doesNotMatch(source, /export async function (POST|PUT|PATCH|DELETE)/);
}

const readRepository = read("src/lib/marking/read-models/repository.ts");
assert.doesNotMatch(readRepository, /SELECT\s+\*/i);
assert.doesNotMatch(readRepository, /payload_envelope/i);
assert.doesNotMatch(readRepository, /signature_envelope/i);
assert.doesNotMatch(readRepository, /code_ciphertext/i);
assert.doesNotMatch(readRepository, /code_auth_tag/i);
assert.doesNotMatch(readRepository, /code_hmac/i);
assert.doesNotMatch(readRepository, /\bserial\b/i);
assert.match(readRepository, /marking_code_id/i);
assert.match(readRepository, /options\.limit \+ 1/g);
assert.match(readRepository, /encodeMarkingCursor/g);

console.log("Stage 3 marking domain, API and projection checks passed");

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}
