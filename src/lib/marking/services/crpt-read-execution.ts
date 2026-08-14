import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { queryServerDatabase } from "@/lib/db/pool";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import {
  CrptApiError,
  CrptTokenManager,
  CrptTrueApiClient,
} from "@/lib/marking/adapters/crpt/client";
import {
  CrptContractError,
  normalizeCrptCodeState,
} from "@/lib/marking/adapters/crpt/contracts";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { extractIdentificationCode } from "@/lib/marking/domain/crpt-introduction";
import {
  claimCrptReadQuery,
  recordCrptReadFailure,
  recordCrptReadSuccess,
} from "@/lib/marking/repositories/crpt-read";
import { loadMarkingKeyring, type MarkingKeyring } from "@/lib/marking/security/keyring";
import { redactText } from "@/lib/marking/security/redaction";
import {
  loadMarkingSignerClient,
  type MarkingSignerClient,
} from "@/lib/marking/signer/client";
import { createRemoteMarkingSignerClient } from "@/lib/marking/signer/remote-client";

type CrptRuntime = {
  config: MarkingRuntimeConfig;
  query: DatabaseQueryExecutor;
  keyring: MarkingKeyring;
  signer: MarkingSignerClient;
  tokens: CrptTokenManager;
  client: CrptTrueApiClient;
};

type ExecutionDependencies = Partial<CrptRuntime>;
let runtimePromise: Promise<CrptRuntime> | null = null;

export async function executeCrptAuthRefresh(
  context: JobExecutionContext,
  dependencies: ExecutionDependencies = {},
) {
  const runtime = await createRuntime(dependencies);
  assertActor(runtime.config, context.job.actor);
  await context.report({ phase: "authenticating" }, "crpt_auth_started");
  await runtime.tokens.getToken(true);
  const status = runtime.tokens.status();
  await context.report({ phase: "authenticated", ...status }, "crpt_auth_succeeded");
  return { authenticated: true, ...status, contour: runtime.config.crptContour };
}

