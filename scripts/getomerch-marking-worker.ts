#!/usr/bin/env node

import { runMarkingWorker } from "@/lib/marking/worker";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

runMarkingWorker().catch((error) => {
  console.error("[marking-worker] fatal", safeErrorForLog(error));
  process.exitCode = 1;
});
