#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { closeServerDatabasePool } from "@/lib/db/pool";
import { getJob } from "@/lib/jobs/queue";
import { getMarkingRuntimeConfig, type MarkingCrptContour } from "@/lib/marking/config";
import { safeErrorForLog } from "@/lib/marking/security/redaction";
import { requestCrptAuthRefresh } from "@/lib/marking/services/crpt-read-service";

const POLL_INTERVAL_MS = 1_000;
const TIMEOUT_MS = 180_000;

main()
  .catch((error) => {
    console.error("[stage9-canary] failed", safeErrorForLog(error));
    process.exitCode = 1;
  })
  .finally(() => closeServerDatabasePool());

async function main() {
  const expectedContour = parseExpectedContour(process.argv.slice(2));
  const config = getMarkingRuntimeConfig();
  assertReadOnlyRuntime(config, expectedContour);

  const actor = "owner";
  if (!config.allowedAdminIds.includes(actor)) {
    throw new Error("Stage 9 canary actor is not in the marking administrator allow-list");
  }

  const requestId = randomUUID();
  const queued = await requestCrptAuthRefresh({
    actor,
    sessionId: "stage9-readonly-canary",
    requestId,
    idempotencyKey: `stage9-readonly-auth:${expectedContour}:${requestId}`,
  }, { config });

  console.log("[stage9-canary] queued", {
    contour: expectedContour,
    jobId: queued.job.id,
    reused: queued.reused,
  });

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await getJob(queued.job.id);
    if (!job) throw new Error("Stage 9 canary job disappeared from the queue");
    if (job.status === "succeeded") {
      console.log("[stage9-canary] succeeded", {
        contour: expectedContour,
        jobId: job.id,
        attempts: job.attemptCount,
      });
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      throw Object.assign(
        new Error(job.errorMessage || `Stage 9 canary ended with status ${job.status}`),
        { code: job.errorCode || "stage9_canary_failed" },
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw Object.assign(new Error("Stage 9 canary timed out"), { code: "stage9_canary_timeout" });
}

function assertReadOnlyRuntime(
  config: ReturnType<typeof getMarkingRuntimeConfig>,
  expectedContour: MarkingCrptContour,
) {
  if (!config.enabled || !config.signerEnabled || !config.crptReadEnabled) {
    throw new Error("Stage 9 read-only flags are not enabled");
  }
  if (config.crptContour !== expectedContour) {
    throw new Error(`Expected ${expectedContour} contour, got ${config.crptContour}`);
  }
  if (!config.crptInn || config.allowedGtins.length === 0 || config.allowedAdminIds.length === 0) {
    throw new Error("Stage 9 CRPT identity or allow-lists are incomplete");
  }
  const unsafeFlags = [
    ["Ozon write", config.ozonWriteEnabled],
    ["CRPT write", config.crptWriteEnabled],
    ["CRPT introduction", config.crptIntroductionEnabled],
    ["withdrawal", config.withdrawalEnabled],
    ["returns", config.returnsEnabled],
    ["SUZ write", config.suzWriteEnabled],
    ["automation", config.automationEnabled],
  ].filter(([, enabled]) => enabled).map(([name]) => name);
  if (unsafeFlags.length > 0) {
    throw new Error(`Stage 9 canary refuses enabled write flags: ${unsafeFlags.join(", ")}`);
  }
}

function parseExpectedContour(args: string[]): MarkingCrptContour {
  if (args.length !== 1 || !args[0].startsWith("--contour=")) {
    throw new Error("Usage: run-marking-stage9-canary.ts --contour=sandbox|production");
  }
  const contour = args[0].slice("--contour=".length);
  if (contour !== "sandbox" && contour !== "production") {
    throw new Error("Stage 9 canary contour must be sandbox or production");
  }
  return contour;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
