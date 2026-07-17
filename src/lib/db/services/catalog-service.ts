import "server-only";

import type {
  CatalogRepository,
  CatalogSnapshot,
} from "@/lib/db/repositories/catalog";
import type { Design, ExpenseCategory } from "@/lib/types";
import {
  compareShadowResult,
  runShadowedRead,
  settleShadowResult,
} from "@/lib/db/services/shadow-compare";

export class CatalogService {
  constructor(
    private readonly primary: CatalogRepository,
    private readonly shadow: CatalogRepository | null,
    private readonly strictShadowCompare: boolean,
  ) {}

  async listCatalog() {
    const primaryPromise = this.primary.listCatalog();
    const shadowPromise = this.shadow
      ? settleShadowResult(this.shadow.listCatalog().then(sortCatalog))
      : null;
    const result = sortCatalog(await primaryPromise);
    await compareShadowResult(
      "catalog.listCatalog",
      result,
      shadowPromise,
      this.strictShadowCompare,
    );
    return result;
  }

  listWarehouses() {
    return this.run("catalog.warehouses", (repository) => repository.listWarehouses(), sortTypedNames);
  }

  listCategories() {
    return this.run("catalog.categories", (repository) => repository.listCategories(), sortNames);
  }

  listFabrics() {
    return this.run("catalog.fabrics", (repository) => repository.listFabrics(), sortNames);
  }

  listColors() {
    return this.run("catalog.colors", (repository) => repository.listColors(), sortNames);
  }

  listSizes() {
    return this.run("catalog.sizes", (repository) => repository.listSizes(), sortSizes);
  }

  listDesigns(type?: Design["type"]) {
    return this.run("catalog.designs", (repository) => repository.listDesigns(type), sortNames);
  }

  listDecorationTypes() {
    return this.run(
      "catalog.decorationTypes",
      (repository) => repository.listDecorationTypes(),
      sortNames,
    );
  }

  listExpenseCategories(includeArchived = false) {
    return this.run(
      "catalog.expenseCategories",
      (repository) => repository.listExpenseCategories(includeArchived),
      sortExpenseCategories,
    );
  }

  private run<T>(
    operation: string,
    action: (repository: CatalogRepository) => Promise<T>,
    normalize?: (value: T) => T,
  ) {
    return runShadowedRead({
      operation,
      primary: () => action(this.primary),
      shadow: this.shadow ? () => action(this.shadow!) : null,
      strict: this.strictShadowCompare,
      normalize,
    });
  }
}

function sortCatalog(catalog: CatalogSnapshot): CatalogSnapshot {
  const byName = <T extends { id: string; name: string }>(left: T, right: T) =>
    compareText(left.name, right.name) || compareText(left.id, right.id);

  return {
    warehouses: [...catalog.warehouses].sort(
      (left, right) => compareText(left.type, right.type) || byName(left, right),
    ),
    categories: [...catalog.categories].sort(byName),
    fabrics: [...catalog.fabrics].sort(byName),
    colors: [...catalog.colors].sort(byName),
    sizes: [...catalog.sizes].sort(
      (left, right) => left.sort_order - right.sort_order || byName(left, right),
    ),
    designs: [...catalog.designs].sort(byName),
    decorationTypes: [...catalog.decorationTypes].sort(byName),
    expenseCategories: [...catalog.expenseCategories].sort(
      (left, right) => left.sort_order - right.sort_order || byName(left, right),
    ),
  };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortNames<T extends { id: string; name: string }>(rows: T[]) {
  return [...rows].sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.id, right.id),
  );
}

function sortTypedNames<T extends { id: string; name: string; type: string }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      compareText(left.type, right.type) ||
      compareText(left.name, right.name) ||
      compareText(left.id, right.id),
  );
}

function sortSizes<T extends { id: string; name: string; sort_order: number }>(rows: T[]) {
  return [...rows].sort(
    (left, right) =>
      left.sort_order - right.sort_order ||
      compareText(left.name, right.name) ||
      compareText(left.id, right.id),
  );
}

function sortExpenseCategories(rows: ExpenseCategory[]) {
  return [...rows].sort(
    (left, right) =>
      left.sort_order - right.sort_order ||
      compareText(left.name, right.name) ||
      compareText(left.id, right.id),
  );
}
