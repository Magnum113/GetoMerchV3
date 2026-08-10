export type MarkingAgentRuntimeError = {
  code: string;
  message: string;
};

const CONNECTION_ERROR_CODES = new Set([
  "agent_auth_failed",
  "agent_endpoint_disabled",
  "agent_response_auth_failed",
  "agent_response_invalid",
  "agent_server_unavailable",
]);

export function clearRecoveredAgentConnectionError(
  error: MarkingAgentRuntimeError | null,
) {
  return error && CONNECTION_ERROR_CODES.has(error.code) ? null : error;
}
