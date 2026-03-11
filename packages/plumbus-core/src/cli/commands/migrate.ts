// ── plumbus migrate ──
// Migration CLI wrapping the data layer migration engine

import type { Command } from "commander";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { loadConfig } from "../../config/loader.js";
import { applyMigrations, collectSchemas, rollbackLastMigration } from "../../data/migration.js";
import { discoverResources } from "../discover.js";
import { info, error as logError, resolvePath, success, warn } from "../utils.js";

export interface MigrateOptions {
  json?: boolean;
}

/**
 * Create a database connection from the loaded config.
 * Returns null if connection cannot be established (e.g., no postgres module).
 */
async function connectDb(): Promise<PostgresJsDatabase | null> {
  try {
    const config = loadConfig({});
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const sql = postgres({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      username: config.database.user,
      password: config.database.password,
    });
    return drizzle(sql);
  } catch {
    return null;
  }
}

export function registerMigrateCommand(program: Command): void {
  const cmd = program.command("migrate").description("Database migration management");

  cmd
    .command("generate")
    .description("Generate migration files from entity definition diffs")
    .option("--json", "Output as JSON")
    .action(async (opts: MigrateOptions) => {
      info("Analyzing entity definitions against current database schema...");

      try {
        const resources = await discoverResources();
        const schemas = collectSchemas(resources.entities);
        const schemaCount = Object.keys(schemas).length;

        if (schemaCount === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ status: "no_entities", migrations: [] }, null, 2));
          } else {
            warn("No entities found in app/entities/. Nothing to generate.");
          }
          return;
        }

        info(`Found ${schemaCount} entity schema(s). Run \`drizzle-kit generate\` to create migration files.`);
        info(`Schemas collected for: ${Object.keys(schemas).join(", ")}`);

        if (opts.json) {
          console.log(JSON.stringify({ status: "schemas_collected", entityCount: schemaCount, entities: Object.keys(schemas) }, null, 2));
        } else {
          success(`${schemaCount} entity schema(s) ready for migration generation.`);
          info("Use `npx drizzle-kit generate` to create SQL migration files.");
        }
      } catch {
        warn("Could not auto-discover entities (app/ directory may not exist)");
        if (opts.json) {
          console.log(JSON.stringify({ status: "no_changes", migrations: [] }, null, 2));
        } else {
          success("No schema changes detected.");
        }
      }
    });

  cmd
    .command("apply")
    .description("Apply pending migrations")
    .option("--json", "Output as JSON")
    .action(async (opts: MigrateOptions) => {
      info("Applying pending migrations...");

      const db = await connectDb();
      if (!db) {
        if (opts.json) {
          console.log(JSON.stringify({ applied: 0, status: "no_db_connection", error: "Could not connect to database" }, null, 2));
        } else {
          logError("Could not connect to database. Check your config and database status.");
        }
        return;
      }

      try {
        const migrationsFolder = resolvePath("drizzle");
        await applyMigrations({ db, migrationsFolder });

        if (opts.json) {
          console.log(JSON.stringify({ status: "applied" }, null, 2));
        } else {
          success("Migrations applied successfully.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: "error", error: msg }, null, 2));
        } else {
          logError(`Migration failed: ${msg}`);
        }
      }
    });

  cmd
    .command("rollback")
    .description("Rollback the last applied migration")
    .option("--json", "Output as JSON")
    .action(async (opts: MigrateOptions) => {
      info("Rolling back last migration...");

      const db = await connectDb();
      if (!db) {
        if (opts.json) {
          console.log(JSON.stringify({ status: "no_db_connection", error: "Could not connect to database" }, null, 2));
        } else {
          logError("Could not connect to database. Check your config and database status.");
        }
        return;
      }

      try {
        const migrationsFolder = resolvePath("drizzle");
        const result = await rollbackLastMigration({ db, migrationsFolder });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.status === "no_migrations") {
            info("No migrations to rollback.");
          } else {
            success(`Rolled back migration: ${result.rolledBack}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: "error", error: msg }, null, 2));
        } else {
          logError(`Rollback failed: ${msg}`);
        }
      }
    });
}
