import "server-only";

import type { ExpenseListOptions, ExpenseRepository } from "@/lib/db/repositories/expenses";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class ExpenseService {
  constructor(
    private readonly primary: ExpenseRepository,
    private readonly shadow: ExpenseRepository | null,
    private readonly strict: boolean,
  ) {}

  list(options: ExpenseListOptions) {
    return runShadowedRead({
      operation: "expenses.list",
      primary: () => this.primary.list(options),
      shadow: this.shadow ? () => this.shadow!.list(options) : null,
      strict: this.strict,
    });
  }
}
