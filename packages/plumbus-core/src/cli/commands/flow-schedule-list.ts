// ── plumbus flow schedule list ──
// Merge code-defined flow schedules with runtime flow_schedules rows.

import { asc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { loadConfig } from '../../config/loader.js';
import { closeDatabaseConnection, resolveDatabaseConnection } from '../../data/connection.js';
import { flowSchedulesTable } from '../../flows/schema.js';
import { discoverRuntimeResources } from '../../runtime/bootstrap.js';
import type { FlowDefinition } from '../../types/flow.js';

export interface FlowScheduleListEntry {
  flowName: string;
  domain: string;
  cron: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  enabled: boolean;
  synced: boolean;
}

export interface FlowScheduleDbRow {
  flowName: string;
  cron: string;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  enabled: boolean;
}

export interface ListFlowSchedulesDeps {
  discoverResources?: typeof discoverRuntimeResources;
  querySchedules?: (db: PostgresJsDatabase) => Promise<FlowScheduleDbRow[]>;
}

function sortFlowScheduleEntries(entries: FlowScheduleListEntry[]): FlowScheduleListEntry[] {
  return [...entries].sort((a, b) => {
    if (a.nextRunAt === null && b.nextRunAt === null) {
      return a.flowName.localeCompare(b.flowName);
    }
    if (a.nextRunAt === null) {
      return 1;
    }
    if (b.nextRunAt === null) {
      return -1;
    }
    const byNext = a.nextRunAt.localeCompare(b.nextRunAt);
    if (byNext !== 0) {
      return byNext;
    }
    return a.flowName.localeCompare(b.flowName);
  });
}

/**
 * Merge registry-defined scheduled flows with flow_schedules DB rows.
 * DB rows are authoritative for cron and run timings when synced.
 */
export function mergeFlowScheduleList(
  dbRows: FlowScheduleDbRow[],
  scheduledFlows: Pick<FlowDefinition, 'name' | 'domain' | 'schedule'>[],
): FlowScheduleListEntry[] {
  const byName = new Map<string, FlowScheduleListEntry>();

  for (const flow of scheduledFlows) {
    const cron = flow.schedule?.cron;
    if (!cron) {
      continue;
    }
    byName.set(flow.name, {
      flowName: flow.name,
      domain: flow.domain,
      cron,
      lastRunAt: null,
      nextRunAt: null,
      enabled: true,
      synced: false,
    });
  }

  for (const row of dbRows) {
    const existing = byName.get(row.flowName);
    byName.set(row.flowName, {
      flowName: row.flowName,
      domain: existing?.domain ?? '',
      cron: row.cron,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      enabled: row.enabled,
      synced: true,
    });
  }

  return sortFlowScheduleEntries([...byName.values()]);
}

export function formatFlowScheduleLine(entry: FlowScheduleListEntry): string {
  const parts = [entry.flowName, `domain=${entry.domain || 'n/a'}`, `cron="${entry.cron}"`];
  if (entry.synced) {
    if (entry.nextRunAt) {
      parts.push(`next=${entry.nextRunAt}`);
    }
    if (entry.lastRunAt) {
      parts.push(`last=${entry.lastRunAt}`);
    }
  }
  parts.push(`enabled=${entry.enabled}`);
  parts.push(`synced=${entry.synced}`);
  return parts.join(' ');
}

export async function listFlowSchedules(
  deps: ListFlowSchedulesDeps = {},
): Promise<FlowScheduleListEntry[]> {
  const discoverResources = deps.discoverResources ?? discoverRuntimeResources;
  const querySchedules =
    deps.querySchedules ??
    (async (db) => db.select().from(flowSchedulesTable).orderBy(asc(flowSchedulesTable.nextRunAt)));

  const config = loadConfig();
  const connection = await resolveDatabaseConnection(config.database, {});
  try {
    const [resources, dbRows] = await Promise.all([
      discoverResources(),
      querySchedules(connection.db),
    ]);
    const scheduledFlows = resources.flows.filter((flow) => flow.schedule?.cron);
    return mergeFlowScheduleList(dbRows, scheduledFlows);
  } finally {
    await closeDatabaseConnection(connection);
  }
}
