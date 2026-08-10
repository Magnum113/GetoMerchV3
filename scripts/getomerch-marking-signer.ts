#!/usr/bin/env node

import { runMarkingSigner } from "@/lib/marking/signer";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

runMarkingSigner().catch((error) => {
  console.error("[marking-signer] fatal", safeErrorForLog(error));
  process.exitCode = 1;
});
