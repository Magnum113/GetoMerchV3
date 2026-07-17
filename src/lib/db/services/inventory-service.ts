import "server-only";

import type {
  InventoryListOptions,
  InventoryRepository,
} from "@/lib/db/repositories/inventory";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class InventoryService {
  constructor(
    private readonly primary: InventoryRepository,
    private readonly shadow: InventoryRepository | null,
    private readonly strict: boolean,
  ) {}

  listInventory(options: InventoryListOptions) {
    return this.run("inventory.list", (repo) => repo.listInventory(options));
  }

  getInventoryFor(productId: string, warehouseId: string) {
    return this.run("inventory.get", (repo) => repo.getInventoryFor(productId, warehouseId));
  }

  listPrintInventory(warehouseId?: string) {
    return this.run("printInventory.list", (repo) => repo.listPrintInventory(warehouseId));
  }

  getPrintInventoryFor(designId: string, warehouseId: string) {
    return this.run("printInventory.get", (repo) => repo.getPrintInventoryFor(designId, warehouseId));
  }

  getMatrix() {
    return this.run("inventory.matrix", (repo) => repo.getMatrix());
  }

  private run<T>(operation: string, action: (repository: InventoryRepository) => Promise<T>) {
    return runShadowedRead({
      operation,
      primary: () => action(this.primary),
      shadow: this.shadow ? () => action(this.shadow!) : null,
      strict: this.strict,
    });
  }
}
