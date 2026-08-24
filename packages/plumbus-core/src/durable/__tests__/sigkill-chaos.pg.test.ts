import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createDurableTestHarness, type DurableTestHarness } from '../harness.js';
import { listUnpublishedOutbox, loadExecutionState } from '../postgres-persist.js';
import { resolveTestPostgresAdmin } from '../pg-env.js';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'sigkill-chaos-child.mjs');
const RUN_SIGKILL = process.env.PLUMBUS_DURABLE_TEST_RUN_SIGKILL === '1';

describe('SIGKILL chaos on two local Postgres DBs', () => {
  let harness: DurableTestHarness;

  afterAll(async () => {
    await harness?.close();
  });

  it('rolls back an uncommitted persist-before-ack when the writer is SIGKILL-ed', async () => {
    harness = await createDurableTestHarness();
    if (!RUN_SIGKILL) {
      expect(
        await loadExecutionState(harness.tenantDb, 'exec-sigkill', harness.coreSchema),
      ).toBeUndefined();
      return;
    }

    const admin = resolveTestPostgresAdmin();
    const child = spawn('nice', ['-n', '15', 'node', CHILD], {
      env: {
        ...process.env,
        DURABLE_TEST_TENANT_DB: harness.tenantName,
        DURABLE_TEST_CORE_SCHEMA: harness.coreSchema,
        PLUMBUS_TEST_PG_PORT: String(admin.port),
        PLUMBUS_TEST_PG_HOST: admin.host,
        PLUMBUS_TEST_PG_USER: admin.user,
        PLUMBUS_TEST_PG_PASSWORD: admin.password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    const readyWait = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not become READY')), 8_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (String(chunk).includes('READY')) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });

    try {
      await readyWait;
      if (!child.pid) throw new Error('child has no pid');
      process.kill(child.pid, 'SIGKILL');
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve());
        setTimeout(resolve, 2_000);
      });
    } finally {
      if (child.pid && !child.killed) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }

    expect(ready).toBe(true);
    expect(
      await loadExecutionState(harness.tenantDb, 'exec-sigkill', harness.coreSchema),
    ).toBeUndefined();
    expect(await listUnpublishedOutbox(harness.tenantDb, harness.coreSchema)).toEqual([]);
  }, 15_000);
});
