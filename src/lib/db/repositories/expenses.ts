import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { CatalogRepository } from "@/lib/db/repositories/catalog";
import type { Expense } from "@/lib/types";

export type ExpenseListOptions = {
  limit: number;
  from?: string;
  to?: string;
  categoryId?: string;
};

type ExpenseRow = Omit<Expense, "category">;

const EXPENSE_SELECT = "id,category_id,amount,occurred_at,description,created_at";

export interface ExpenseRepository {
  list(options: ExpenseListOptions): Promise<Expense[]>;
}

export class PostgresExpenseRepository implements ExpenseRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly catalog: CatalogRepository,
  ) {}

  async list(options: ExpenseListOptions) {
    const rows = (
      await this.query<ExpenseRow>(
        `
          SELECT id, category_id, amount::float8 AS amount, occurred_at,
                 description, created_at
          FROM merch_expenses
          WHERE ($2::date IS NULL OR occurred_at >= $2)
            AND ($3::date IS NULL OR occurred_at <= $3)
            AND ($4::uuid IS NULL OR category_id = $4)
          ORDER BY occurred_at DESC, created_at DESC, id DESC
          LIMIT $1
        `,
        [options.limit, options.from ?? null, options.to ?? null, options.categoryId ?? null],
      )
    ).rows;
    return hydrateExpenses(rows, this.catalog);
  }
}

export class SupabaseExpenseRepository implements ExpenseRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly catalog: CatalogRepository,
  ) {}

  async list(options: ExpenseListOptions) {
    let query = this.client
      .from("merch_expenses")
      .select(EXPENSE_SELECT)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(options.limit);
    if (options.from) query = query.gte("occurred_at", options.from);
    if (options.to) query = query.lte("occurred_at", options.to);
    if (options.categoryId) query = query.eq("category_id", options.categoryId);
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    return hydrateExpenses((data ?? []) as ExpenseRow[], this.catalog);
  }
}

async function hydrateExpenses(rows: ExpenseRow[], catalog: CatalogRepository) {
  const categories = await catalog.listExpenseCategories(true);
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  return rows.map((row) => ({
    ...row,
    category: row.category_id ? categoriesById.get(row.category_id) ?? null : null,
  }));
}

function repositoryError(error: unknown) {
  return new DatabaseQueryError("Supabase repository query failed", { cause: error });
}
