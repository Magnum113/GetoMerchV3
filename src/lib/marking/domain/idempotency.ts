import { createHash } from "node:crypto";
import { MarkingDomainError } from "@/lib/marking/domain/errors";

export function markingIdempotencyKey(operation: string, scope: string) {
  const normalizedOperation = operation.trim();
  const normalizedScope = scope.trim();
  if (
    !/^[a-z0-9._:-]{3,100}$/i.test(normalizedOperation)
    || normalizedScope.length < 1
    || normalizedScope.length > 500
  ) {
    throw new MarkingDomainError(
      "invalid_idempotency_scope",
      "Invalid marking idempotency operation or scope",
    );
  }
  const digest = createHash("sha256")
    .update(`${normalizedOperation}\u0000${normalizedScope}`)
    .digest("hex");
  return `marking:${normalizedOperation}:${digest}`;
}
