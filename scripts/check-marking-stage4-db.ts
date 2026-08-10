import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 20_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  try {
    const database = (await pool.query<{ name: string }>(
      "select current_database() as name",
    )).rows[0]?.name;
    if (!database || !/^getomerch_stage4_[a-z0-9_]+$/.test(database)) {
      throw new Error(`Refusing Stage 4 DB tests against database: ${database ?? "unknown"}`);
    }

    const fixture = await createProductFixture();
    const pilot = await upsertProfile({
      productId: fixture.pilotId,
      requirement: "unknown",
      offerId: "D15-TSH-PRT-WHT-S",
    });
    assert.equal(pilot.operational_status, "draft");
    assert.equal(Number(pilot.revision), 1);

    await assert.rejects(
      setOperationalStatus(pilot.profile_id, 1, "enabled", null),
      (error) => pgCode(error) === "MZ105",
    );

    const requiredPilot = await upsertProfile({
      productId: fixture.pilotId,
      expectedRevision: 1,
      requirement: "required",
      offerId: "D15-TSH-PRT-WHT-S",
    });
    assert.equal(Number(requiredPilot.revision), 2);

    await assert.rejects(
      verifyProfile({
        profileId: pilot.profile_id,
        revision: 2,
        gtin: "04628837736074",
        declaredColor: "Белый",
        declaredSize: "S",
      }),
      (error) => pgCode(error) === "MZ400",
    );

    const verifiedPilot = await verifyProfile({
      profileId: pilot.profile_id,
      revision: 2,
      gtin: "04628837736075",
      declaredColor: "Белый",
      declaredSize: "S",
      catalogCardId: "1056097470",
    });
    assert.equal(Number(verifiedPilot.revision), 3);
    assert.equal(verifiedPilot.verification_status, "verified");

    await insertOzonRequirement(
      fixture.pilotId,
      "D15-TSH-PRT-WHT-S",
      "required",
    );
    await pool.query(
      `
        INSERT INTO public.merch_marking_trade_item_documents (
          trade_item_id,
          document_type,
          document_number,
          issued_at,
          valid_until,
          status
        )
        VALUES (
          $1::uuid,
          'declaration',
          'STAGE4-INFORMATIONAL',
          current_date - 30,
          current_date - 1,
          'expired'
        )
      `,
      [verifiedPilot.trade_item_id],
    );
    const enabledPilot = await setOperationalStatus(
      pilot.profile_id,
      3,
      "enabled",
      null,
    );
    assert.equal(enabledPilot.operational_status, "enabled");
    assert.equal(Number(enabledPilot.revision), 4);

    const pausedPilot = await setOperationalStatus(
      pilot.profile_id,
      4,
      "paused",
      "Stage 4 test pause",
    );
    assert.equal(pausedPilot.operational_status, "paused");
    await assert.rejects(
      upsertProfile({
        productId: fixture.pilotId,
        expectedRevision: 4,
        requirement: "required",
        offerId: "D15-TSH-PRT-WHT-S",
      }),
      (error) => pgCode(error) === "MZ404",
    );

    const attributeProfile = await upsertProfile({
      productId: fixture.attributeMismatchId,
      requirement: "required",
      offerId: fixture.attributeMismatchSku,
    });
    const attributeVerified = await verifyProfile({
      profileId: attributeProfile.profile_id,
      revision: 1,
      gtin: makeGtin("0462883773608"),
      declaredColor: "Белый",
      declaredSize: "M",
    });
    await assert.rejects(
      setOperationalStatus(
        attributeProfile.profile_id,
        Number(attributeVerified.revision),
        "enabled",
        null,
      ),
      (error) => pgCode(error) === "MZ106",
    );
    const replacedAttribute = await verifyProfile({
      profileId: attributeProfile.profile_id,
      revision: Number(attributeVerified.revision),
      gtin: makeGtin("0462883773610"),
      declaredColor: "Белый",
      declaredSize: "M",
    });
    assert.notEqual(replacedAttribute.result_profile_id, attributeProfile.profile_id);
    const movedChannel = await pool.query<{
      old_enabled: boolean;
      new_enabled: boolean;
    }>(
      `
        SELECT
          old_channel.is_enabled AS old_enabled,
          new_channel.is_enabled AS new_enabled
        FROM public.merch_marking_product_profile_channels AS old_channel
        JOIN public.merch_marking_product_profile_channels AS new_channel
          ON new_channel.channel = old_channel.channel
         AND new_channel.offer_id = old_channel.offer_id
        WHERE old_channel.product_profile_id = $1::uuid
          AND new_channel.product_profile_id = $2::uuid
      `,
      [attributeProfile.profile_id, replacedAttribute.result_profile_id],
    );
    assert.equal(movedChannel.rows[0].old_enabled, false);
    assert.equal(movedChannel.rows[0].new_enabled, true);
    await assert.rejects(
      setOperationalStatus(
        replacedAttribute.result_profile_id,
        Number(replacedAttribute.revision),
        "enabled",
        null,
      ),
      (error) => pgCode(error) === "MZ106",
    );

    const ozonProfile = await upsertProfile({
      productId: fixture.ozonMismatchId,
      requirement: "required",
      offerId: fixture.ozonMismatchSku,
    });
    const ozonVerified = await verifyProfile({
      profileId: ozonProfile.profile_id,
      revision: 1,
      gtin: makeGtin("0462883773609"),
      declaredColor: "Белый",
      declaredSize: "L",
    });
    await insertOzonRequirement(
      fixture.ozonMismatchId,
      fixture.ozonMismatchSku,
      "not_required",
    );
    await assert.rejects(
      setOperationalStatus(
        ozonProfile.profile_id,
        Number(ozonVerified.revision),
        "enabled",
        null,
      ),
      (error) => pgCode(error) === "MZ107",
    );

    const runId = await createBackfillPreview(
      fixture.backfillId,
      fixture.backfillSku,
      "04628837736075",
    );
    const firstApply = await asApp<{ summary: Record<string, unknown> }>(
      `
        SELECT getomerch_marking.apply_profile_backfill($1::uuid, 'stage4-db-test')
          AS summary
      `,
      [runId],
    );
    const secondApply = await asApp<{ summary: Record<string, unknown> }>(
      `
        SELECT getomerch_marking.apply_profile_backfill($1::uuid, 'stage4-db-test')
          AS summary
      `,
      [runId],
    );
    assert.deepEqual(secondApply.rows[0].summary, firstApply.rows[0].summary);
    assert.equal(Number(firstApply.rows[0].summary.applied), 1);

    const backfilled = await pool.query<{
      operational_status: string;
      verification_status: string;
      trade_item_id: string | null;
      exact_gtin: string | null;
    }>(
      `
        SELECT
          profile.operational_status,
          profile.verification_status,
          profile.trade_item_id,
          item.exact_gtin
        FROM public.merch_marking_profile_backfill_items AS item
        JOIN public.merch_marking_product_profiles AS profile
          ON profile.id = item.applied_profile_id
        WHERE item.run_id = $1::uuid
          AND item.product_id = $2::uuid
      `,
      [runId, fixture.backfillId],
    );
    assert.equal(backfilled.rows[0].operational_status, "draft");
    assert.equal(backfilled.rows[0].verification_status, "draft");
    assert.equal(backfilled.rows[0].trade_item_id, null);
    assert.equal(backfilled.rows[0].exact_gtin, "04628837736075");

    const profileEvent = await pool.query<{
      process_id: string | null;
      product_profile_id: string | null;
    }>(
      `
        SELECT event.process_id, event.product_profile_id
        FROM public.merch_marking_events AS event
        WHERE event.product_profile_id = $1::uuid
        ORDER BY event.id DESC
        LIMIT 1
      `,
      [pilot.profile_id],
    );
    assert.equal(profileEvent.rows[0].process_id, null);
    assert.equal(profileEvent.rows[0].product_profile_id, pilot.profile_id);

    await assert.rejects(
      asApp(
        `
          UPDATE public.merch_marking_product_profiles
          SET operational_status = 'enabled'
          WHERE id = $1::uuid
        `,
        [pilot.profile_id],
      ),
      (error) => pgCode(error) === "42501",
    );
    await assert.rejects(
      asApp(
        `
          INSERT INTO public.merch_marking_profile_backfill_runs (
            source,
            created_by
          )
          VALUES ('direct-write', 'stage4-db-test')
        `,
      ),
      (error) => pgCode(error) === "42501",
    );

    console.log("Stage 4 PostgreSQL readiness, conflict and backfill checks passed");
  } finally {
    await pool.end();
  }
}

