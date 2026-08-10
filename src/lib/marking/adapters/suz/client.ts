import "server-only";

import type { MarkingCrptContour } from "@/lib/marking/config";
import {
  parseSuzCodeBlocks,
  parseSuzCodes,
  parseSuzOrderCreated,
  parseSuzOrderStatus,
  parseSuzUtilisationReceipt,
} from "@/lib/marking/adapters/suz/contracts";
import type { CrptTokenManager } from "@/lib/marking/adapters/crpt/client";
import { redactText } from "@/lib/marking/security/redaction";

type FetchLike = typeof fetch;

const SUZ_HOSTS = {
  sandbox: "https://suz.sandbox.crptech.ru",
  production: "https://suzgrid.crpt.ru",
} as const satisfies Record<MarkingCrptContour, string>;

export class SuzApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly outcomeUnknown: boolean,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SuzApiError";
  }
}

export class SuzPendingError extends Error {
  readonly code = "suz_result_pending";
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "SuzPendingError";
  }
}

export class SuzApiClient {
  constructor(private readonly input: {
    contour: MarkingCrptContour;
    omsId: string;
    tokenManager: CrptTokenManager;
    fetch?: FetchLike;
    timeoutMs?: number;
  }) {}

  async createOrder(body: Uint8Array, detachedSignatureBase64: string) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(detachedSignatureBase64)
        || detachedSignatureBase64.length < 80
        || detachedSignatureBase64.length > 180_000) {
      throw new SuzApiError("suz_signature_invalid", "SUZ signature is invalid", false, false);
    }
    const payload = Buffer.from(body);
    try {
      const response = await this.authorizedJson(
        `${this.base()}/api/v3/order?omsId=${encodeURIComponent(this.input.omsId)}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Signature": detachedSignatureBase64,
          },
          body: new Uint8Array(payload),
        },
        { mutation: true },
      );
      return parseSuzOrderCreated(response);
    } finally {
      payload.fill(0);
    }
  }

  async getOrderStatus(orderId: string, gtin: string) {
    const response = await this.authorizedJson(
      `${this.base()}/api/v3/order/status?omsId=${encodeURIComponent(this.input.omsId)}`
        + `&orderId=${encodeURIComponent(orderId)}&gtin=${encodeURIComponent(gtin)}`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    return parseSuzOrderStatus(response, gtin);
  }

  async getCodes(orderId: string, gtin: string, quantity: number) {
    const response = await this.authorizedJson(
      `${this.base()}/api/v3/codes?omsId=${encodeURIComponent(this.input.omsId)}`
        + `&orderId=${encodeURIComponent(orderId)}&quantity=${quantity}`
        + `&gtin=${encodeURIComponent(gtin)}`,
      { method: "GET", headers: { Accept: "application/json" } },
      { mutation: true, maximumBytes: 4 * 1024 * 1024 },
    );
    return parseSuzCodes(response, quantity);
  }

  async getCodesByBlock(blockId: string, expectedQuantity: number) {
    const response = await this.authorizedJson(
      `${this.base()}/api/v3/order/codes/retry?omsId=${encodeURIComponent(this.input.omsId)}`
        + `&blockId=${encodeURIComponent(blockId)}`,
      { method: "GET", headers: { Accept: "application/json" } },
      { maximumBytes: 4 * 1024 * 1024 },
    );
    return parseSuzCodes(response, expectedQuantity);
  }

  async listCodeBlocks(orderId: string, gtin: string) {
    const response = await this.authorizedJson(
      `${this.base()}/api/v3/order/codes/blocks?omsId=${encodeURIComponent(this.input.omsId)}`
        + `&orderId=${encodeURIComponent(orderId)}&gtin=${encodeURIComponent(gtin)}`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    return parseSuzCodeBlocks(response, orderId, gtin);
  }

  async findUtilisationReceipt(orderId: string, gtin: string) {
    const response = await this.authorizedJson(
      `${this.base()}/api/v3/receipts/receipt/search?omsId=${encodeURIComponent(this.input.omsId)}`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: {
            orderIds: [orderId],
            productGroups: ["lp"],
            workflowTypes: ["REPORT_UTILIZE"],
          },
          limit: 10,
          skip: 1,
        }),
      },
    );
    return parseSuzUtilisationReceipt(response, gtin);
  }

  private async authorizedJson(
    url: string,
    init: RequestInit,
    options: { mutation?: boolean; maximumBytes?: number } = {},
  ) {
    let token = await this.input.tokenManager.getToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await requestJson(
          this.input.fetch ?? fetch,
          url,
          { ...init, headers: { ...init.headers, clientToken: token.value } },
          this.input.timeoutMs,
          options,
        );
      } catch (error) {
        if (!(error instanceof SuzApiError) || error.status !== 401 || attempt > 0) throw error;
        this.input.tokenManager.invalidate();
        token = await this.input.tokenManager.getToken(true);
      }
    }
    throw new SuzApiError("suz_auth_failed", "SUZ authentication failed", false, false, 401);
  }

  private base() {
    return SUZ_HOSTS[this.input.contour];
  }
}

async function requestJson(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
  options: { mutation?: boolean; maximumBytes?: number } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(60_000, timeoutMs)));
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (error) {
    throw new SuzApiError(
      "suz_network_error",
      error instanceof Error && error.name === "AbortError"
        ? "SUZ request timed out"
        : "SUZ request failed",
      !options.mutation,
      Boolean(options.mutation),
      null,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > (options.maximumBytes ?? 1_048_576)) {
    throw new SuzApiError(
      "suz_response_too_large",
      "SUZ response is too large",
      false,
      Boolean(options.mutation),
      response.status,
    );
  }
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new SuzApiError(
        "suz_response_invalid",
        "SUZ returned invalid JSON",
        !options.mutation && response.status >= 500,
        Boolean(options.mutation),
        response.status,
        { cause: error },
      );
    }
  }
  if (!response.ok) {
    throw new SuzApiError(
      response.status === 401 ? "suz_token_expired" : `suz_http_${response.status}`,
      publicSuzError(payload, response.status),
      !options.mutation && (
        response.status === 401 || response.status === 408
        || response.status === 429 || response.status >= 500
      ),
      Boolean(options.mutation && (response.status === 408 || response.status >= 500)),
      response.status,
    );
  }
  return payload;
}

function publicSuzError(payload: unknown, status: number) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    const candidate = row.error_message ?? row.description ?? row.message;
    if (typeof candidate === "string" && candidate.length > 0) {
      return redactText(candidate).replace(/[\u0000\r\n]/g, " ").slice(0, 500);
    }
  }
  return `SUZ request failed with HTTP ${status}`;
}
