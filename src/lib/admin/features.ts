import "server-only";

import { AdminApiError } from "@/lib/admin/http";
import type {
  AdminFeatureFlag,
  AdminFeatureKey,
  AdminFeatureSnapshot,
} from "@/lib/admin/feature-types";
import { DEFAULT_ADMIN_FEATURES } from "@/lib/admin/feature-types";
import { DatabaseBusinessError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { queryServerDatabase } from "@/lib/db/pool";
import {
  runServerMutation,
  type ServerMutationContext,
} from "@/lib/db/mutations/runner";

type FeatureRow = {
  feature_key: string;
  enabled: boolean;
  revision: string | number;
  updated_at: string;
  updated_by: string;
};

const FEATURE_DEFINITIONS: Record<AdminFeatureKey, {
  label: string;
  description: string;
}> = {
  chestny_znak: {
    label: "Честный знак",
    description: "Раздел, КМ в заказах Ozon и фоновые операции маркировки",
  },
};

export async function listAdminFeatureFlags(
  query: DatabaseQueryExecutor = queryServerDatabase,
): Promise<AdminFeatureFlag[]> {
  const rows = (
    await query<FeatureRow>(
      `
        SELECT feature_key, enabled, revision, updated_at, updated_by
        FROM getomerch_admin.feature_flag_safe
        WHERE feature_key = ANY ($1::text[])
        ORDER BY feature_key
      `,
      [Object.keys(FEATURE_DEFINITIONS)],
    )
  ).rows;
  const byKey = new Map(rows.map((row) => [row.feature_key, row]));
  return (Object.keys(FEATURE_DEFINITIONS) as AdminFeatureKey[]).map((key) => {
    const row = byKey.get(key);
    if (!row) {
      throw new DatabaseBusinessError(
        "feature_flag_missing",
        `Фича-флаг ${key} не зарегистрирован в базе данных.`,
        503,
      );
    }
    return mapFeatureRow(key, row);
  });
}

export async function getAdminFeatureSnapshot(): Promise<AdminFeatureSnapshot> {
  try {
    const flags = await listAdminFeatureFlags();
    return Object.freeze(Object.fromEntries(
      flags.map((flag) => [flag.key, flag.enabled]),
    )) as AdminFeatureSnapshot;
  } catch (error) {
    console.error("[admin-features] using fail-closed snapshot", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return DEFAULT_ADMIN_FEATURES;
  }
}

export async function isAdminFeatureEnabled(
  key: AdminFeatureKey,
  query: DatabaseQueryExecutor = queryServerDatabase,
) {
  const row = (
    await query<Pick<FeatureRow, "enabled">>(
      `
        SELECT enabled
        FROM getomerch_admin.feature_flag_safe
        WHERE feature_key = $1
      `,
      [key],
    )
  ).rows[0];
  return row?.enabled === true;
}

export async function requireAdminFeatureEnabled(key: AdminFeatureKey) {
  if (await isAdminFeatureEnabled(key)) return;
  throw new AdminApiError(
    404,
    "feature_disabled",
    "Функция выключена в настройках админки",
  );
}

export async function updateAdminFeatureFlag(input: {
  key: AdminFeatureKey;
  enabled: boolean;
  expectedRevision: number;
}, context: ServerMutationContext) {
  return runServerMutation({
    operation: "admin_feature_flag.update",
    payload: input,
    context,
    execute: async (query) => {
      const before = (await listAdminFeatureFlags(query))
        .find((flag) => flag.key === input.key);
      if (!before) {
        throw new DatabaseBusinessError(
          "feature_flag_missing",
          "Фича-флаг не найден.",
          404,
        );
      }
      if (before.revision !== input.expectedRevision) {
        throw new DatabaseBusinessError(
          "feature_flag_revision_conflict",
          "Флаг уже был изменён. Обновите страницу.",
        );
      }
      const row = (
        await query<FeatureRow>(
          `
            SELECT feature_key, enabled, revision, updated_at, updated_by
            FROM getomerch_admin.set_feature_flag($1, $2, $3, $4)
          `,
          [input.key, input.enabled, input.expectedRevision, context.actor],
        )
      ).rows[0];
      if (!row) {
        throw new DatabaseBusinessError(
          "feature_flag_revision_conflict",
          "Флаг уже был изменён. Обновите страницу.",
        );
      }
      const after = mapFeatureRow(input.key, row);
      return {
        data: after,
        audit: {
          entityType: "admin_feature_flag",
          entityId: input.key,
          before,
          after,
        },
      };
    },
  });
}

function mapFeatureRow(key: AdminFeatureKey, row: FeatureRow): AdminFeatureFlag {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new DatabaseBusinessError(
      "feature_flag_invalid",
      "Состояние фича-флага повреждено.",
      503,
    );
  }
  return {
    key,
    ...FEATURE_DEFINITIONS[key],
    enabled: row.enabled,
    revision,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
