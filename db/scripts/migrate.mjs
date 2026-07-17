#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const command = process.argv[2];
const validCommands = new Set(["status", "up", "verify"]);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const databaseDirectory = resolve(scriptDirectory, "..");
const migrationsDirectory = resolve(databaseDirectory, "migrations");
const checksDirectory = resolve(databaseDirectory, "checks");
const migrationPattern = /^(\d{4,})_([a-z0-9_]+)\.sql$/;
const checkPattern = /^\d{4,}_[a-z0-9_]+\.sql$/;
const advisoryLockName = "getomerch:schema-migrations:v1";

if (!validCommands.has(command)) {
  console.error("Usage: node db/scripts/migrate.mjs status|up|verify");
  process.exit(2);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareVersions(left, right) {
  const leftVersion = BigInt(left.version);
  const rightVersion = BigInt(right.version);
  return leftVersion < rightVersion ? -1 : leftVersion > rightVersion ? 1 : 0;
}

function postgresSsl() {
  const enabled =
    process.env.GETOMERCH_DATABASE_SSL ?? process.env.GETOMERCH_POSTGRES_SSL;
  if (enabled !== "true") {
    return undefined;
  }

  return {
    rejectUnauthorized:
      (process.env.GETOMERCH_DATABASE_SSL_REJECT_UNAUTHORIZED ??
        process.env.GETOMERCH_POSTGRES_SSL_REJECT_UNAUTHORIZED) !== "false",
  };
}

function clientConfig() {
  const config = {
    application_name: "getomerch-migrator",
    connectionTimeoutMillis: 10_000,
  };
  const connectionString = process.env.GETOMERCH_DATABASE_URL;
  const ssl = postgresSsl();

  if (connectionString) {
    config.connectionString = connectionString;
  }
  if (ssl) {
    config.ssl = ssl;
  }

  return config;
}

async function readMigrations() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) {
      continue;
    }

    const match = entry.name.match(migrationPattern);
    if (!match) {
      throw new Error(`Invalid migration filename: ${entry.name}`);
    }

    const sql = await readFile(resolve(migrationsDirectory, entry.name), "utf8");
    migrations.push({
      version: match[1],
      description: match[2],
      filename: entry.name,
      checksum: sha256(sql),
      sql,
    });
  }

  migrations.sort(compareVersions);
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (index > 0 && migrations[index - 1].version === migration.version) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
  }

  if (migrations.length === 0) {
    throw new Error("No migration files found");
  }

  return migrations;
}

async function readChecks() {
  const entries = await readdir(checksDirectory, { withFileTypes: true });
  const checks = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) {
      continue;
    }
    if (!checkPattern.test(entry.name)) {
      throw new Error(`Invalid verification filename: ${entry.name}`);
    }
    checks.push({
      filename: entry.name,
      sql: await readFile(resolve(checksDirectory, entry.name), "utf8"),
    });
  }

  checks.sort((left, right) => left.filename.localeCompare(right.filename));
  if (checks.length === 0) {
    throw new Error("No database verification files found");
  }
  return checks;
}

async function assertTargetDatabase(client) {
  const result = await client.query(
    "select current_database() as database_name, current_user as user_name",
  );
  const databaseName = result.rows[0]?.database_name;
  const userName = result.rows[0]?.user_name;

  if (!/^getomerch_[a-z0-9_]+$/.test(databaseName || "")) {
    throw new Error(
      `Refusing to run against database ${JSON.stringify(databaseName)}; ` +
        "the name must start with getomerch_",
    );
  }

  console.log(`Database: ${databaseName}; role: ${userName}`);
}

async function activateMigrationRole(client) {
  const migrationRole = process.env.GETOMERCH_MIGRATION_ROLE;
  if (!migrationRole) {
    return;
  }
  if (migrationRole !== "getomerch_owner") {
    throw new Error("GETOMERCH_MIGRATION_ROLE must be getomerch_owner");
  }

  await client.query("set role getomerch_owner");
  const result = await client.query("select current_user as user_name");
  if (result.rows[0]?.user_name !== migrationRole) {
    throw new Error(`Could not activate migration role ${migrationRole}`);
  }
  console.log(`Migration role: ${migrationRole}`);
}

async function ledgerExists(client) {
  const result = await client.query(
    "select to_regclass('getomerch_meta.schema_migrations') is not null as exists",
  );
  return result.rows[0]?.exists === true;
}