export async function executeCrptReadQuery(
  context: JobExecutionContext,
  dependencies: ExecutionDependencies = {},
) {
  const queryId = requiredUuid(context.job.payload.queryId, "queryId");
  const runtime = await createRuntime(dependencies);
  assertActor(runtime.config, context.job.actor);
  let claimed = false;
  try {
    const query = await claimCrptReadQuery(runtime.query, queryId, context.job.actor);
    claimed = true;
    await context.report({ phase: "requesting", queryId, queryType: query.query_type }, "crpt_read_started");
    if (query.query_type === "code_status") {
      const result = await executeCodeStatus(runtime, query);
      await context.report({ phase: "completed", queryId, status: result.status }, "crpt_code_status_checked");
      return { queryId, queryType: query.query_type, ...result };
    }
    if (!query.external_document_id) {
      throw new CrptContractError("crpt_query_invalid", "CRPT document query is incomplete");
    }
    const document = await runtime.client.getDocumentStatus(
      query.external_document_id,
      query.product_group,
    );
    const status = await recordCrptReadSuccess(runtime.query, {
      queryId,
      normalizedStatus: document.status,
      rawStatus: document.status,
      result: {
        documentId: document.externalDocumentId,
        number: document.number,
        type: document.type,
        productGroup: document.productGroup,
      },
      ownerMatches: null,
      gtinMatches: null,
    });
    await context.report({ phase: "completed", queryId, status }, "crpt_document_status_checked");
    return {
      queryId,
      queryType: query.query_type,
      status,
      normalizedStatus: document.status,
    };
  } catch (error) {
    if (claimed) {
      const safe = safeExecutionError(error);
      await recordCrptReadFailure(runtime.query, {
        queryId,
        errorCode: safe.code,
        errorMessage: safe.message,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export function isRetryableCrptError(error: unknown) {
  if (error instanceof CrptApiError) return error.retryable;
  const code = nestedCode(error);
  return [
    "signer_timeout",
    "signer_unavailable",
    "provider_pin_unavailable",
    "provider_unavailable",
    "provider_timeout",
    "signer_remote_pending",
    "signer_remote_expired",
    "signer_remote_failed",
  ].includes(code);
}

async function executeCodeStatus(
  runtime: CrptRuntime,
  query: Awaited<ReturnType<typeof claimCrptReadQuery>>,
) {
  if (
    !query.marking_code_id
    || !query.gtin_snapshot
    || !query.code_ciphertext
    || !query.code_nonce
    || !query.code_auth_tag
    || !query.encryption_key_version
  ) {
    throw new CrptContractError("crpt_query_invalid", "CRPT code query material is incomplete");
  }
  const encrypted = {
    algorithm: "aes-256-gcm" as const,
    keyVersion: query.encryption_key_version,
    ciphertext: query.code_ciphertext.toString("base64"),
    iv: query.code_nonce.toString("base64"),
    authTag: query.code_auth_tag.toString("base64"),
  };
  const code = runtime.keyring.decryptBytes(encrypted);
  let identificationCode: Buffer | null = null;
  try {
    identificationCode = Buffer.from(extractIdentificationCode(code), "ascii");
    const remote = await runtime.client.getCodeStatus(
      identificationCode,
      query.product_group,
    );
    if (remote.errorCode) {
      throw new CrptApiError(
        "crpt_code_status_error",
        redactText(remote.errorMessage ?? "ГИС МТ не вернула статус КМ"),
        false,
      );
    }
    const rawStatus = [remote.status, remote.statusEx].filter(Boolean).join(":").slice(0, 300)
      || "UNKNOWN";
    const normalized = normalizeCrptCodeState(remote.status);
    const ownerMatches = runtime.config.crptInn
      ? remote.ownerInn === runtime.config.crptInn
      : null;
    const gtinMatches = remote.gtin === query.gtin_snapshot;
    const status = await recordCrptReadSuccess(runtime.query, {
      queryId: query.query_id,
      normalizedStatus: normalized,
      rawStatus,
      result: {
        gtin: remote.gtin,
        productGroup: remote.productGroup,
        status: remote.status,
        statusEx: remote.statusEx,
        ownerInnMatches: ownerMatches,
        gtinMatches,
      },
      ownerMatches,
      gtinMatches,
    });
    return { status, normalizedStatus: normalized, fingerprint: query.fingerprint };
  } finally {
    code.fill(0);
    identificationCode?.fill(0);
    query.code_ciphertext.fill(0);
    query.code_nonce.fill(0);
    query.code_auth_tag.fill(0);
  }
}

async function createRuntime(dependencies: ExecutionDependencies): Promise<CrptRuntime> {
  if (Object.keys(dependencies).length > 0) {
    const config = dependencies.config ?? getMarkingRuntimeConfig();
    const query = dependencies.query ?? queryServerDatabase;
    const keyring = dependencies.keyring ?? await loadMarkingKeyring(config.keyringFile);
    const signer = dependencies.signer ?? (
      config.signerTransport === "remote"
        ? createRemoteMarkingSignerClient({ query, keyring })
        : await loadMarkingSignerClient({
            socketPath: config.signerSocketPath,
            caller: config.signerClientId,
            secretFile: config.signerClientSecretFile,
          })
    );
    const tokens = dependencies.tokens ?? new CrptTokenManager({
      contour: config.crptContour,
      inn: config.crptInn || undefined,
      signer,
    });
    return {
      config,
      query,
      signer,
      tokens,
      client: dependencies.client ?? new CrptTrueApiClient({
        contour: config.crptContour,
        tokenManager: tokens,
      }),
      keyring,
    };
  }
  if (!runtimePromise) {
    runtimePromise = createRuntime({ query: queryServerDatabase }).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function assertActor(config: MarkingRuntimeConfig, actor: string) {
  if (!config.enabled || !config.crptReadEnabled || !config.signerEnabled) {
    throw new CrptContractError("crpt_read_disabled", "CRPT read-only integration is disabled");
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new CrptContractError("crpt_actor_denied", "CRPT operator is not allowed");
  }
}

function requiredUuid(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new CrptContractError("crpt_job_payload_invalid", `CRPT job ${name} is invalid`);
  }
  return value;
}

function safeExecutionError(error: unknown) {
  const code = nestedCode(error).slice(0, 120) || "crpt_read_failed";
  const message = redactText(error instanceof Error ? error.message : "CRPT read failed")
    .slice(0, 500) || "CRPT read failed";
  return { code, message };
}

function nestedCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return "crpt_read_failed";
}
