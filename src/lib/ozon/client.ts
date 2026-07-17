import "server-only";

const OZON_BASE_URL = "https://api-seller.ozon.ru";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 4;

export class OzonApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly code: string;

  constructor(
    message: string,
    options: { status?: number | null; retryable?: boolean; code?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "OzonApiError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.code = options.code ?? "ozon_api_error";
  }
}

export async function ozonPost<T>(
  path: string,
  body: unknown,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    attempts?: number;
    onRetry?: (details: { path: string; attempt: number; delayMs: number; status: number | null }) => void | Promise<void>;
  } = {},
): Promise<T> {
  const credentials = ozonCredentials();
  const attempts = clampInteger(options.attempts ?? DEFAULT_ATTEMPTS, 1, 6);
  const timeoutMs = clampInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 60_000);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw cancelledError(options.signal.reason);
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetch(`${ozonBaseUrl()}${path}`, {
        method: "POST",
        headers: {
          "Client-Id": credentials.clientId,
          "Api-Key": credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const error = new OzonApiError(
          `Ozon ${path} returned ${response.status}${text ? `: ${sanitizeBody(text)}` : ""}`,
          {
            status: response.status,
            retryable,
            code: `ozon_http_${response.status}`,
          },
        );
        if (!retryable || attempt >= attempts) throw error;
        const delayMs = retryAfter ?? retryDelay(attempt);
        await options.onRetry?.({ path, attempt, delayMs, status: response.status });
        await abortableSleep(delayMs, options.signal);
        lastError = error;
        continue;
      }
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new OzonApiError(`Ozon ${path} returned invalid JSON`, {
          status: response.status,
          retryable: false,
          code: "ozon_invalid_json",
          cause: error,
        });
      }
    } catch (error) {
      if (error instanceof OzonApiError) throw error;
      if (options.signal?.aborted) throw cancelledError(options.signal.reason);
      const retryable = isTransientNetworkError(error);
      const wrapped = new OzonApiError(
        retryable ? `Ozon ${path} request failed temporarily` : `Ozon ${path} request failed`,
        {
          retryable,
          code: retryable ? "ozon_network_error" : "ozon_request_error",
          cause: error,
        },
      );
      lastError = wrapped;
      if (!retryable || attempt >= attempts) throw wrapped;
      const delayMs = retryDelay(attempt);
      await options.onRetry?.({ path, attempt, delayMs, status: null });
      await abortableSleep(delayMs, options.signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new OzonApiError("Ozon request failed", { retryable: true });
}

export function isRetryableOzonError(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof OzonApiError) return current.retryable;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function ozonCredentials() {
  const clientId = process.env.OZON_CLIEN_ID?.trim() || process.env.OZON_CLIENT_ID?.trim();
  const apiKey = process.env.OZON_API_KEY?.trim();
  if (!clientId || !apiKey) {
    throw new OzonApiError("Ozon API credentials are not configured", {
      retryable: false,
      code: "ozon_credentials_missing",
    });
  }
  return { clientId, apiKey };
}

function ozonBaseUrl() {
  const override = process.env.GETOMERCH_OZON_API_BASE_URL?.trim();
  if (!override) return OZON_BASE_URL;
  if (process.env.GETOMERCH_ALLOW_OZON_BASE_URL_OVERRIDE !== "true") {
    throw new OzonApiError("Ozon API base URL override is disabled", {
      code: "ozon_base_url_override_disabled",
    });
  }
  const url = new URL(override);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new OzonApiError("Ozon API base URL override must use local HTTP", {
      code: "ozon_base_url_override_invalid",
    });
  }
  return override.replace(/\/$/, "");
}

function isTransientNetworkError(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|fetch failed|network|econnreset|econnrefused|enotfound|eai_again|socket/i.test(message);
}

function retryDelay(attempt: number) {
  return Math.min(10_000, 300 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 200));
}

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.min(30_000, date - Date.now()));
}

function sanitizeBody(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) throw new Error("Invalid Ozon client integer option");
  const integer = Math.trunc(value);
  return Math.max(min, Math.min(max, integer));
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal) {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) {
      clearTimeout(timer);
      reject(cancelledError(signal.reason));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelledError(cause: unknown) {
  return new OzonApiError("Ozon operation was cancelled", {
    retryable: false,
    code: "job_cancelled",
    cause,
  });
}