async function ensureLedger(client) {
  await client.query("begin");
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query(`
      create schema if not exists getomerch_meta;

      create table if not exists getomerch_meta.schema_migrations (
        version text primary key,
        description text not null,
        filename text not null unique,
        checksum_sha256 text not null,
        applied_at timestamp with time zone not null default clock_timestamp(),
        execution_ms bigint not null,
        constraint schema_migrations_version_check
          check (version ~ '^[0-9]{4,}$'),
        constraint schema_migrations_checksum_check
          check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        constraint schema_migrations_execution_ms_check
          check (execution_ms >= 0)
      );
    `);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function readAppliedMigrations(client) {
  if (!(await ledgerExists(client))) {
    return [];
  }

  const result = await client.query(`
    select version, description, filename, checksum_sha256, applied_at
    from getomerch_meta.schema_migrations
    order by version
  `);
  return result.rows;
}

function compareMigrations(migrations, appliedRows) {
  const filesByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );
  const appliedByVersion = new Map(
    appliedRows.map((migration) => [migration.version, migration]),
  );
  const states = [];

  for (const migration of migrations) {
    const applied = appliedByVersion.get(migration.version);
    let state = "pending";
    if (applied) {
      state =
        applied.filename === migration.filename &&
        applied.checksum_sha256 === migration.checksum
          ? "applied"
          : "checksum-mismatch";
    }
    states.push({ ...migration, state, applied });
  }

  for (const applied of appliedRows) {
    if (!filesByVersion.has(applied.version)) {
      states.push({
        version: applied.version,
        filename: applied.filename,
        state: "missing-file",
        applied,
      });
    }
  }

  return states.sort(compareVersions);
}

function printStates(states) {
  console.log("VERSION  STATE              FILE");
  for (const state of states) {
    console.log(
      `${state.version.padEnd(8)} ${state.state.padEnd(18)} ${state.filename}`,
    );
  }
}

function assertNoDivergence(states) {
  const divergence = states.filter((state) =>
    new Set(["checksum-mismatch", "missing-file"]).has(state.state),
  );
  if (divergence.length > 0) {
    throw new Error(
      "Migration history diverged from Git; applied migrations are immutable",
    );
  }
}

async function acquireMigrationLock(client) {
  const result = await client.query(
    "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
    [advisoryLockName],
  );
  if (result.rows[0]?.acquired !== true) {
    throw new Error("Another migration or verification process holds the lock");
  }
}

async function releaseMigrationLock(client) {
  await client.query(
    "select pg_advisory_unlock(hashtextextended($1, 0))",
    [advisoryLockName],
  );
}

async function runStatus(client, migrations) {
  const applied = await readAppliedMigrations(client);
  const states = compareMigrations(migrations, applied);
  printStates(states);
  assertNoDivergence(states);
}

async function runUp(client, migrations) {
  await acquireMigrationLock(client);
  try {
    await ensureLedger(client);
    const applied = await readAppliedMigrations(client);
    const states = compareMigrations(migrations, applied);
    assertNoDivergence(states);

    const pending = states.filter((state) => state.state === "pending");
    if (pending.length === 0) {
      console.log("No pending migrations");
      return;
    }

    for (const migration of pending) {
      const startedAt = process.hrtime.bigint();
      await client.query("begin");
      try {
        await client.query("set local lock_timeout = '5s'");
        await client.query("set local statement_timeout = '5min'");
        await client.query(migration.sql);
        const executionMs = Number(
          (process.hrtime.bigint() - startedAt) / 1_000_000n,
        );
        await client.query(
          `
            insert into getomerch_meta.schema_migrations (
              version,
              description,
              filename,
              checksum_sha256,
              execution_ms
            )
            values ($1, $2, $3, $4, $5)
          `,
          [
            migration.version,
            migration.description,
            migration.filename,
            migration.checksum,
            executionMs,
          ],
        );
        await client.query("commit");
        console.log(`Applied ${migration.filename} (${executionMs} ms)`);
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${migration.filename} failed: ${error.message}`);
      }
    }
  } finally {
    await releaseMigrationLock(client);
  }
}

async function runVerify(client, migrations) {
  await acquireMigrationLock(client);
  try {
    const applied = await readAppliedMigrations(client);
    const states = compareMigrations(migrations, applied);
    assertNoDivergence(states);

    const pending = states.filter((state) => state.state === "pending");
    if (pending.length > 0) {
      throw new Error(`${pending.length} migration(s) are still pending`);
    }

    const checks = await readChecks();
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    try {
      for (const check of checks) {
        const result = await client.query(check.sql);
        if (
          !result.rows.every(
            (row) =>
              typeof row.check_name === "string" && typeof row.ok === "boolean",
          )
        ) {
          throw new Error(
            `${check.filename} must return check_name and boolean ok columns`,
          );
        }

        for (const row of result.rows) {
          const state = row.ok ? "ok" : "FAILED";
          console.log(
            `${state.padEnd(6)} ${row.check_name}: actual=${row.actual}, expected=${row.expected}`,
          );
        }

        const failed = result.rows.filter((row) => !row.ok);
        if (failed.length > 0) {
          throw new Error(
            `${check.filename} reported ${failed.length} failed check(s)`,
          );
        }
      }
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await releaseMigrationLock(client);
  }
}

async function main() {
  const migrations = await readMigrations();
  const client = new Client(clientConfig());

  await client.connect();
  try {
    await assertTargetDatabase(client);
    await activateMigrationRole(client);
    await client.query("set timezone = 'UTC'");

    if (command === "status") {
      await runStatus(client, migrations);
    } else if (command === "up") {
      await runUp(client, migrations);
    } else {
      await runVerify(client, migrations);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Migration command failed: ${error.message}`);
  process.exitCode = 1;
});
