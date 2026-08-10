import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult } from "pg";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("GETOMERCH_DATABASE_URL is required");
}

const pool = new Pool({
  connectionString,
  max: 8,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 20_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

async function main() {
try {
  const database = (await pool.query<{ name: string }>(
    "select current_database() as name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_(rehearsal|stage3_[a-z0-9_]+)$/.test(database)) {
    throw new Error(`Refusing Stage 3 DB tests against database: ${database ?? "unknown"}`);
  }

  await assert.rejects(
    pool.query(
      `
        INSERT INTO public.merch_marking_trade_items (gtin, product_group)
        VALUES ('04628837736074', 'light_industry')
      `,
    ),
    (error) => pgCode(error) === "23514",
  );
  await assertDatabaseTransitionMatrix();

  const fulfillment = await createFulfillmentFixture();
  const process = await asApp(
    `
      SELECT id, status, version
      FROM getomerch_marking.create_process(
        'ozon_fbs_marking',
        $1::uuid,
        $2::uuid,
        'ozon_fbs',
        $3,
        50,
        'order_received',
        'verify_product_profile',
        NULL,
        'system',
        'stage3-db-test'
      )
    `,
    [fulfillment.orderId, fulfillment.itemId, `stage3:${randomUUID()}`],
  );
  assert.equal(process.rows[0]?.status, "open");
  assert.equal(Number(process.rows[0]?.version), 1);
  assert.equal(await eventCount(process.rows[0].id), 1);

  const transitioned = await asApp(
    `
      SELECT id, status, version
      FROM getomerch_marking.transition_process(
        $1::uuid,
        1,
        'ready',
        'readiness_confirmed',
        'complete_process',
        NULL,
        NULL,
        NULL,
        'stage3-db-test',
        'system',
        'stage3-db-test',
        'stage3_test'
      )
    `,
    [process.rows[0].id],
  );
  assert.equal(transitioned.rows[0]?.status, "ready");
  assert.equal(Number(transitioned.rows[0]?.version), 2);
  assert.equal(await eventCount(process.rows[0].id), 2);

  await assert.rejects(
    asApp(
      `
        SELECT id
        FROM getomerch_marking.transition_process(
          $1::uuid,
          2,
          'open',
          'invalid_transition',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'system',
          'stage3-db-test',
          'stage3_test'
        )
      `,
      [process.rows[0].id],
    ),
    (error) => pgCode(error) === "MZ003",
  );
  assert.equal(await eventCount(process.rows[0].id), 2);

  await assertAtomicRollback(fulfillment);
  await assertConcurrentTransition(fulfillment);
  await assertProfileReadinessInvariant();

  await assert.rejects(
    asApp(
      `
        UPDATE public.merch_marking_processes
        SET current_step = 'direct_write'
        WHERE id = $1::uuid
      `,
      [process.rows[0].id],
    ),
    (error) => pgCode(error) === "42501",
  );
  await assert.rejects(
    asApp(
      `
        INSERT INTO public.merch_marking_events (
          process_id,
          event_type,
          actor_type,
          source,
          occurred_at
        )
        VALUES ($1::uuid, 'direct_write', 'system', 'stage3_test', clock_timestamp())
      `,
      [process.rows[0].id],
    ),
    (error) => pgCode(error) === "42501",
  );

  console.log("Stage 3 PostgreSQL state, atomicity and permission checks passed");
} finally {
  await pool.end();
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function assertDatabaseTransitionMatrix() {
  const statuses = [
    "open",
    "waiting_user",
    "waiting_external",
    "ready",
    "completed",
    "manual_review",
    "failed",
    "cancelled",
  ];
  const expected = new Set([
    "open:waiting_user",
    "open:waiting_external",
    "open:ready",
    "open:manual_review",
    "open:failed",
    "open:cancelled",
    "waiting_user:open",
    "waiting_user:waiting_external",
    "waiting_user:ready",
    "waiting_user:manual_review",
    "waiting_user:failed",
    "waiting_user:cancelled",
    "waiting_external:waiting_user",
    "waiting_external:ready",
    "waiting_external:manual_review",
    "waiting_external:failed",
    "waiting_external:cancelled",
    "ready:waiting_user",
    "ready:waiting_external",
    "ready:completed",
    "ready:manual_review",
    "ready:failed",
    "ready:cancelled",
    "manual_review:open",
    "manual_review:waiting_user",
    "manual_review:waiting_external",
    "manual_review:ready",
    "manual_review:failed",
    "manual_review:cancelled",
    "failed:open",
    "failed:manual_review",
    "failed:cancelled",
  ]);
  const result = await pool.query<{
    from_status: string;
    to_status: string;
    allowed: boolean;
  }>(
    `
      SELECT
        source.from_status,
        target.to_status,
        getomerch_marking.process_transition_allowed(
          source.from_status,
          target.to_status
        ) AS allowed
      FROM unnest($1::text[]) AS source(from_status)
      CROSS JOIN unnest($1::text[]) AS target(to_status)
      ORDER BY source.from_status, target.to_status
    `,
    [statuses],
  );
  assert.equal(result.rows.length, statuses.length ** 2);
  for (const row of result.rows) {
    assert.equal(
      row.allowed,
      expected.has(`${row.from_status}:${row.to_status}`),
      `${row.from_status} -> ${row.to_status}`,
    );
  }
}

async function createFulfillmentFixture() {
  const key = `stage3:${randomUUID()}`;
  const order = await pool.query<{ id: string }>(
    `
      INSERT INTO public.merch_fulfillment_orders (
        source_channel,
        fulfillment_scheme,
        source_order_key,
        external_posting_number,
        source_status,
        source_updated_at
      )
      VALUES ('ozon_fbs', 'fbs', $1, $1, 'awaiting_packaging', clock_timestamp())
      RETURNING id
    `,
    [key],
  );
  const item = await pool.query<{ id: string }>(
    `
      INSERT INTO public.merch_fulfillment_order_items (
        fulfillment_order_id,
        source_item_key,
        offer_id,
        quantity
      )
      VALUES ($1::uuid, $2, 'STAGE3-TEST-S', 1)
      RETURNING id
    `,
    [order.rows[0].id, `${key}:item`],
  );
  return { orderId: order.rows[0].id, itemId: item.rows[0].id };
}

async function assertAtomicRollback(
  fulfillment: { orderId: string; itemId: string },
) {
  const sourceKey = `stage3:rollback:${randomUUID()}`;
  const client = await pool.connect();
  let processId: string | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE getomerch_app");
    const created = await client.query<{ id: string }>(
      `
        SELECT id
        FROM getomerch_marking.create_process(
          'atomicity_test',
          $1::uuid,
          $2::uuid,
          'stage3_test',
          $3,
          50,
          'created',
          NULL,
          NULL,
          'system',
          'stage3-db-test'
        )
      `,
      [fulfillment.orderId, fulfillment.itemId, sourceKey],
    );
    processId = created.rows[0].id;
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  assert.ok(processId);
  const result = await pool.query<{ process_count: string; event_count: string }>(
    `
      SELECT
        (SELECT count(*) FROM public.merch_marking_processes WHERE id = $1::uuid)
          AS process_count,
        (SELECT count(*) FROM public.merch_marking_events WHERE process_id = $1::uuid)
          AS event_count
    `,
    [processId],
  );
  assert.equal(Number(result.rows[0].process_count), 0);
  assert.equal(Number(result.rows[0].event_count), 0);
}

async function assertConcurrentTransition(
  fulfillment: { orderId: string; itemId: string },
) {
  const created = await asApp(
    `
      SELECT id
      FROM getomerch_marking.create_process(
        'concurrency_test',
        $1::uuid,
        $2::uuid,
        'stage3_test',
        $3,
        50,
        'created',
        NULL,
        NULL,
        'system',
        'stage3-db-test'
      )
    `,
    [fulfillment.orderId, fulfillment.itemId, `stage3:concurrency:${randomUUID()}`],
  );
  const sql = `
    SELECT id, status, version
    FROM getomerch_marking.transition_process(
      $1::uuid,
      1,
      'waiting_user',
      'waiting_for_user',
      'review',
      NULL,
      NULL,
      NULL,
      NULL,
      'system',
      'stage3-db-test',
      'stage3_test'
    )
  `;
  const results = await Promise.allSettled([
    asApp(sql, [created.rows[0].id]),
    asApp(sql, [created.rows[0].id]),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(rejected);
  assert.equal(pgCode(rejected.reason), "MZ002");
  assert.equal(await eventCount(created.rows[0].id), 2);
}

async function assertProfileReadinessInvariant() {
  const suffix = randomUUID().slice(0, 8);
  const refs = await pool.query<{
    category_id: string;
    fabric_id: string;
    color_id: string;
    size_id: string;
    design_id: string;
    decoration_type_id: string;
  }>(
    `
      WITH category AS (
        INSERT INTO public.merch_product_categories (name, slug)
        VALUES ($1, $2)
        RETURNING id
      ),
      fabric AS (
        INSERT INTO public.merch_fabric_types (name, slug)
        VALUES ($1, $2)
        RETURNING id
      ),
      color AS (
        INSERT INTO public.merch_colors (name)
        VALUES ($1)
        RETURNING id
      ),
      size AS (
        INSERT INTO public.merch_sizes (name)
        VALUES ('S')
        RETURNING id
      ),
      design AS (
        INSERT INTO public.merch_designs (name, type)
        VALUES ($1, 'print')
        RETURNING id
      ),
      decoration AS (
        INSERT INTO public.merch_decoration_types (name, slug, made_at)
        VALUES ($1, $2, 'own')
        RETURNING id
      )
      SELECT
        category.id AS category_id,
        fabric.id AS fabric_id,
        color.id AS color_id,
        size.id AS size_id,
        design.id AS design_id,
        decoration.id AS decoration_type_id
      FROM category, fabric, color, size, design, decoration
    `,
    [`Stage3 ${suffix}`, `stage3-${suffix}`],
  );
  const product = await pool.query<{ id: string }>(
    `
      INSERT INTO public.merch_products (
        category_id,
        fabric_id,
        color_id,
        size_id,
        design_id,
        decoration_type_id,
        sku
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7
      )
      RETURNING id
    `,
    [
      refs.rows[0].category_id,
      refs.rows[0].fabric_id,
      refs.rows[0].color_id,
      refs.rows[0].size_id,
      refs.rows[0].design_id,
      refs.rows[0].decoration_type_id,
      `STAGE3-${suffix}-S`,
    ],
  );
  const tradeItem = await pool.query<{ id: string }>(
    `
      INSERT INTO public.merch_marking_trade_items (
        gtin,
        product_group,
        verification_status,
        verification_source,
        source_snapshot_hash,
        verified_at,
        verified_by
      )
      VALUES (
        '04628837736075',
        'light_industry',
        'verified',
        'stage3_test',
        repeat('a', 64),
        clock_timestamp(),
        'stage3-db-test'
      )
      RETURNING id
    `,
  );

  const blankProduct = await pool.query<{ id: string }>(
    `
      INSERT INTO public.merch_products (
        category_id,
        fabric_id,
        color_id,
        size_id,
        sku,
        is_blank
      )
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, true)
      RETURNING id
    `,
    [
      refs.rows[0].category_id,
      refs.rows[0].fabric_id,
      refs.rows[0].color_id,
      refs.rows[0].size_id,
      `STAGE3-BLANK-${suffix}-S`,
    ],
  );
  await assert.rejects(
    inTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO public.merch_marking_product_profiles (
            product_id,
            requires_marking,
            production_mode,
            fulfillment_marking_mode,
            verification_status
          )
          VALUES (
            $1::uuid,
            false,
            'own_production',
            'jit_after_order',
            'draft'
          )
        `,
        [blankProduct.rows[0].id],
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }),
    (error) => pgCode(error) === "MZ104",
  );

  await assert.rejects(
    inTransaction(async (client) => {
      await client.query(
        profileInsertSql,
        [product.rows[0].id, tradeItem.rows[0].id],
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }),
    (error) => pgCode(error) === "MZ102" || (
      pgCode(error) === "23514"
      && pgConstraint(error)
        === "merch_marking_product_profiles_requirement_alignment_check"
    ),
  );

  await inTransaction(async (client) => {
    const profile = await client.query<{ id: string }>(
      profileInsertSql,
      [product.rows[0].id, tradeItem.rows[0].id],
    );
    await client.query(
      `
        INSERT INTO public.merch_marking_evidence (
          product_profile_id,
          evidence_type,
          source,
          scope_snapshot,
          observed_at,
          payload_hash,
          details_redacted,
          verification_status,
          verified_by,
          verified_at
        )
        VALUES (
          $1::uuid,
          'product_profile_mapping',
          'stage3_test',
          '{"scope":"product_profile"}'::jsonb,
          clock_timestamp(),
          repeat('b', 64),
          '{"decision":"verified"}'::jsonb,
          'verified',
          'stage3-db-test',
          clock_timestamp()
        )
      `,
      [profile.rows[0].id],
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  });

  const documentCount = await pool.query<{ count: string }>(
    `
      SELECT count(*)
      FROM public.merch_marking_trade_item_documents
      WHERE trade_item_id = $1::uuid
    `,
    [tradeItem.rows[0].id],
  );
  assert.equal(Number(documentCount.rows[0].count), 0);
}

const profileInsertSql = `
  INSERT INTO public.merch_marking_product_profiles (
    product_id,
    trade_item_id,
    requires_marking,
    production_mode,
    fulfillment_marking_mode,
    verification_status,
    verification_source,
    source_snapshot_hash,
    verified_at,
    verified_by
  )
  VALUES (
    $1::uuid,
    $2::uuid,
    true,
    'own_production',
    'jit_after_order',
    'verified',
    'stage3_test',
    repeat('c', 64),
    clock_timestamp(),
    'stage3-db-test'
  )
  RETURNING id
`;

async function asApp(
  sql: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<any>> {
  return inTransaction(async (client) => {
    await client.query("SET LOCAL ROLE getomerch_app");
    return client.query(sql, [...params]);
  });
}

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function eventCount(processId: string) {
  const result = await pool.query<{ count: string }>(
    `
      SELECT count(*)
      FROM public.merch_marking_events
      WHERE process_id = $1::uuid
    `,
    [processId],
  );
  return Number(result.rows[0].count);
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      return String((current as { code?: unknown }).code ?? "");
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function pgConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "constraint" in current) {
      return String((current as { constraint?: unknown }).constraint ?? "");
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function useSsl(url: string) {
  try {
    const parsed = new URL(url);
    const socketHost = parsed.searchParams.get("host") ?? "";
    return Boolean(parsed.hostname)
      && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
      && !socketHost.startsWith("/");
  } catch {
    return true;
  }
}
