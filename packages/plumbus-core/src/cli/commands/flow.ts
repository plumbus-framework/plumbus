import {
  replayDeadLetterFlow,
  FlowRegistry,
  createFlowScheduler,
  createFlowEngine,
} from '../../flows/index.js';
import type { ReconcileSchedulesOptions } from '../../flows/index.js';
import type { DiscoveredResources, DiscoverResourcesOptions } from '../discover.js';
import { discoverRuntimeResources, buildStepDeps } from '../../runtime/bootstrap.js';
import { loadServerExtensions } from '../../runtime/load-extensions.js';
import { CapabilityRegistry } from '../../execution/index.js';
// ── plumbus flow new ──
// Scaffold a new flow

import type { Command } from 'commander';
import { DataValidationError } from '../../errors/index.js';
import * as path from 'node:path';
import { desc } from 'drizzle-orm';
import { loadAppConfig } from '../../config/index.js';
import { closeDatabaseConnection, resolveDatabaseConnection } from '../../data/connection.js';
import { retryDeadLetteredFlow } from '../../flows/dead-letter.js';
import { flowDeadLetterTable } from '../../flows/schema.js';
import { enqueueFlowStep } from '../../flows/flow-queue.js';
import { resolveRuntimeQueues } from '../../runtime/queue-factory.js';
import { flowTemplate, flowTestTemplate } from '../templates/resources.js';
import { error, exists, info, resolvePath, success, toKebabCase, writeFile } from '../utils.js';
import { formatFlowScheduleLine, listFlowSchedules } from './flow-schedule-list.js';

/** Parse `--allow-remove`: `*` allows any removal, otherwise a comma-separated list of flow names. */
export function parseAllowRemove(value: string | undefined): readonly string[] | true | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '*') return true;
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

type ReconcileResult = Awaited<
  ReturnType<ReturnType<typeof createFlowScheduler>['reconcileSchedules']>
>;

export interface ScheduleSyncDeps {
  discover: (options: DiscoverResourcesOptions) => Promise<DiscoveredResources>;
  reconcile: (
    resources: DiscoveredResources,
    options: ReconcileSchedulesOptions,
  ) => Promise<ReconcileResult>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * `plumbus flow schedule sync`: discover flows strictly (a module that fails to
 * import would otherwise look like a removed schedule), reconcile, print the JSON
 * result to stdout and each removal to stderr.
 */
export async function runScheduleSync(
  options: ReconcileSchedulesOptions,
  deps: ScheduleSyncDeps,
): Promise<ReconcileResult> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const resources = await deps.discover({ strict: ['flows'] });
  const result = await deps.reconcile(resources, options);
  stdout(JSON.stringify(result, null, 2));
  const approved = (flowName: string) =>
    options.allowRemove === true || (options.allowRemove ?? []).includes(flowName);
  for (const change of result.changes.filter((c) => c.action === 'remove')) {
    if (result.applied) {
      stderr(`⚠ Removed schedule: ${change.flowName}`);
      continue;
    }
    stderr(
      approved(change.flowName)
        ? `⚠ Would remove schedule: ${change.flowName} (approved)`
        : `⚠ Would remove schedule: ${change.flowName} (if the flow was deleted on purpose, approve with --allow-remove ${change.flowName}; otherwise fix the flow registry)`,
    );
  }
  return result;
}

