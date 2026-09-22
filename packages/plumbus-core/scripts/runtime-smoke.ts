/**
 * Runtime smoke script for workers/queues wiring.
 * Run: npx tsx packages/plumbus-core/scripts/runtime-smoke.ts
 */
import { loadConfig } from '../src/config/loader.js';
import { dispatchQueuedJob } from '../src/jobs/dispatch.js';
import { createInMemoryQueue } from '../src/events/queue.js';
import {
  needsJobQueuePublish,
  needsWorkerPool,
  resolveRuntimeRole,
  shouldStartWorkerPool,
} from '../src/runtime/bootstrap.js';
import { resolveRuntimeQueues } from '../src/runtime/queue-factory.js';
import { z } from 'zod';
import { defineCapability } from '../src/define/index.js';

async function main(): Promise<void> {
  const role = resolveRuntimeRole('start', {});
  const workerPool = needsWorkerPool({
    capabilities: [{ kind: 'job', name: 'x', domain: 'd' } as never],
    entities: [],
    flows: [],
    events: [{ name: 'e' } as never],
    prompts: [],
    translations: [],
  });
  const jobPublish = needsJobQueuePublish({
    capabilities: [{ kind: 'job', name: 'x', domain: 'd' } as never],
    entities: [],
    flows: [],
    events: [],
    prompts: [],
    translations: [],
  });

  console.log('resolveRuntimeRole(start):', role);
  console.log('shouldStartWorkerPool(api):', shouldStartWorkerPool('api'));
  console.log('needsWorkerPool(with signals):', workerPool);
  console.log('needsJobQueuePublish(with job):', jobPublish);

  const config = loadConfig({ environment: 'development' });
  const queues = await resolveRuntimeQueues(config, { preferInMemory: true });
  console.log('resolveRuntimeQueues backend:', queues.backend, 'durable:', queues.isDurable);

  const cap = defineCapability({
    name: 'smokeJob',
    domain: 'smoke',
    kind: 'job',
    description: 'Smoke test job',
    input: z.object({ n: z.number() }),
    output: z.object({ ok: z.boolean() }),
    access: { public: true },
    effects: { data: [], events: [], external: [] },
    handler: async () => ({ ok: true }),
  });

  const db = {
    insert: () => ({
      values: () => ({
        returning: async () => [
          {
            id: 'smoke-job-1',
            capabilityDomain: 'smoke',
            capabilityName: 'smokeJob',
            status: 'queued',
            inputJson: { n: 1 },
            authSnapshotJson: { userId: 'u', roles: [], scopes: [], provider: 'smoke' },
            tenantId: null,
            correlationId: 'smoke-job-1',
            source: 'http',
            createdAt: new Date(),
          },
        ],
      }),
    }),
    update: () => ({ set: () => ({ where: async () => ({ rowCount: 0 }) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    delete: () => ({ where: async () => ({ rowCount: 0 }) }),
    execute: async () => [],
  } as never;

  const jobId = await dispatchQueuedJob({
    db,
    jobQueue: queues.jobs,
    capability: cap,
    input: { n: 1 },
    auth: { userId: 'u', roles: [], scopes: [], provider: 'smoke' },
    jobId: 'smoke-job-1',
  });
  console.log('dispatchQueuedJob id:', jobId);

  await queues.close();
  console.log('runtime smoke OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
