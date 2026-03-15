// ── plumbus migrate ──
// Migration CLI — the framework governs all database schema operations.
// Never run manual SQL DDL — use these commands instead.

import type { Command } from 'commander';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { applyMigrations, collectSchemas, rollbackLastMigration } from '../../data/migration.js';
import { discoverResources } from '../discover.js';
import { info, error as logError, resolvePath, success, warn } from '../utils.js';

export interface MigrateOptions {
  json?: boolean;
}

/**
 * Create a database connection from the loaded config.
 * Returns null if connection cannot be established (e.g., no postgres module).
 */
async function connectDb(
  dbOverride?: string,
): Promise<{ db: PostgresJsDatabase; close: () => Promise<void> } | null> {
  try {
    const config = loadConfig({});
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const postgres = (await import('postgres')).default;
    const sql = postgres({
      host: config.database.host,
      port: config.database.port,
      database: dbOverride ?? config.database.database,
      username: config.database.user,
      password: config.database.password,
    });
    return { db: drizzle(sql), close: () => sql.end() };
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
        const schemas = collectSchemas(resources.entities);
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
          const lastSnapshotFile = snapshotFiles[snapshotFiles.length - 1];
          prevSnapshot = JSON.parse(fs.readFileSync(path.join(metaDir, lastSnapshotFile), 'utf-8'));
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
        const migrationSql = sqlStatements.join('\n');
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
              { status: 'generated', file: migrationPath, statements: sqlStatements.length },
              null,
              2,
            ),
          );
        } else {
          success(`Migration generated: ${migrationPath}`);
          info(`${sqlStatements.length} SQL statement(s) written.`);
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

  // ── plumbus migrate apply ──
  cmd
    .command('apply')
    .description('Apply pending migrations to the database')
    .option('--json', 'Output as JSON')
    .option('--create-db', 'Create the database if it does not exist')
    .action(async (opts: MigrateOptions & { createDb?: boolean }) => {
      const config = loadConfig({});
      const dbName = config.database.database;

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

      const conn = await connectDb();
      if (!conn) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              { applied: 0, status: 'no_db_connection', error: 'Could not connect to database' },
              null,
              2,
            ),
          );
        } else {
          logError('Could not connect to database. Check your config and database status.');
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

        await applyMigrations({ db: conn.db, migrationsFolder });

        if (opts.json) {
          console.log(JSON.stringify({ status: 'applied' }, null, 2));
        } else {
          success('Migrations applied successfully.');
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
    .action(async (opts: MigrateOptions & { createDb?: boolean }) => {
      const config = loadConfig({});
      const dbName = config.database.database;

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
        const schemas = collectSchemas(resources.entities);
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

        const conn = await connectDb();
        if (!conn) {
          if (opts.json) {
            console.log(
              JSON.stringify({ status: 'error', error: 'Could not connect to database' }, null, 2),
            );
          } else {
            logError('Could not connect to database.');
          }
          return;
        }

        try {
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
        if (opts.json) {
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
    .action(async (opts: MigrateOptions) => {
      info('Rolling back last migration...');

      const conn = await connectDb();
      if (!conn) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              { status: 'no_db_connection', error: 'Could not connect to database' },
              null,
              2,
            ),
          );
        } else {
          logError('Could not connect to database. Check your config and database status.');
        }
        return;
      }

      try {
        const migrationsFolder = resolvePath('drizzle');
        const result = await rollbackLastMigration({ db: conn.db, migrationsFolder });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.status === 'no_migrations') {
            info('No migrations to rollback.');
          } else {
            success(`Rolled back migration: ${result.rolledBack}`);
          }
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
