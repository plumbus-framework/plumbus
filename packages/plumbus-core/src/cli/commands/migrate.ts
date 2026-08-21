// ── plumbus migrate ──
// Migration CLI — the framework governs all database schema operations.
// Never run manual SQL DDL — use these commands instead.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { loadConfig } from '../../config/loader.js';
import { openDataPlaneConnection } from '../../tenancy/data-plane-connection.js';
import { DATA_PLANE_MIGRATE_APPLICATION_NAME } from '../../tenancy/data-plane-migrate.js';
import {
  extractCreateTableNames,
  FRAMEWORK_TABLE_NAMES,
  formatDriftReport,
  getExistingFrameworkTables,
  inspectFrameworkDrift,
} from '../../data/drift-inspector.js';
import {
  formatRewriteSummary,
  rewriteFrameworkDriftMigration,
  rewriteHadEffect,
} from '../../data/framework-migration-rewriter.js';
import {
  applyMigrations,
  collectSchemas,
  readPendingMigrations,
  reconcileMigrationHistory,
  rollbackLastMigration,
} from '../../data/migration.js';
import { discoverResources } from '../discover.js';
import { info, error as logError, resolvePath, success, warn } from '../utils.js';

export interface MigrateOptions {
  json?: boolean;
  database?: string;
}

/** Same identifier rule as `--create-db` / `ensureDatabase`. */
const CLI_DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

function resolveCliDatabaseName(override: string | undefined, configName: string): string {
  if (override === undefined) {
    return configName;
  }
  if (!CLI_DATABASE_NAME_PATTERN.test(override)) {
    throw new Error(`Invalid database name: ${override}`);
  }
  return override;
}

function formatConnectError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatReconcileRecoveryMessage(): string {
  return [
    'If the live schema already matches the current Plumbus schema, run `plumbus migrate reconcile`',
    'to adopt the existing migration history without executing schema changes.',
    'Otherwise, fix or drop the conflicting framework tables before retrying.',
  ].join('\n');
}

/**
 * Open one database through the data-plane connection factory.
 * Pass the named tenant database (or the config default) as `database`.
 */
async function connectDb(
  database: string,
): Promise<{ db: PostgresJsDatabase; close: () => Promise<void> }> {
  const config = loadConfig({});
  const password = config.database.password;
  return openDataPlaneConnection({
    target: {
      host: config.database.host,
      port: config.database.port,
      database,
      user: config.database.user,
      ...(password ? { password } : {}),
      ...(config.database.ssl === undefined ? {} : { ssl: config.database.ssl }),
    },
    maxConnections: 1,
    applicationName: DATA_PLANE_MIGRATE_APPLICATION_NAME,
  });
}

/** Optional connect for generate's drift rewrite — missing driver is not fatal. */
async function tryConnectDb(
  database: string,
): Promise<{ db: PostgresJsDatabase; close: () => Promise<void> } | null> {
  try {
    return await connectDb(database);
  } catch {
    return null;
  }
}

/**
 * Create a database if it doesn't exist.
 * Connects to the 'postgres' maintenance DB to issue CREATE DATABASE.
 */
