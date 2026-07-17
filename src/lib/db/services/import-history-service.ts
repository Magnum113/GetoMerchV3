import "server-only";

import type {
  ImportHistoryRepository,
  ImportRunListOptions,
} from "@/lib/db/repositories/import-history";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class ImportHistoryService {
  constructor(
    private readonly primary: ImportHistoryRepository,
    private readonly shadow: ImportHistoryRepository | null,
    private readonly strict: boolean,
  ) {}

  listRuns(options: ImportRunListOptions) {
    return runShadowedRead({
      operation: "importHistory.listRuns",
      primary: () => this.primary.listRuns(options),
      shadow: this.shadow ? () => this.shadow!.listRuns(options) : null,
      strict: this.strict,
    });
  }
}
