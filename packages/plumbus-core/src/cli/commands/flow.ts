// ── plumbus flow new ──
// Scaffold a new flow

import type { Command } from 'commander';
import * as path from 'node:path';
import { desc } from 'drizzle-orm';
import { loadConfig } from '../../config/loader.js';
import { closeDatabaseConnection, resolveDatabaseConnection } from '../../data/connection.js';
import { retryDeadLetteredFlow } from '../../flows/dead-letter.js';
import { flowDeadLetterTable } from '../../flows/schema.js';
import { enqueueFlowStep } from '../../flows/flow-queue.js';
import { resolveRuntimeQueues } from '../../runtime/queue-factory.js';
import { flowTemplate, flowTestTemplate } from '../templates/resources.js';
import { error, exists, info, resolvePath, success, toKebabCase, writeFile } from '../utils.js';
import { formatFlowScheduleLine, listFlowSchedules } from './flow-schedule-list.js';

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
      const config = loadConfig();
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

  dlq
    .command('retry <executionId>')
    .description('Reset a dead-lettered flow and re-enqueue after operator fix')
    .option('--actor <id>', 'Operator identity for attribution')
    .action(async (executionId: string, opts: { actor?: string }) => {
      const config = loadConfig();
      const actor = opts.actor ?? process.env.USER ?? 'operator';
      const connection = await resolveDatabaseConnection(config.database, {});
      const queues = await resolveRuntimeQueues(config);
      try {
        const result = await retryDeadLetteredFlow(connection.db, executionId, {
          actor,
          reason: 'operator-retry',
        });
        await enqueueFlowStep(queues.flows, executionId);
        success(`Retried flow ${result.executionId} by ${result.retriedBy}; re-enqueued step`);
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
