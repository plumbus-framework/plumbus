// ── plumbus seed ──
// Run seed files to populate the database with initial data.
// Seed files live in app/seeds/ and export a default async function
// that receives the Drizzle db instance, the raw postgres sql connection,
// and collected entity schemas.

import type { Command } from 'commander';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../config/loader.js';
import { collectSchemas } from '../../data/migration.js';
import { discoverResources } from '../discover.js';
import { info, error as logError, resolvePath, success, warn } from '../utils.js';

interface SeedOptions {
  json?: boolean;
  file?: string;
}

/**
 * Create a database connection from the loaded config.
 */
async function connectDb(): Promise<{
  db: PostgresJsDatabase;
  sql: any;
  close: () => Promise<void>;
} | null> {
  try {
    const config = loadConfig({});
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const postgres = (await import('postgres')).default;
    const sql = postgres({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      username: config.database.user,
      password: config.database.password,
    });
    return { db: drizzle(sql), sql, close: () => sql.end() };
  } catch {
    return null;
  }
}

/**
 * Discover seed files in the app/seeds/ directory.
 * Seed files must be .ts or .js files (not .d.ts or .test.ts).
 */
export function discoverSeedFiles(seedDir: string): string[] {
  if (!fs.existsSync(seedDir)) return [];

  return fs
    .readdirSync(seedDir)
    .filter(
      (f) =>
        (f.endsWith('.ts') || f.endsWith('.js')) &&
        !f.endsWith('.d.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.js'),
    )
    .sort()
    .map((f) => path.join(seedDir, f));
}

/**
 * Import and run a seed file.
 * The seed file must export a default function or a named "seed" function
 * with signature: (db, sql, schemas) => Promise<void>
 *
 * - db: Drizzle PostgresJsDatabase instance
 * - sql: Raw postgres.js tagged-template connection for parameterized queries
 * - schemas: Record of entity name → Drizzle pgTable
 */
export async function runSeedFile(
  filePath: string,
  db: PostgresJsDatabase,
  sql: any,
  schemas: Record<string, unknown>,
): Promise<void> {
  const fileUrl = pathToFileURL(filePath).href;
  const mod = (await import(fileUrl)) as Record<string, unknown>;

  const seedFn =
    typeof mod.default === 'function'
      ? (mod.default as (
          db: PostgresJsDatabase,
          sql: any,
          schemas: Record<string, unknown>,
        ) => Promise<void>)
      : typeof mod.seed === 'function'
        ? (mod.seed as (
            db: PostgresJsDatabase,
            sql: any,
            schemas: Record<string, unknown>,
          ) => Promise<void>)
        : null;

  if (!seedFn) {
    throw new Error(
      `Seed file ${path.basename(filePath)} must export a default function or a named "seed" function`,
    );
  }

  await seedFn(db, sql, schemas);
}

export function registerSeedCommand(program: Command): void {
  program
    .command('seed')
    .description('Run seed files from app/seeds/ to populate the database')
    .option('--json', 'Output as JSON')
    .option('--file <name>', 'Run a specific seed file instead of all')
    .action(async (opts: SeedOptions) => {
      const seedDir = resolvePath('app', 'seeds');

      // Discover seed files
      let seedFiles = discoverSeedFiles(seedDir);

      if (seedFiles.length === 0) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              { status: 'no_seeds', error: 'No seed files found in app/seeds/' },
              null,
              2,
            ),
          );
        } else {
          warn(
            'No seed files found in app/seeds/. Create .ts files that export a default async function.',
          );
        }
        return;
      }

      // Filter to specific file if --file is passed
      if (opts.file) {
        const match = seedFiles.find((f) => {
          const base = path.basename(f);
          return base === opts.file || base === `${opts.file}.ts` || base === `${opts.file}.js`;
        });
        if (!match) {
          if (opts.json) {
            console.log(
              JSON.stringify(
                { status: 'error', error: `Seed file "${opts.file}" not found` },
                null,
                2,
              ),
            );
          } else {
            logError(`Seed file "${opts.file}" not found in app/seeds/`);
          }
          return;
        }
        seedFiles = [match];
      }

      info(`Found ${seedFiles.length} seed file(s). Connecting to database...`);

      const conn = await connectDb();
      if (!conn) {
        if (opts.json) {
          console.log(
            JSON.stringify({ status: 'error', error: 'Could not connect to database' }, null, 2),
          );
        } else {
          logError('Could not connect to database. Check your config and database status.');
        }
        return;
      }

      try {
        // Discover entities and collect schemas so seed files can reference tables
        const resources = await discoverResources();
        const schemas = collectSchemas(resources.entities);

        // Register tsx loader to allow importing TypeScript seed files.
        let unregister: (() => void) | undefined;
        try {
          const require = createRequire(import.meta.url);
          const tsxPath = require.resolve('tsx/esm/api');
          const tsx = await import(pathToFileURL(tsxPath).href);
          unregister = tsx.register();
        } catch {
          // tsx not available; only .js seed files will work
        }

        let executed = 0;
        const errors: Array<{ file: string; error: string }> = [];

        try {
          for (const seedFile of seedFiles) {
            const fileName = path.basename(seedFile);
            try {
              if (!opts.json) info(`Running seed: ${fileName}`);
              await runSeedFile(seedFile, conn.db, conn.sql, schemas);
              executed++;
              if (!opts.json) success(`Seed completed: ${fileName}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push({ file: fileName, error: msg });
              if (!opts.json) logError(`Seed failed: ${fileName} — ${msg}`);
            }
          }
        } finally {
          unregister?.();
        }

        if (opts.json) {
          console.log(JSON.stringify({ status: 'done', executed, errors }, null, 2));
        } else if (errors.length === 0) {
          success(`All ${executed} seed(s) completed successfully.`);
        } else {
          warn(`${executed} seed(s) completed, ${errors.length} failed.`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Seed execution failed: ${msg}`);
        }
      } finally {
        await conn.close();
      }
    });
}
