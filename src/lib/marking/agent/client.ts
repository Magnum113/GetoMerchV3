import { readFile } from "node:fs/promises";
import {
  AGENT_HEADERS,
  createAgentRequestAuth,
  decodeAgentSecret,
  MARKING_AGENT_API_PATH,
  MarkingAgentProtocolError,
  verifyAgentResponseAuth,
  type MarkingAgentRequestBody,
} from "@/lib/marking/agent/protocol";

export async function loadMarkingAgentSecret(path: string) {
  if (!path.startsWith("/")) {
    throw new MarkingAgentProtocolError("agent_credential_unavailable", "Agent credential path must be absolute");
  }
  try {
    return decodeAgentSecret(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof MarkingAgentProtocolError) throw error;
    throw new MarkingAgentProtocolError("agent_credential_unavailable", "Agent credential is unavailable", { cause: error });
  }
}

export async function sendMarkingAgentRequest(input: {
  serverUrl: string;
  agentId: string;
  secret: Uint8Array;
  body: MarkingAgentRequestBody;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const url = new URL(MARKING_AGENT_API_PATH, normalizedServerUrl(input.serverUrl));
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new MarkingAgentProtocolError("agent_server_url_invalid", "Agent server URL must use HTTPS");
  }
  const body = JSON.stringify(input.body);
  const auth = createAgentRequestAuth({
    method: "POST",
    pathname: url.pathname,
    agentId: input.agentId,
    body,
    secret: input.secret,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2_000, Math.min(60_000, input.timeoutMs ?? 15_000)));
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...auth.headers,
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    throw new MarkingAgentProtocolError("agent_server_unavailable", "Marking server is unavailable", { cause: error });
  } finally {
    clearTimeout(timer);
  }
  const responseBody = await readLimitedResponse(response, 400_000);
  verifyAgentResponseAuth({
    status: response.status,
    expectedRequestId: auth.requestId,
    headers: Object.fromEntries([
      AGENT_HEADERS.requestId,
      AGENT_HEADERS.responseIssuedAt,
      AGENT_HEADERS.responseSignature,
    ].map((name) => [name, response.headers.get(name) ?? undefined])),
    body: responseBody,
    secret: input.secret,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch (error) {
    throw new MarkingAgentProtocolError("agent_response_invalid", "Marking server returned invalid JSON", { cause: error });
  }
  if (!response.ok) {
    const code = isRecord(parsed) && typeof parsed.error === "string"
      ? parsed.error.slice(0, 120)
      : "agent_server_error";
    throw new MarkingAgentProtocolError(code, "Marking server rejected the agent request");
  }
  return parsed;
}

function normalizedServerUrl(value: string) {
  const normalized = value.trim();
  if (!normalized) throw new MarkingAgentProtocolError("agent_server_url_invalid", "Agent server URL is required");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

async function readLimitedResponse(response: Response, maximum: number) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maximum) {
    throw new MarkingAgentProtocolError("agent_response_too_large", "Marking server response is too large");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maximum) {
    throw new MarkingAgentProtocolError("agent_response_too_large", "Marking server response is too large");
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
