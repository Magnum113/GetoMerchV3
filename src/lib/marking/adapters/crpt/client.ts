import "server-only";

import {
  parseCrptAuthChallenge,
  parseCrptAuthToken,
  parseCrptCodeInfo,
  parseCrptDocumentStatus,
  parseCrptDocumentCreate,
  CrptContractError,
} from "@/lib/marking/adapters/crpt/contracts";
import type { MarkingCrptContour } from "@/lib/marking/config";
import { redactText } from "@/lib/marking/security/redaction";
import type { MarkingSignerClient } from "@/lib/marking/signer/client";

type FetchLike = typeof fetch;

const CONTOUR_HOSTS = {
  sandbox: "https://markirovka.sandbox.crptech.ru",
  production: "https://markirovka.crpt.ru",
} as const satisfies Record<MarkingCrptContour, string>;

export class CrptApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CrptApiError";
  }
}

export class CrptTokenManager {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshPromise: Promise<{ value: string; expiresAt: number }> | null = null;
  private certificate: { thumbprint: string; validTo: string } | null = null;

  constructor(private readonly input: {
    contour: MarkingCrptContour;
    inn?: string;
    omsConnection?: string;
    signer: MarkingSignerClient;
    fetch?: FetchLike;
    now?: () => number;
    timeoutMs?: number;
  }) {}

  async getToken(forceRefresh = false) {
    const now = (this.input.now ?? Date.now)();
    if (!forceRefresh && this.token && this.token.expiresAt - now > 5 * 60_000) {
      return this.token;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  invalidate() {
    this.token = null;
  }

  status() {
    return {
      tokenExpiresAt: this.token ? new Date(this.token.expiresAt).toISOString() : null,
      certificate: this.certificate,
    };
  }

  private async refresh() {
    const base = `${CONTOUR_HOSTS[this.input.contour]}/api/v3/true-api`;
    const challenge = parseCrptAuthChallenge(await requestJson(
      this.input.fetch ?? fetch,
      `${base}/auth/key`,
      { method: "GET", headers: { Accept: "application/json" } },
      this.input.timeoutMs,
    ));
    try {
      const signed = await this.input.signer.sign(
        challenge.bytes,
        "crpt_auth_attached_cades_bes",
      );
      const body: Record<string, unknown> = {
        uuid: challenge.uuid,
        data: signed.signatureBase64,
      };
      if (!this.input.omsConnection) body.unitedToken = true;
      if (this.input.inn) body.inn = this.input.inn;
      const signInPath = this.input.omsConnection
        ? `/auth/simpleSignIn/${encodeURIComponent(this.input.omsConnection)}`
        : "/auth/simpleSignIn";
      const response = await requestJson(
        this.input.fetch ?? fetch,
        `${base}${signInPath}`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        this.input.timeoutMs,
      );
      const parsed = parseCrptAuthToken(response, (this.input.now ?? Date.now)());
      this.certificate = {
        thumbprint: signed.certificate.thumbprint,
        validTo: signed.certificate.validTo,
      };
      this.token = { value: parsed.token, expiresAt: parsed.expiresAt };
      return this.token;
    } finally {
      challenge.bytes.fill(0);
    }
  }
}

export class CrptTrueApiClient {
  constructor(private readonly input: {
    contour: MarkingCrptContour;
    tokenManager: CrptTokenManager;
    fetch?: FetchLike;
    timeoutMs?: number;
  }) {}

  async getCodeStatus(markingCode: Uint8Array, productGroup = "lp") {
    const code = Buffer.from(markingCode);
    try {
      const response = await this.authorizedJson(
        `${this.baseV3()}/cises/info?pg=${encodeURIComponent(productGroup)}`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify([code.toString("utf8")]),
        },
      );
      return parseCrptCodeInfo(response);
    } finally {
      code.fill(0);
    }
  }

  async getDocumentStatus(
    externalDocumentId: string,
    productGroup = "lp",
    options: { includeContent?: boolean } = {},
  ) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(externalDocumentId)) {
      throw new CrptContractError("crpt_document_id_invalid", "CRPT document ID is invalid");
    }
    const response = await this.authorizedJson(
      `${this.baseV4()}/doc/${encodeURIComponent(externalDocumentId)}/info?pg=${encodeURIComponent(productGroup)}&body=false&content=${options.includeContent === true ? "true" : "false"}`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    return parseCrptDocumentStatus(response, externalDocumentId);
  }

