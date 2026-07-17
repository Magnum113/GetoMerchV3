import "server-only";

import type {
  BlankMatchKey,
  ProductDimensions,
  ProductPageOptions,
  ProductRepository,
} from "@/lib/db/repositories/products";
import { runShadowedRead } from "@/lib/db/services/shadow-compare";

export class ProductService {
  constructor(
    private readonly primary: ProductRepository,
    private readonly shadow: ProductRepository | null,
    private readonly strictShadowCompare: boolean,
  ) {}

  async listPage(options: ProductPageOptions) {
    return this.run("products.listPage", (repository) => repository.listPage(options));
  }

  async listAll(filters: Pick<ProductPageOptions, "isBlank" | "designId" | "search"> = {}) {
    const pageSize = 500;
    const rows = [];
    for (let offset = 0; offset < 20_000; offset += pageSize) {
      const page = await this.listPage({ ...filters, limit: pageSize, offset });
      rows.push(...page.rows);
      if (!page.hasMore) break;
    }
    return rows;
  }

  findBlank(dimensions: ProductDimensions) {
    return this.run("products.findBlank", (repository) => repository.findBlank(dimensions));
  }

  findBlankMatches(keys: BlankMatchKey[]) {
    return this.run("products.findBlankMatches", (repository) =>
      repository.findBlankMatches(keys),
    );
  }

  listDesignProductCounts() {
    return this.run("products.designProductCounts", (repository) =>
      repository.listDesignProductCounts(),
    );
  }

  private run<T>(operation: string, action: (repository: ProductRepository) => Promise<T>) {
    return runShadowedRead({
      operation,
      primary: () => action(this.primary),
      shadow: this.shadow ? () => action(this.shadow!) : null,
      strict: this.strictShadowCompare,
    });
  }
}
