#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ADMIN_FEATURES } from "@/lib/admin/feature-types";

const ROOT = process.cwd();

main().catch((error) => {
  console.error("Admin feature flag checks failed", error);
  process.exitCode = 1;
});

async function main() {
  assert.equal(DEFAULT_ADMIN_FEATURES.chestny_znak, false);

  const markingRoutes = await collectRouteFiles(
    path.join(ROOT, "src/app/api/admin/marking"),
  );
  assert.ok(markingRoutes.length > 0);
  for (const route of markingRoutes) {
    const source = await readFile(route, "utf8");
    assert.match(
      source,
      /requireMarking(?:AdminSession|MutationContext)/,
      `${path.relative(ROOT, route)} does not enforce the business feature flag`,
    );
  }

  await assertContains("src/app/marking/layout.tsx", "isAdminFeatureEnabled");
  await assertContains("src/app/api/admin/ozon/orders/route.ts", "isAdminFeatureEnabled");
  await assertContains("src/lib/db/mutations/ozon.ts", "isAdminFeatureEnabled");
  await assertContains("src/lib/marking/worker.ts", "isAdminFeatureEnabled");
  await assertContains("src/app/api/marking-agent/v1/route.ts", "isAdminFeatureEnabled");
  await assertContains("src/components/sidebar.tsx", "visibleNavigation(markingEnabled)");
  await assertContains("src/app/orders/page.tsx", "markingCanShip(order, markingEnabled)");

  console.log("Admin feature flag checks passed");
}

async function collectRouteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectRouteFiles(candidate));
    if (entry.isFile() && entry.name === "route.ts") files.push(candidate);
  }
  return files.sort();
}

async function assertContains(relativePath: string, expected: string) {
  const source = await readFile(path.join(ROOT, relativePath), "utf8");
  assert.ok(source.includes(expected), `${relativePath} is missing ${expected}`);
}