  async createManualDocument(input: {
    documentType: "LP_INTRODUCE_GOODS" | "LK_RECEIPT" | "LP_RETURN";
    productDocument: Uint8Array;
    detachedSignatureBase64: string;
    productGroup?: "lp";
  }) {
    const document = Buffer.from(input.productDocument);
    try {
      if (
        !/^[A-Za-z0-9+/]+={0,2}$/.test(input.detachedSignatureBase64)
        || input.detachedSignatureBase64.length % 4 !== 0
        || input.detachedSignatureBase64.length > 350_000
      ) {
        throw new CrptContractError("crpt_signature_invalid", "CRPT signature is invalid");
      }
      const response = await this.authorizedJson(
        `${this.baseV3()}/lk/documents/create?pg=${encodeURIComponent(input.productGroup ?? "lp")}`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            document_format: "MANUAL",
            product_document: document.toString("base64"),
            type: input.documentType,
            signature: input.detachedSignatureBase64,
          }),
        },
        "document_id",
      );
      return parseCrptDocumentCreate(response);
    } finally {
      document.fill(0);
    }
  }

  private async authorizedJson(
    url: string,
    init: RequestInit,
    responseMode: "json" | "document_id" = "json",
  ) {
    let token = await this.input.tokenManager.getToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await requestJson(
          this.input.fetch ?? fetch,
          url,
          {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${token.value}` },
          },
          this.input.timeoutMs,
          responseMode,
        );
      } catch (error) {
        if (!(error instanceof CrptApiError) || error.status !== 401 || attempt > 0) throw error;
        this.input.tokenManager.invalidate();
        token = await this.input.tokenManager.getToken(true);
      }
    }
    throw new CrptApiError("crpt_auth_failed", "CRPT authentication failed", false, 401);
  }

  private baseV3() {
    return `${CONTOUR_HOSTS[this.input.contour]}/api/v3/true-api`;
  }

  private baseV4() {
    return `${CONTOUR_HOSTS[this.input.contour]}/api/v4/true-api`;
  }
}

async function requestJson(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
  responseMode: "json" | "document_id" = "json",
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(60_000, timeoutMs)));
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (error) {
    throw new CrptApiError(
      "crpt_network_error",
      error instanceof Error && error.name === "AbortError"
        ? "CRPT request timed out"
        : "CRPT request failed",
      true,
      null,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (text.length > 1_048_576) {
    throw new CrptApiError("crpt_response_too_large", "CRPT response is too large", false, response.status);
  }
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      const normalized = text.trim();
      if (
        response.ok
        && responseMode === "document_id"
        && /^[A-Za-z0-9._:-]{1,200}$/.test(normalized)
      ) {
        payload = { id: normalized };
      } else {
        throw new CrptApiError(
          "crpt_response_invalid",
          "CRPT returned invalid JSON",
          response.status >= 500,
          response.status,
          { cause: error },
        );
      }
    }
  }
  if (!response.ok) {
    throw new CrptApiError(
      response.status === 401 ? "crpt_token_expired" : `crpt_http_${response.status}`,
      publicCrptError(payload, response.status),
      response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  return payload;
}

function publicCrptError(payload: unknown, status: number) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const value = payload as Record<string, unknown>;
    const candidate = value.error_message ?? value.description;
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 500) {
      return redactText(candidate).replace(/[\u0000\r\n]/g, " ").slice(0, 500);
    }
  }
  return `CRPT request failed with HTTP ${status}`;
}