async function ensureDatabase(dbName: string): Promise<boolean> {
  try {
    const config = loadConfig({});
    const postgres = (await import('postgres')).default;
    const sql = postgres({
      host: config.database.host,
      port: config.database.port,
      database: 'postgres',
      username: config.database.user,
      password: config.database.password,
    });
    try {
      const rows = await sql`
        SELECT 1 FROM pg_database WHERE datname = ${dbName}
      `;
      if (rows.length === 0) {
        // CREATE DATABASE cannot be parameterized; use unsafe() with validated name
        if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
          throw new Error(`Invalid database name: ${dbName}`);
        }
        await sql.unsafe(`CREATE DATABASE "${dbName}"`);
        return true; // created
      }
      return false; // already existed
    } finally {
      await sql.end();
    }
  } catch (err) {
    throw new Error(
      `Failed to ensure database "${dbName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function registerMigrateCommand(program: Command): void {
  const cmd = program.command('migrate').description('Database migration management');

  // ── plumbus migrate generate ──
  cmd
    .command('generate')
    .description('Generate migration SQL files from entity definitions')
    .option('--json', 'Output as JSON')
    .action(async (opts: MigrateOptions) => {
      info('Discovering entity definitions...');

      try {
        const resources = await discoverResources();
        const schemas = collectSchemas(resources.entities, resources.schemas);
        const schemaCount = Object.keys(schemas).length;

        if (schemaCount === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ status: 'no_entities', migrations: [] }, null, 2));
          } else {
            warn('No entities found in app/entities/. Nothing to generate.');
          }
          return;
        }

        info(`Found ${schemaCount} entity schema(s): ${Object.keys(schemas).join(', ')}`);

        // Use drizzle-kit programmatic API to generate migration SQL
        const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');

        const outDir = resolvePath('drizzle');
        const metaDir = path.join(outDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        // Read previous snapshot if it exists
        const journalPath = path.join(metaDir, '_journal.json');
        const snapshotFiles = fs.existsSync(metaDir)
          ? fs
              .readdirSync(metaDir)
              .filter((f) => f.endsWith('.json') && f !== '_journal.json')
              .sort()
          : [];

        let prevSnapshot: any = null;
        let prevId: string | undefined;
        if (snapshotFiles.length > 0) {
          const lastSnapshotFile = snapshotFiles[snapshotFiles.length - 1] as string;
          const { parseDrizzleSnapshot } = await import('../migrate-snapshot-schema.js');
          prevSnapshot = parseDrizzleSnapshot(
            fs.readFileSync(path.join(metaDir, lastSnapshotFile), 'utf-8'),
            lastSnapshotFile,
          );
          prevId = prevSnapshot.prevId ?? prevSnapshot.id;
        }

        // Generate current snapshot from entity schemas
        const currentSnapshot = generateDrizzleJson(schemas, prevId);

        if (!prevSnapshot) {
          // First migration — generate from empty
          prevSnapshot = generateDrizzleJson({}, undefined);
        }

        const sqlStatements = await generateMigration(prevSnapshot, currentSnapshot);

        if (sqlStatements.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ status: 'no_changes', migrations: [] }, null, 2));
          } else {
            success('No schema changes detected.');
          }
          return;
        }

        // Write migration file
        const timestamp = Date.now();
        const tag = `${String(timestamp).padStart(14, '0')}_migration`;

        // ── Framework-drift rewrite ──
        // The rewriter does two things:
        //   1. If the live DB already contains framework-managed tables
        //      (e.g. the user is upgrading @plumbus/core), drizzle-kit's
        //      diff against a stale snapshot will emit CREATE TABLE for
        //      tables that already exist. The migrate-apply preflight then
        //      refuses to run those, leaving upgraders stuck. We inspect
        //      the live DB and rewrite those statements into safe ALTER
        //      TABLE ADD COLUMN statements derived from the drift report.
        //   2. Always (regardless of drift): wrap CREATE INDEX with
        //      IF NOT EXISTS and rewrite ALTER TABLE … ADD COLUMN to
        //      ADD COLUMN IF NOT EXISTS so the generated migration is
        //      idempotent against partial-state databases — a common
        //      situation when snapshots have gotten out of sync with hand-
        //      managed migrations.
        let finalStatements: string[] = sqlStatements;
        let rewriteSummaryForJson:
          | ReturnType<typeof rewriteFrameworkDriftMigration>['summary']
          | null = null;

        // Always perform the idempotency portion of the rewrite (no DB needed).
        // If we can also reach the DB, augment with framework-drift detection
        // so CREATE TABLE for existing framework tables is rewritten, not
        // just blocked at apply-time.
        const conn = await tryConnectDb(loadConfig({}).database.database);
        let driftReportForRewrite: Awaited<ReturnType<typeof inspectFrameworkDrift>> | null = null;
        if (conn) {
          try {
            driftReportForRewrite = await inspectFrameworkDrift(conn.db, resources.entities);
          } catch (err) {
            warn(
              `Drift inspection failed; framework-table drift will not be auto-rewritten. ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          } finally {
            await conn.close();
          }
        } else {
          warn(
            'Could not connect to the database to inspect framework drift. ' +
              'CREATE INDEX / ADD COLUMN idempotency will still be applied, but ' +
              'framework-table CREATE TABLE conflicts (if any) will only be caught ' +
              'at `plumbus migrate apply` time.',
          );
        }

        const rewrite = rewriteFrameworkDriftMigration(
          sqlStatements,
          driftReportForRewrite ?? {
            hasDrift: false,
            existingFrameworkTables: [],
            missingFrameworkTables: [],
            tables: [],
          },
          schemas,
        );
        if (rewriteHadEffect(rewrite.summary)) {
          finalStatements = rewrite.statements;
          rewriteSummaryForJson = rewrite.summary;
          if (!opts.json) {
            for (const line of formatRewriteSummary(rewrite.summary)) {
              info(line);
            }
          }
        }

        const migrationSql = finalStatements.join('\n');
        const migrationPath = path.join(outDir, `${tag}.sql`);
        fs.writeFileSync(migrationPath, migrationSql, 'utf-8');

        // Write snapshot
        const snapshotPath = path.join(metaDir, `${tag}.json`);
        fs.writeFileSync(snapshotPath, JSON.stringify(currentSnapshot, null, 2), 'utf-8');

        // Update journal
        const journal = fs.existsSync(journalPath)
          ? JSON.parse(fs.readFileSync(journalPath, 'utf-8'))
          : { version: '7', dialect: 'postgresql', entries: [] };
        journal.entries.push({
          idx: journal.entries.length,
          version: '7',
          when: timestamp,
          tag,
          breakpoints: true,
        });
        fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf-8');

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                status: 'generated',
                file: migrationPath,
                statements: finalStatements.length,
                ...(rewriteSummaryForJson ? { frameworkDriftRewrite: rewriteSummaryForJson } : {}),
              },
              null,
              2,
            ),
          );
        } else {
          success(`Migration generated: ${migrationPath}`);
          info(`${finalStatements.length} SQL statement(s) written.`);
          info('Run `plumbus migrate apply` to execute.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Migration generation failed: ${msg}`);
        }
      }
    });

  // ── plumbus migrate reconcile ──
  cmd
    .command('reconcile')
    .description('Backfill migration history when the live database is already in sync')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview the migrations that would be marked as applied')
    .option(
      '--database <name>',
      'Named database to reconcile (defaults to config.database.database)',
    )
    .action(async (opts: MigrateOptions & { dryRun?: boolean }) => {
      info('Reconciling migration history against the live schema...');

      const config = loadConfig({});
      let dbName: string;
      try {
        dbName = resolveCliDatabaseName(opts.database, config.database.database);
      } catch (err) {
        const msg = formatConnectError(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(msg);
        }
        return;
      }

      let conn: Awaited<ReturnType<typeof connectDb>>;
      try {
        conn = await connectDb(dbName);
      } catch (err) {
        const msg = formatConnectError(err);
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                status: 'no_db_connection',
                error: msg,
                database: dbName,
              },
              null,
              2,
            ),
          );
        } else {
          logError(msg);
        }
        return;
      }

      try {
        const migrationsFolder = resolvePath('drizzle');
        if (!fs.existsSync(migrationsFolder)) {
          if (opts.json) {
            console.log(
              JSON.stringify(
                { status: 'no_migrations', error: 'No drizzle/ folder found' },
                null,
                2,
              ),
            );
          } else {
            warn('No drizzle/ folder found. Run `plumbus migrate generate` first.');
          }
          return;
        }

        const resources = await discoverResources();
        const schemas = collectSchemas(resources.entities, resources.schemas);
        const { pushSchema } = await import('drizzle-kit/api');

        // Workaround for drizzle-kit#5293: pushSchema expects execute() to
        // return { rows }, but drizzle-orm's postgres-js driver returns rows
        // directly. Wrap the db instance to bridge the format.
        const wrappedDb = {
          execute: async (query: unknown) => {
            const rows = await conn.db.execute(query as never);
            return { rows };
          },
        };

        const diff = await pushSchema(schemas, wrappedDb as any, ['public'], undefined, undefined);
        if (diff.statementsToExecute.length > 0) {
          const msg =
            'Reconcile aborted: the live database does not match the current Plumbus schema.\n' +
            'Bring the schema in sync with `plumbus migrate apply`, `plumbus migrate push`,\n' +
            'or a targeted manual repair before adopting migration history.';
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  status: 'schema_mismatch',
                  error: msg,
                  statementCount: diff.statementsToExecute.length,
                  warnings: diff.warnings,
                },
                null,
                2,
              ),
            );
          } else {
            logError(msg);
            info(`Pending schema statements: ${diff.statementsToExecute.length}`);
          }
          return;
        }

        const migrationConfig = { db: conn.db, migrationsFolder };

        if (opts.dryRun) {
          const pending = await readPendingMigrations(migrationConfig);
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  status: 'dry_run',
                  wouldAdopt: pending.length,
                  migrations: pending.map((migration) => migration.tag),
                },
                null,
                2,
              ),
            );
          } else if (pending.length === 0) {
            success('Migration history is already in sync.');
          } else {
            info(
              `Dry run: would mark ${pending.length} migration(s) as applied: ${pending.map((migration) => migration.tag).join(', ')}`,
            );
          }
          return;
        }

        const result = await reconcileMigrationHistory(migrationConfig);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                status: 'reconciled',
                adopted: result.adopted,
                alreadyApplied: result.alreadyApplied,
                migrations: result.adoptedTags,
              },
              null,
              2,
            ),
          );
        } else if (result.adopted === 0) {
          success('Migration history is already in sync.');
        } else {
          success(
            `Reconciled migration history: marked ${result.adopted} migration(s) as applied.`,
          );
          info(`Adopted migrations: ${result.adoptedTags.join(', ')}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Reconcile failed: ${msg}`);
        }
      } finally {
        await conn.close();
      }
    });

  // ── plumbus migrate apply ──
  cmd
    .command('apply')
    .description('Apply pending migrations to the database')
    .option('--json', 'Output as JSON')
    .option('--create-db', 'Create the database if it does not exist')
    .option('--database <name>', 'Named database to apply to (defaults to config.database.database)')
    .action(async (opts: MigrateOptions & { createDb?: boolean }) => {
      const config = loadConfig({});
      let dbName: string;
      try {
        dbName = resolveCliDatabaseName(opts.database, config.database.database);
      } catch (err) {
        const msg = formatConnectError(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(msg);
        }
        return;
      }

      if (opts.createDb) {
        info(`Ensuring database "${dbName}" exists...`);
        try {
          const created = await ensureDatabase(dbName);
          if (created) {
            success(`Database "${dbName}" created.`);
          } else {
            info(`Database "${dbName}" already exists.`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
          } else {
            logError(msg);
          }
          return;
        }
      }

      info('Applying pending migrations...');

      let conn: Awaited<ReturnType<typeof connectDb>>;
      try {
        conn = await connectDb(dbName);
      } catch (err) {
        const msg = formatConnectError(err);
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                applied: 0,
                status: 'no_db_connection',
                error: msg,
                database: dbName,
              },
              null,
              2,
            ),
          );
        } else {
          logError(msg);
          info('Hint: Use --create-db to auto-create the database.');
        }
        return;
      }

      try {
        const migrationsFolder = resolvePath('drizzle');
        if (!fs.existsSync(migrationsFolder)) {
          if (opts.json) {
            console.log(
              JSON.stringify(
                { status: 'no_migrations', error: 'No drizzle/ folder found' },
                null,
                2,
              ),
            );
          } else {
            warn('No drizzle/ folder found. Run `plumbus migrate generate` first.');
          }
          return;
        }

        // Preflight: detect framework-table conflicts before executing
        const migrationConfig = { db: conn.db, migrationsFolder };
        const pending = await readPendingMigrations(migrationConfig);

        if (pending.length > 0) {
          const existingFramework = await getExistingFrameworkTables(conn.db);
          if (existingFramework.length > 0) {
            const frameworkSet = new Set<string>(FRAMEWORK_TABLE_NAMES as unknown as string[]);
            const conflicts: string[] = [];
            for (const migration of pending) {
              const creates = extractCreateTableNames(migration.rawSql);
              for (const name of creates) {
                if (frameworkSet.has(name) && existingFramework.includes(name)) {
                  conflicts.push(name);
                }
              }
            }
            if (conflicts.length > 0) {
              const unique = [...new Set(conflicts)];
              const msg =
                `Schema drift detected: framework table(s) already exist in the database: ${unique.join(', ')}.\n` +
                'These tables are managed by Plumbus and must not be created manually.\n' +
                `${formatReconcileRecoveryMessage()}`;
              if (opts.json) {
                console.log(
                  JSON.stringify(
                    { status: 'drift', conflictingTables: unique, error: msg, database: dbName },
                    null,
                    2,
                  ),
                );
              } else {
                logError(msg);
              }
              return;
            }
          }
        }

        const result = await applyMigrations(migrationConfig);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                status: 'applied',
                applied: result.applied,
                migrations: result.tags,
                database: dbName,
              },
              null,
              2,
            ),
          );
        } else {
          if (result.applied === 0) {
            success('No pending migrations.');
          } else {
            success(`${result.applied} migration(s) applied: ${result.tags.join(', ')}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Migration failed: ${msg}`);
        }
      } finally {
        await conn.close();
      }
    });

  // ── plumbus migrate push ──
  // Uses drizzle-kit's pushSchema API to diff entity schemas against the live
  // database and apply changes directly — no migration files, ideal for dev.
  cmd
    .command('push')
    .description('Push entity schemas directly to the database (no migration files, ideal for dev)')
    .option('--json', 'Output as JSON')
    .option('--create-db', 'Create the database if it does not exist')
    .option('--database <name>', 'Named database to push to (defaults to config.database.database)')
    .action(async (opts: MigrateOptions & { createDb?: boolean }) => {
      const config = loadConfig({});
      let dbName: string;
      try {
        dbName = resolveCliDatabaseName(opts.database, config.database.database);
      } catch (err) {
        const msg = formatConnectError(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(msg);
        }
        return;
      }

      if (opts.createDb) {
        info(`Ensuring database "${dbName}" exists...`);
        try {
          const created = await ensureDatabase(dbName);
          if (created) {
            success(`Database "${dbName}" created.`);
          } else {
            info(`Database "${dbName}" already exists.`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
          } else {
            logError(msg);
          }
          return;
        }
      }

      info('Discovering entity definitions...');

      try {
        const resources = await discoverResources();
        const schemas = collectSchemas(resources.entities, resources.schemas);
        const schemaCount = Object.keys(schemas).length;

        if (schemaCount === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ status: 'no_entities' }, null, 2));
          } else {
            warn('No entities found in app/entities/. Nothing to push.');
          }
          return;
        }

        info(`Found ${schemaCount} entity schema(s). Pushing to database...`);

        let conn: Awaited<ReturnType<typeof connectDb>>;
        try {
          conn = await connectDb(dbName);
        } catch (err) {
          const msg = formatConnectError(err);
          if (opts.json) {
            console.log(
              JSON.stringify({ status: 'error', error: msg, database: dbName }, null, 2),
            );
          } else {
            logError(msg);
          }
          return;
        }

        try {
          // Preflight: detect framework-table drift before handing control to Drizzle
          const driftReport = await inspectFrameworkDrift(conn.db, resources.entities);
          if (driftReport.hasDrift) {
            const lines = formatDriftReport(driftReport);
            const msg = `Schema drift detected in framework-managed tables:\n${lines.join('\n')}`;
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    status: 'drift',
                    existingFrameworkTables: driftReport.existingFrameworkTables,
                    tables: driftReport.tables.filter((t) => t.exists && t.columnDrifts.length > 0),
                    error: msg,
                    database: dbName,
                  },
                  null,
                  2,
                ),
              );
            } else {
              logError(msg);
            }
            return;
          }

          const { pushSchema } = await import('drizzle-kit/api');

          // Workaround for drizzle-kit#5293: pushSchema expects execute() to
          // return { rows }, but drizzle-orm's postgres-js driver returns rows
          // directly. Wrap the db instance to bridge the format.
          const wrappedDb = {
            execute: async (query: any) => {
              const rows = await conn.db.execute(query);
              return { rows };
            },
          };

          const result = await pushSchema(
            schemas,
            wrappedDb as any,
            ['public'],
            undefined,
            undefined,
          );

          if (result.statementsToExecute.length === 0) {
            if (opts.json) {
              console.log(JSON.stringify({ status: 'no_changes' }, null, 2));
            } else {
              success('Database schema is already up to date.');
            }
            return;
          }

          if (result.hasDataLoss) {
            warn(`Push involves ${result.warnings.length} potential data-loss change(s).`);
            for (const w of result.warnings) {
              warn(`  ${w}`);
            }
          }

          await result.apply();

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  status: 'pushed',
                  statements: result.statementsToExecute.length,
                  hasDataLoss: result.hasDataLoss,
                  warnings: result.warnings,
                },
                null,
                2,
              ),
            );
          } else {
            success(`Schema pushed: ${result.statementsToExecute.length} statement(s) applied.`);
          }
        } finally {
          await conn.close();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Detect Drizzle's interactive prompt / TTY failures and provide actionable guidance
        const isPromptError =
          err instanceof Error &&
          /setRawMode|isRaw|hanji|render.*terminal|stdin.*not.*tty/i.test(msg);
        if (isPromptError) {
          const normalized =
            'Push failed: Drizzle detected a schema conflict requiring interactive resolution,\n' +
            'but the current environment does not support interactive prompts.\n' +
            'This usually means a framework-managed table was created or modified manually.\n' +
            `${formatReconcileRecoveryMessage()}\n` +
            'If reconcile is not appropriate, fix the conflict and re-run, or use `plumbus migrate generate` + `plumbus migrate apply` instead.';
          if (opts.json) {
            console.log(
              JSON.stringify({ status: 'error', error: normalized, drizzleError: msg }, null, 2),
            );
          } else {
            logError(normalized);
          }
        } else if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Push failed: ${msg}`);
        }
      }
    });

  // ── plumbus migrate rollback ──
  cmd
    .command('rollback')
    .description('Rollback the last applied migration')
    .option('--json', 'Output as JSON')
    .option(
      '--database <name>',
      'Named database to roll back (defaults to config.database.database)',
    )
    .action(async (opts: MigrateOptions) => {
      info('Rolling back last migration...');

      const config = loadConfig({});
      let dbName: string;
      try {
        dbName = resolveCliDatabaseName(opts.database, config.database.database);
      } catch (err) {
        const msg = formatConnectError(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(msg);
        }
        return;
      }

      let conn: Awaited<ReturnType<typeof connectDb>>;
      try {
        conn = await connectDb(dbName);
      } catch (err) {
        const msg = formatConnectError(err);
        if (opts.json) {
          console.log(
            JSON.stringify(
              { status: 'no_db_connection', error: msg, database: dbName },
              null,
              2,
            ),
          );
        } else {
          logError(msg);
        }
        return;
      }

      try {
        const migrationsFolder = resolvePath('drizzle');
        const result = await rollbackLastMigration({ db: conn.db, migrationsFolder });

        if (opts.json) {
          console.log(JSON.stringify({ ...result, schemaReverted: false }, null, 2));
        } else if (result.status === 'no_migrations') {
          info('No migrations to rollback.');
        } else {
          success(`Rolled back migration: ${result.rolledBack}`);
          warn(
            'History only — the schema was not reverted. The migration record was removed so ' +
              '`plumbus migrate apply` will run it again; any tables, columns, or indexes it ' +
              'created still exist. Drop or restore them manually if the schema must change.',
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Rollback failed: ${msg}`);
        }
      } finally {
        await conn.close();
      }
    });
}

