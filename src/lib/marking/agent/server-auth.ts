import "server-only";

import { readFile } from "node:fs/promises";
import {
  AGENT_HEADERS,
  decodeAgentSecret,
  MarkingAgentProtocolError,
  verifyAgentRequestAuth,
} from "@/lib/marking/agent/protocol";

type AgentSecretsFile = {
  version: 1;
  agents: Record<string, string>;
};

let cachedPath = "";
let cachedSource: Promise<AgentSecretsFile> | null = null;

export async function authenticateMarkingAgentRequest(input: {
  method: string;
  pathname: string;
  headers: Headers;
  body: string;
  secretsFile: string;
}) {
  const agentId = input.headers.get(AGENT_HEADERS.agentId)?.trim() ?? "";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(agentId)) {
    throw new MarkingAgentProtocolError("agent_auth_failed", "Agent authentication failed");
  }
  const source = await loadAgentSecretsFile(input.secretsFile);
  const encoded = source.agents[agentId];
  if (!encoded) {
    throw new MarkingAgentProtocolError("agent_auth_failed", "Agent authentication failed");
  }
  const secret = decodeAgentSecret(encoded);
  try {
    const envelope = verifyAgentRequestAuth({
      method: input.method,
      pathname: input.pathname,
      headers: Object.fromEntries(
        Object.values(AGENT_HEADERS).map((name) => [name, input.headers.get(name) ?? undefined]),
      ),
      body: input.body,
      secret,
    });
    return { envelope, secret };
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

async function loadAgentSecretsFile(path: string) {
  if (!path.startsWith("/")) {
    throw new MarkingAgentProtocolError("agent_credential_unavailable", "Agent credential is unavailable");
  }
  if (!cachedSource || cachedPath !== path) {
    cachedPath = path;
    cachedSource = readAndParse(path).catch((error) => {
      cachedSource = null;
      throw error;
    });
  }
  return cachedSource;
}

async function readAndParse(path: string): Promise<AgentSecretsFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new MarkingAgentProtocolError(
      "agent_credential_unavailable",
      "Agent credential is unavailable",
      { cause: error },
    );
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.agents)) {
    throw new MarkingAgentProtocolError("agent_credential_invalid", "Agent credential is invalid");
  }
  const agents: Record<string, string> = {};
  for (const [agentId, encoded] of Object.entries(parsed.agents)) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(agentId) || typeof encoded !== "string") {
      throw new MarkingAgentProtocolError("agent_credential_invalid", "Agent credential is invalid");
    }
    const secret = decodeAgentSecret(encoded);
    secret.fill(0);
    agents[agentId] = encoded.trim();
  }
  if (Object.keys(agents).length < 1 || Object.keys(agents).length > 20) {
    throw new MarkingAgentProtocolError("agent_credential_invalid", "Agent credential is invalid");
  }
  return { version: 1, agents };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
