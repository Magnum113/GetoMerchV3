#!/usr/bin/env node

import { runBackgroundWorker } from "@/lib/jobs/worker";

runBackgroundWorker().catch((error) => {
  console.error("[worker] fatal", {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