export function registerFlowCommand(program: Command): void {
  const cmd = program.command('flow').description('Manage flows');

  const dlq = cmd.command('dead-letter').description('Flow dead-letter operations');

  dlq
    .command('list')
    .description('List flow dead-letter rows')
    .option('--limit <n>', 'Max rows', '20')
    .option('--json', 'Output JSON')
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit ?? '20', 10);
      const config = await loadAppConfig();
      const connection = await resolveDatabaseConnection(config.database, {});
      try {
        const rows = await connection.db
          .select()
          .from(flowDeadLetterTable)
          .orderBy(desc(flowDeadLetterTable.failedAt))
          .limit(limit);
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        for (const row of rows) {
          info(`${row.executionId} flow=${row.flowName} retries=${row.retryCount}`);
        }
      } finally {
        await closeDatabaseConnection(connection);
      }
    });

  const schedule = cmd.command('schedule').description('Flow schedule operations');

  schedule
    .command('list')
    .description('List scheduled flows and their cron timings')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const schedules = await listFlowSchedules();
        if (opts.json) {
          console.log(JSON.stringify({ schedules }, null, 2));
          return;
        }
        if (schedules.length === 0) {
          info('No scheduled flows registered');
          return;
        }
        for (const entry of schedules) {
          info(formatFlowScheduleLine(entry));
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  schedule
    .command('sync')
    .description('Preview or apply the complete deployed schedule manifest')
    .option('--apply', 'Apply the previewed changes')
    .option('--expected-revision <revision>', 'Revision from the preview; required with --apply')
    .option(
      '--allow-remove <flows>',
      'Comma-separated flow names whose schedules --apply may remove, or "*" for any',
    )
    .action(async (opts: { apply?: boolean; expectedRevision?: string; allowRemove?: string }) => {
      const options = {
        apply: opts.apply,
        expectedRevision: opts.expectedRevision,
        allowRemove: parseAllowRemove(opts.allowRemove),
      };
      const config = await loadAppConfig();
      const connection = await resolveDatabaseConnection(config.database, {});
      let ext: Awaited<ReturnType<typeof loadServerExtensions>> | undefined;
      let refused = false;
      try {
        await runScheduleSync(options, {
          discover: discoverRuntimeResources,
          reconcile: async (resources, reconcileOptions) => {
            const registry = new FlowRegistry();
            for (const flow of resources.flows) registry.register(flow);
            const capabilities = new CapabilityRegistry();
            capabilities.registerAll(resources.capabilities);
            const engine = createFlowEngine({
              db: connection.db,
              registry,
              stepDeps: buildStepDeps(capabilities),
            });
            // Reconcile every plane the worker schedules on (the same planes `app/server.ts`
            // gives it).
            ext = await loadServerExtensions(process.cwd());
            if (ext.dataPlaneResolver && !ext.listTenantRefs) {
              // The worker schedules `tenants` flows on every plane it resolves; this command
              // can only reach the planes the host lists. Refuse rather than report a clean
              // result.
              const tenantScheduled = registry
                .getScheduled()
                .filter((flow) => (flow.schedule?.plane ?? 'tenants') === 'tenants');
              if (tenantScheduled.length > 0) {
                refused = true;
                throw new DataValidationError(
                  `app/server.ts exports dataPlaneResolver without listTenantRefs; the tenant-plane schedules (${tenantScheduled
                    .map((flow) => flow.name)
                    .join(', ')}) cannot be enumerated for reconciliation. Export listTenantRefs.`,
                  { flowNames: tenantScheduled.map((flow) => flow.name) },
                );
              }
            }
            // Same precedence as the worker (worker/bootstrap.ts): a data-plane resolver wins
            // over schedulePlanes, and tenant-plane runs live on their plane (spine dispatch).
            const planes = ext.dataPlaneResolver
              ? {
                  resolver: ext.dataPlaneResolver,
                  listTenantRefs: ext.listTenantRefs ?? (() => []),
                  tenantExecutions: 'schedule-plane' as const,
                }
              : ext.schedulePlanes
                ? { ...ext.schedulePlanes, tenantExecutions: 'pool' as const }
                : {};
            return createFlowScheduler({
              db: connection.db,
              registry,
              engine,
              ...planes,
            }).reconcileSchedules(reconcileOptions);
          },
        });
      } catch (err) {
        if (!refused) throw err;
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        // A pooled resolver holds a connection per plane it resolved; release them.
        for (const resolver of [ext?.dataPlaneResolver, ext?.schedulePlanes?.resolver]) {
          const closable = resolver as { close?: () => Promise<void> } | undefined;
          await closable?.close?.().catch(() => undefined);
        }
        await closeDatabaseConnection(connection);
      }
    });

  dlq
    .command('retry <executionId>')
    .description(
      'Replay a failed flow step as a new execution (--in-place resets the same execution)',
    )
    .option('--actor <id>', 'Operator identity for attribution')
    .option('--in-place', 'Reset the dead-lettered execution instead of replaying it')
    .action(async (executionId: string, opts: { actor?: string; inPlace?: boolean }) => {
      const config = await loadAppConfig();
      const actor = opts.actor ?? process.env.USER ?? 'operator';
      const connection = await resolveDatabaseConnection(config.database, {});
      const queues = await resolveRuntimeQueues(config);
      try {
        if (opts.inPlace) {
          const result = await retryDeadLetteredFlow(connection.db, executionId, {
            actor,
            reason: 'operator-retry',
          });
          try {
            await enqueueFlowStep(queues.flows, executionId);
          } catch {
            info('Retry persisted; worker database reconciliation will recover its wake');
          }
          success(`Retried flow ${result.executionId} by ${result.retriedBy}; re-enqueued step`);
          return;
        }
        const registry = new FlowRegistry();
        const resources = await discoverRuntimeResources();
        for (const flow of resources.flows) registry.register(flow);
        const replayId = await replayDeadLetterFlow(connection.db, registry, executionId, {
          actor,
        });
        try {
          await enqueueFlowStep(queues.flows, replayId);
        } catch {
          info('Replay persisted; worker database reconciliation will recover its wake');
        }
        success(`Replay execution ${replayId} (source ${executionId})`);
      } finally {
        await queues.close();
        await closeDatabaseConnection(connection);
      }
    });

  cmd
    .command('new <name>')
    .description('Scaffold a new flow')
    .option('--domain <domain>', 'Domain name', 'default')
    .action((name: string, opts: { domain?: string }) => {
      const domain = opts.domain ?? 'default';
      const kebab = toKebabCase(name);
      const baseDir = resolvePath('app', 'flows', domain, kebab);

      if (exists(baseDir)) {
        error(`Flow "${kebab}" already exists in domain "${domain}"`);
        process.exit(1);
      }

      writeFile(path.join(baseDir, 'flow.ts'), flowTemplate(name, domain));
      writeFile(path.join(baseDir, 'tests', `${kebab}.test.ts`), flowTestTemplate(name, domain));

      success(`Created flow: app/flows/${domain}/${kebab}/`);
    });
}
