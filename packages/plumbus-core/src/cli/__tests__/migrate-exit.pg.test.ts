import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDurableTestDatabase, resolveTestPostgresAdmin } from '../../durable/index.js';

const cli = fileURLToPath(new URL('../../../bin/plumbus.js', import.meta.url));

describe('migrate apply process exit status', () => {
  it.each([
    false,
    true,
  ])('exits nonzero on SQL failure and zero on success (json=%s)', async (json) => {
    const admin = resolveTestPostgresAdmin();
    const database = await createDurableTestDatabase({ admin, kind: 'cli_exit', ddl: '' });
    const directory = mkdtempSync(join(tmpdir(), 'plumbus-migrate-exit-'));
    try {
      const version = JSON.parse(
        readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
      ).version;
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'migration-exit-fixture',
          private: true,
          type: 'module',
          dependencies: { '@plumbus/core': version },
        }),
      );
      mkdirSync(join(directory, 'drizzle/meta'), { recursive: true });
      writeFileSync(
        join(directory, 'drizzle/meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [{ idx: 0, version: '7', when: 1, tag: '0000_probe', breakpoints: true }],
        }),
      );
      const file = join(directory, 'drizzle/0000_probe.sql');
      const run = () =>
        spawnSync(process.execPath, [cli, 'migrate', 'apply', ...(json ? ['--json'] : [])], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            ...process.env,
            DATABASE_HOST: admin.host,
            DATABASE_PORT: String(admin.port),
            DATABASE_NAME: database.name,
            DATABASE_USER: admin.user,
            DATABASE_PASSWORD: admin.password,
          },
        });
      writeFileSync(file, 'SELECT missing_migration_function();');
      const failure = run();
      expect(failure.error).toBeUndefined();
      expect(failure.status, failure.stdout + failure.stderr).toBe(1);
      expect(failure.stdout + failure.stderr).toContain('missing_migration_function');
      if (json) expect(failure.stdout).toContain('"status": "error"');
      writeFileSync(file, 'SELECT 1;');
      const success = run();
      expect(success.error).toBeUndefined();
      expect(success.status, success.stdout + success.stderr).toBe(0);
      expect(success.stdout).toContain(json ? '"status": "applied"' : 'migration(s) applied');
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await database.close();
    }
  }, 45_000);
});