// ── plumbus db ──
// Database lifecycle commands

export function registerDbCommand(program: Command): void {
  const cmd = program.command('db').description('Database lifecycle management');

  cmd
    .command('create')
    .description('Create the application database from config')
    .option('--json', 'Output as JSON')
    .option('--test', 'Also create a separate test database (<dbname>_test)')
    .action(async (opts: MigrateOptions & { test?: boolean }) => {
      const config = loadConfig({});
      const dbName = config.database.database;

      try {
        const created = await ensureDatabase(dbName);
        if (opts.json) {
          const result: any = { database: dbName, created };
          if (opts.test) {
            const testCreated = await ensureDatabase(`${dbName}_test`);
            result.testDatabase = `${dbName}_test`;
            result.testCreated = testCreated;
          }
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (created) {
            success(`Database "${dbName}" created.`);
          } else {
            info(`Database "${dbName}" already exists.`);
          }

          if (opts.test) {
            const testDbName = `${dbName}_test`;
            const testCreated = await ensureDatabase(testDbName);
            if (testCreated) {
              success(`Test database "${testDbName}" created.`);
            } else {
              info(`Test database "${testDbName}" already exists.`);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(msg);
        }
      }
    });

  cmd
    .command('reset')
    .description('Drop and recreate the database, then apply all migrations')
    .option('--json', 'Output as JSON')
    .option('--test', 'Reset the test database instead')
    .action(async (opts: MigrateOptions & { test?: boolean }) => {
      const config = loadConfig({});
      const baseDbName = config.database.database;
      const dbName = opts.test ? `${baseDbName}_test` : baseDbName;

      info(`Resetting database "${dbName}"...`);

      try {
        const postgres = (await import('postgres')).default;
        const sql = postgres({
          host: config.database.host,
          port: config.database.port,
          database: 'postgres',
          username: config.database.user,
          password: config.database.password,
        });

        try {
          if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
            throw new Error(`Invalid database name: ${dbName}`);
          }

          // Terminate existing connections
          await sql`
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = ${dbName}
            AND pid <> pg_backend_pid()
          `;

          await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
          await sql.unsafe(`CREATE DATABASE "${dbName}"`);
          success(`Database "${dbName}" recreated.`);
        } finally {
          await sql.end();
        }

        // Apply migrations if drizzle/ folder exists
        const migrationsFolder = resolvePath('drizzle');
        if (fs.existsSync(migrationsFolder)) {
          info('Applying migrations...');
          const conn = await connectDb(dbName);
          if (conn) {
            try {
              await applyMigrations({ db: conn.db, migrationsFolder });
              success('Migrations applied.');
            } finally {
              await conn.close();
            }
          }
        } else {
          info('No drizzle/ folder found. Skipping migrations.');
        }

        if (opts.json) {
          console.log(JSON.stringify({ status: 'reset', database: dbName }, null, 2));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Reset failed: ${msg}`);
        }
      }
    });
}
