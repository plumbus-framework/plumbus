// ── plumbus run <script> ──
// Run application-defined command scripts from app/commands/.
// Command scripts export a default async function that receives the DB
// connection and parsed CLI arguments, enabling consumer apps to create
// custom operations (user setup, data migration, etc.) using the framework's
// infrastructure (config, DB, password hashing, etc.).

import type { Command } from 'commander';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../config/loader.js';
import { info, error as logError, resolvePath, success, warn } from '../utils.js';

interface RunOptions {
  json?: boolean;
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
 * Discover command scripts in app/commands/.
 */
function discoverCommands(commandsDir: string): string[] {
  if (!fs.existsSync(commandsDir)) return [];
  return fs
    .readdirSync(commandsDir)
    .filter(
      (f) =>
        (f.endsWith('.ts') || f.endsWith('.js')) &&
        !f.endsWith('.d.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.js'),
    )
    .sort()
    .map((f) => path.join(commandsDir, f));
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <script>')
    .description('Run an app command script from app/commands/')
    .option('--json', 'Output as JSON')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (script: string, opts: RunOptions, cmd: Command) => {
      const commandsDir = resolvePath('app', 'commands');

      // Discover available command scripts
      const commandFiles = discoverCommands(commandsDir);
      if (commandFiles.length === 0) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                status: 'error',
                error: 'No command scripts found in app/commands/',
              },
              null,
              2,
            ),
          );
        } else {
          warn(
            'No command scripts found in app/commands/. Create .ts files that export a default async function.',
          );
        }
        return;
      }

      // Find the matching script
      const match = commandFiles.find((f) => {
        const base = path.basename(f);
        const nameNoExt = base.replace(/\.(ts|js)$/, '');
        return base === script || nameNoExt === script;
      });

      if (!match) {
        const available = commandFiles.map((f) => path.basename(f).replace(/\.(ts|js)$/, ''));
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                status: 'error',
                error: `Command "${script}" not found`,
                available,
              },
              null,
              2,
            ),
          );
        } else {
          logError(`Command "${script}" not found in app/commands/`);
          info(`Available commands: ${available.join(', ')}`);
        }
        return;
      }

      // Collect pass-through arguments (everything after the script name)
      const passedArgs = cmd.args.slice(0);

      if (!opts.json) {
        info(`Running command: ${path.basename(match)}`);
      }

      // Connect to the database
      const conn = await connectDb();

      // Register tsx loader for TypeScript files
      let unregister: (() => void) | undefined;
      try {
        const require = createRequire(import.meta.url);
        const tsxPath = require.resolve('tsx/esm/api');
        const tsx = await import(pathToFileURL(tsxPath).href);
        unregister = tsx.register();
      } catch {
        // tsx not available; only .js command files will work
      }

      try {
        const fileUrl = pathToFileURL(match).href;
        const mod = (await import(fileUrl)) as Record<string, unknown>;

        const runFn =
          typeof mod.default === 'function'
            ? (mod.default as (ctx: {
                db: PostgresJsDatabase | null;
                sql: any;
                args: string[];
                close: () => Promise<void>;
              }) => Promise<void>)
            : typeof mod.run === 'function'
              ? (mod.run as (ctx: {
                  db: PostgresJsDatabase | null;
                  sql: any;
                  args: string[];
                  close: () => Promise<void>;
                }) => Promise<void>)
              : null;

        if (!runFn) {
          throw new Error(
            `Command file ${path.basename(match)} must export a default function or a named "run" function`,
          );
        }

        await runFn({
          db: conn?.db ?? null,
          sql: conn?.sql ?? null,
          args: passedArgs,
          close: conn?.close ?? (async () => {}),
        });

        if (!opts.json) {
          success(`Command completed: ${path.basename(match)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'error', error: msg }, null, 2));
        } else {
          logError(`Command failed: ${msg}`);
        }
      } finally {
        unregister?.();
        await conn?.close();
      }
    });
}
