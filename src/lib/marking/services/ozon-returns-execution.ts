import "server-only";

import { queryServerDatabase, type DatabaseQueryExecutor } from "@/lib/db/pool";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import {
  OZON_FBS_RETURNS_CONTRACT_VERSION,
  OzonReturnsContractError,
  parseOzonFbsReturnsPage,
} from "@/lib/marking/adapters/ozon/returns";
import { getMarkingRuntimeConfig, type MarkingRuntimeConfig } from "@/lib/marking/config";
import { upsertOzonReturnCase } from "@/lib/marking/repositories/returns";
import { ozonPost } from "@/lib/ozon/client";

type Dependencies = {
  query?: DatabaseQueryExecutor;
  config?: MarkingRuntimeConfig;
  post?: typeof ozonPost;
};

export async function executeOzonReturnsSync(
  context: JobExecutionContext,
  dependencies: Dependencies = {},
) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  if (!config.enabled || !config.returnsEnabled || !config.ozonReturnsSyncEnabled) {
    throw new Error("Ozon marking return sync is disabled");
  }
  if (!config.allowedAdminIds.includes(context.job.actor)) {
    throw new Error("Ozon marking return sync actor is denied");
  }
  const query = dependencies.query ?? queryServerDatabase;
  const post = dependencies.post ?? ozonPost;
  let lastId: string | null = null;
  let imported = 0;
  let linked = 0;
  let manualReview = 0;
  const seenCursors = new Set<string>();

  for (let pageNumber = 1; pageNumber <= 1_000; pageNumber += 1) {
    const response = await post<unknown>(
      "/v3/returns/company/fbs",
      {
        filter: {},
        limit: 500,
        ...(lastId ? { last_id: lastId } : {}),
      },
      {
        signal: context.signal,
        onRetry: (details) => context.report(
          { phase: "ozon_retry", pageNumber, attempt: details.attempt },
          "marking_returns_ozon_retry",
        ),
      },
    );
    const page = parseOzonFbsReturnsPage(response);
    for (const item of page.items) {
      const saved = await upsertOzonReturnCase(query, {
        ...item,
        contractVersion: OZON_FBS_RETURNS_CONTRACT_VERSION,
        actorId: context.job.actor,
      });
      imported += 1;
      if (saved.identityLinked) linked += 1;
      if (saved.processStatus === "manual_review") manualReview += 1;
    }
    await context.report(
      { phase: "importing", pageNumber, imported, linked, manualReview },
      "marking_returns_page_imported",
    );
    if (!page.hasNext) {
      return { imported, linked, manualReview, pages: pageNumber };
    }
    if (!page.lastId || seenCursors.has(page.lastId)) {
      throw new OzonReturnsContractError("Ozon returns pagination cursor did not advance");
    }
    seenCursors.add(page.lastId);
    lastId = page.lastId;
  }
  throw new OzonReturnsContractError("Ozon returns pagination exceeded safety limit");
}
