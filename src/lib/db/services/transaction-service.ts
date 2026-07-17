import "server-only";

import type { TransactionRepository } from "@/lib/db/repositories/transactions";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class TransactionService {
  constructor(
    private readonly primary: TransactionRepository,
    private readonly shadow: TransactionRepository | null,
    private readonly strict: boolean,
  ) {}

  list(limit: number) {
    return runShadowedRead({
      operation: "transactions.list",
      primary: () => this.primary.list(limit),
      shadow: this.shadow ? () => this.shadow!.list(limit) : null,
      strict: this.strict,
    });
  }
}
