#!/usr/bin/env node

import { runBackgroundWorker } from "@/lib/jobs/worker";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

runBackgroundWorker().catch((error) => {
  console.error("[worker] fatal", safeErrorForLog(error));
  process.exitCode = 1;
});