async function createProductFixture() {
  const suffix = randomUUID().slice(0, 8);
  const refs = await pool.query<{
    category_id: string;
    fabric_id: string;
    white_id: string;
    black_id: string;
    size_s_id: string;
    size_m_id: string;
    size_l_id: string;
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
        VALUES ($3, $4)
        RETURNING id
      ),
      white_color AS (
        INSERT INTO public.merch_colors (name)
        VALUES ('Белый')
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      ),
      black_color AS (
        INSERT INTO public.merch_colors (name)
        VALUES ('Черный')
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      ),
      size_s AS (
        INSERT INTO public.merch_sizes (name)
        VALUES ('S')
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      ),
      size_m AS (
        INSERT INTO public.merch_sizes (name)
        VALUES ('M')
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      ),
      size_l AS (
        INSERT INTO public.merch_sizes (name)
        VALUES ('L')
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      ),
      design AS (
        INSERT INTO public.merch_designs (name, type)
        VALUES ($5, 'print')
        RETURNING id
      ),
      decoration AS (
        INSERT INTO public.merch_decoration_types (name, slug, made_at)
        VALUES ($6, $7, 'own')
        RETURNING id
      )
      SELECT
        category.id AS category_id,
        fabric.id AS fabric_id,
        white_color.id AS white_id,
        black_color.id AS black_id,
        size_s.id AS size_s_id,
        size_m.id AS size_m_id,
        size_l.id AS size_l_id,
        design.id AS design_id,
        decoration.id AS decoration_type_id
      FROM category, fabric, white_color, black_color, size_s, size_m, size_l,
        design, decoration
    `,
    [
      `Stage4 T-Shirt ${suffix}`,
      `stage4-tshirt-${suffix}`,
      `Stage4 Cotton ${suffix}`,
      `stage4-cotton-${suffix}`,
      `Stage4 Design ${suffix}`,
      `Stage4 Print ${suffix}`,
      `stage4-print-${suffix}`,
    ],
  );
  const rows = await pool.query<{ id: string; sku: string }>(
    `
      INSERT INTO public.merch_products (
        category_id,
        fabric_id,
        color_id,
        size_id,
        design_id,
        decoration_type_id,
        sku,
        ozon_sku
      )
      VALUES
        ($1::uuid, $2::uuid, $3::uuid, $5::uuid, $7::uuid, $8::uuid, 'D15-TSH-PRT-WHT-S', 3134088371),
        ($1::uuid, $2::uuid, $4::uuid, $6::uuid, $7::uuid, $8::uuid, $9, 4100000001),
        ($1::uuid, $2::uuid, $3::uuid, $10::uuid, $7::uuid, $8::uuid, $11, 4100000002),
        ($1::uuid, $2::uuid, $3::uuid, $6::uuid, $7::uuid, $8::uuid, $12, 4100000003)
      RETURNING id, sku
    `,
    [
      refs.rows[0].category_id,
      refs.rows[0].fabric_id,
      refs.rows[0].white_id,
      refs.rows[0].black_id,
      refs.rows[0].size_s_id,
      refs.rows[0].size_m_id,
      refs.rows[0].design_id,
      refs.rows[0].decoration_type_id,
      `STAGE4-ATTR-${suffix}-M`,
      refs.rows[0].size_l_id,
      `STAGE4-OZON-${suffix}-L`,
      `STAGE4-BACKFILL-${suffix}-M`,
    ],
  );
  return {
    pilotId: rows.rows[0].id,
    attributeMismatchId: rows.rows[1].id,
    attributeMismatchSku: rows.rows[1].sku,
    ozonMismatchId: rows.rows[2].id,
    ozonMismatchSku: rows.rows[2].sku,
    backfillId: rows.rows[3].id,
    backfillSku: rows.rows[3].sku,
  };
}

async function upsertProfile(input: {
  productId: string;
  expectedRevision?: number | null;
  requirement: "unknown" | "required";
  offerId: string;
}) {
  const result = await asApp<{
    profile_id: string;
    revision: string;
    operational_status: string;
    verification_status: string;
  }>(
    `
      SELECT
        command.profile_id,
        command.revision,
        command.operational_status,
        command.verification_status
      FROM getomerch_marking.upsert_product_profile_draft(
        $1::uuid,
        $2::bigint,
        $3,
        CASE WHEN $3 = 'unknown' THEN NULL ELSE 'stage4_test' END,
        CASE WHEN $3 = 'unknown' THEN NULL ELSE clock_timestamp() END,
        'own_production',
        'jit_after_order',
        'ozon_fbs',
        $4,
        NULL,
        NULL,
        repeat('a', 64),
        'admin',
        'stage4-db-test'
      ) AS command
    `,
    [
      input.productId,
      input.expectedRevision ?? null,
      input.requirement,
      input.offerId,
    ],
  );
  return result.rows[0];
}

async function verifyProfile(input: {
  profileId: string;
  revision: number;
  gtin: string;
  declaredColor: string;
  declaredSize: string;
  catalogCardId?: string;
}) {
  const result = await asApp<{
    result_profile_id: string;
    trade_item_id: string;
    revision: string;
    verification_status: string;
  }>(
    `
      SELECT
        command.result_profile_id,
        command.trade_item_id,
        command.revision,
        command.verification_status
      FROM getomerch_marking.verify_trade_item_and_profile(
        $1::uuid,
        $2::bigint,
        $3,
        'clothes',
        '6109100000',
        $4,
        'published',
        'Футболка',
        'Хлопок',
        $5,
        $6,
        NULL,
        NULL,
        'national_catalog_test',
        repeat('b', 64),
        'stage4-db-reference',
        'admin',
        'stage4-db-test'
      ) AS command
    `,
    [
      input.profileId,
      input.revision,
      input.gtin,
      input.catalogCardId ?? null,
      input.declaredColor,
      input.declaredSize,
    ],
  );
  return result.rows[0];
}

async function setOperationalStatus(
  profileId: string,
  revision: number,
  status: "enabled" | "paused",
  reason: string | null,
) {
  const result = await asApp<{
    profile_id: string;
    operational_status: string;
    revision: string;
  }>(
    `
      SELECT command.profile_id, command.operational_status, command.revision
      FROM getomerch_marking.set_product_profile_operational_status(
        $1::uuid,
        $2::bigint,
        $3,
        $4,
        'admin',
        'stage4-db-test'
      ) AS command
    `,
    [profileId, revision, status, reason],
  );
  return result.rows[0];
}

async function insertOzonRequirement(
  productId: string,
  offerId: string,
  requirement: "required" | "not_required",
) {
  const key = `stage4:${randomUUID()}`;
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
  await pool.query(
    `
      INSERT INTO public.merch_fulfillment_order_items (
        fulfillment_order_id,
        source_item_key,
        product_id,
        offer_id,
        quantity,
        marking_requirement
      )
      VALUES ($1::uuid, $2, $3::uuid, $4, 1, $5)
    `,
    [order.rows[0].id, `${key}:item`, productId, offerId, requirement],
  );
}

async function createBackfillPreview(
  productId: string,
  sku: string,
  exactGtin: string,
) {
  const items = [{
    productId,
    action: "create_draft",
    channel: "ozon_fbs",
    offerId: sku,
    externalProductId: "4100000003",
    externalSku: "4100000003",
    markingRequirement: "unknown",
    productionMode: "own_production",
    fulfillmentMode: "jit_after_order",
    gtin: exactGtin,
    plan: {
      createsInactiveDraftOnly: true,
      confirmsGtin: false,
      enablesProfile: false,
    },
    errors: [],
    warnings: ["marking_requirement_requires_manual_confirmation"],
  }];
  const result = await asApp<{ run_id: string }>(
    `
      SELECT getomerch_marking.create_profile_backfill_preview(
        'stage4_test',
        '{"inference":"disabled"}'::jsonb,
        $1::jsonb,
        'stage4-db-test'
      ) AS run_id
    `,
    [JSON.stringify(items)],
  );
  return result.rows[0].run_id;
}

async function asApp<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  return inTransaction(async (client) => {
    await client.query("SET LOCAL ROLE getomerch_app");
    return client.query<Row>(sql, [...params]);
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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function makeGtin(prefix13: string) {
  assert.match(prefix13, /^[0-9]{13}$/);
  let sum = 0;
  for (let index = 0; index < prefix13.length; index += 1) {
    sum += Number(prefix13[index]) * (index % 2 === 0 ? 3 : 1);
  }
  return `${prefix13}${(10 - (sum % 10)) % 10}`;
}

function pgCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      return String((current as { code?: unknown }).code ?? "");
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return "";
}

function useSsl(value: string) {
  if (value.includes("host=/var/run/postgresql")) return false;
  try {
    return !["localhost", "127.0.0.1", "::1", ""].includes(new URL(value).hostname);
  } catch {
    return true;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
