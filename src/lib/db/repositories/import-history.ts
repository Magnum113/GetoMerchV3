import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";

export type OzonImportRun = {
  id: string;
  status: string;
  mode: string;
  summary: Record<string, unknown>;
  options: Record<string, unknown>;
  error: string | null;
  created_at: string;
  applied_at: string | null;
};

export type ImportRunListOptions = { limit: number; status?: string };

const RUN_SELECT = "id,status,mode,summary,options,error,created_at,applied_at";

export interface ImportHistoryRepository {
  listRuns(options: ImportRunListOptions): Promise<OzonImportRun[]>;
}

export class PostgresImportHistoryRepository implements ImportHistoryRepository {
  constructor(private readonly query: DatabaseQueryExecutor) {}

  async listRuns(options: ImportRunListOptions) {
    return (
      await this.query<OzonImportRun>(
        `
          SELECT ${RUN_SELECT}
          FROM merch_ozon_import_runs
          WHERE ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC, id DESC
          LIMIT $1
        `,
        [options.limit, options.status ?? null],
      )
    ).rows;
  }
}

export class SupabaseImportHistoryRepository implements ImportHistoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listRuns(options: ImportRunListOptions) {
    let query = this.client
      .from("merch_ozon_import_runs")
      .select(RUN_SELECT)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(options.limit);
    if (options.status) query = query.eq("status", options.status);
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    return (data ?? []) as OzonImportRun[];
  }
}

function repositoryError(error: unknown) {
  return new DatabaseQueryError("Supabase repository query failed", { cause: error });
}
