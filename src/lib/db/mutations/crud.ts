import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";

export async function updateColumns(
  query: DatabaseQueryExecutor,
  table: string,
  id: string,
  patch: Record<string, unknown>,
) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const assignments = entries.map(([column], index) => `${column} = $${index + 2}`);
  await query(
    `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = $1::uuid`,
    [id, ...entries.map(([, value]) => value)],
  );
}

export function pickPatch(
  input: Record<string, unknown>,
  allowed: Record<string, string>,
) {
  const output: Record<string, unknown> = {};
  for (const [source, target] of Object.entries(allowed)) {
    if (Object.prototype.hasOwnProperty.call(input, source)) output[target] = input[source];
  }
  return output;
}
