#!/usr/bin/env node

import { closeServerDatabasePool, queryServerDatabase } from "@/lib/db/pool";
import { scrubExpiredCodeImports } from "@/lib/marking/repositories/code-pool";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

main()
  .catch((error) => {
    console.error("[marking-import-scrub] failed", safeErrorForLog(error));
    process.exitCode = 1;
  })
  .finally(() => closeServerDatabasePool());

async function main() {
  const limit = readLimit();
  const scrubbedBatches = await scrubExpiredCodeImports(queryServerDatabase, limit);
  console.log("[marking-import-scrub] completed", { scrubbedBatches, limit });
}

function readLimit() {
  const raw = process.env.GETOMERCH_MARKING_IMPORT_SCRUB_LIMIT?.trim() || "500";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(
      "GETOMERCH_MARKING_IMPORT_SCRUB_LIMIT must be an integer between 1 and 1000",
    );
  }
  return value;
}
