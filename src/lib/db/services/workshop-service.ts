import "server-only";

import type { WorkshopRepository } from "@/lib/db/repositories/workshop";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class WorkshopService {
  constructor(
    private readonly primary: WorkshopRepository,
    private readonly shadow: WorkshopRepository | null,
    private readonly strict: boolean,
  ) {}

  list(limit: number) {
    return this.run("workshop.list", (repository) => repository.list(limit));
  }

  get(id: string) {
    return this.run("workshop.get", (repository) => repository.get(id));
  }

  private run<T>(operation: string, action: (repository: WorkshopRepository) => Promise<T>) {
    return runShadowedRead({
      operation,
      primary: () => action(this.primary),
      shadow: this.shadow ? () => action(this.shadow!) : null,
      strict: this.strict,
    });
  }
}
