import "server-only";

import type { FinanceListOptions, FinanceRepository } from "@/lib/db/repositories/finance";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class FinanceService {
  constructor(
    private readonly primary: FinanceRepository,
    private readonly shadow: FinanceRepository | null,
    private readonly strict: boolean,
  ) {}

  list(options: FinanceListOptions) {
    return this.run("finance.list", (repository) => repository.list(options));
  }

  listOzonSkuProductMap() {
    return this.run("finance.ozonSkuProductMap", (repository) =>
      repository.listOzonSkuProductMap(),
    );
  }

  lastSyncAt() {
    return this.run("finance.lastSyncAt", (repository) => repository.lastSyncAt());
  }

  private run<T>(operation: string, action: (repository: FinanceRepository) => Promise<T>) {
    return runShadowedRead({
      operation,
      primary: () => action(this.primary),
      shadow: this.shadow ? () => action(this.shadow!) : null,
      strict: this.strict,
    });
  }
}
