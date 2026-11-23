// ── Flow lanes ──
// Limits on what one worker pool's runner slots run at once, beyond `flowConcurrency`: slots
// held for flows with no tenant, a ceiling per tenant, per flow and per named lane (flows
// grouped by name or domain), and a claim order that serves the tenant with the fewest
// executions running first. Bookkeeping only: the pool asks for the claims to try, in order
// (`claimPlan`), records what it claimed (`admit`) and what ended (`release`). Every count is
// this pool's; nothing here reads the database.

import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';
import type { FlowClaimFilter } from '../flows/engine.js';
import type { FlowLanesConfig, FlowTenantOrder } from '../types/config.js';

/** The ceiling every count in a lane takes, the same one `flowConcurrency` has. */
const MAX_LANE = 256;

/** Which limit holds a set of executions back. */
export const FlowLaneKind = {
  /** Tenant executions reached `flowConcurrency - reservedUntenanted`. */
  UntenantedReserve: 'untenanted-reserve',
  /** One tenant reached `maxPerTenant`. */
  Tenant: 'tenant',
  /** One flow reached `maxPerFlow`. */
  Flow: 'flow',
  /** A named lane reached its `max`. */
  Lane: 'lane',
} as const;
export type FlowLaneKind = (typeof FlowLaneKind)[keyof typeof FlowLaneKind];

export interface ResolvedFlowLane {
  name: string;
  max: number;
  flows: ReadonlySet<string>;
}

export interface ResolvedFlowLanes {
  slots: number;
  reservedUntenanted: number;
  maxPerTenant?: number;
  maxPerFlow?: number;
  lanes: readonly ResolvedFlowLane[];
  tenantOrder: FlowTenantOrder;
}

const count = z.number().int().min(1).max(MAX_LANE);

const flowLanesSchema = z
  .object({
    reservedUntenanted: z.number().int().min(0).max(MAX_LANE).optional(),
    maxPerTenant: count.optional(),
    maxPerFlow: count.optional(),
    lanes: z
      .record(
        z.string().min(1),
        z
          .object({
            max: count,
            flows: z.array(z.string().min(1)).optional(),
            domains: z.array(z.string().min(1)).optional(),
          })
          .strict(),
      )
      .optional(),
    tenantOrder: z.enum(['fair', 'fifo']).optional(),
  })
  .strict();

/** Flow names a lane resolves against: the pool's registry, by name and by domain. */
export interface FlowLaneCatalog {
  has(flowName: string): boolean;
  namesInDomain(domain: string): string[];
}

/**
 * Validate `workers.flowLanes` against the pool's slot count and registry. `undefined` (lanes
 * off) for no configuration. Throws `DataValidationError` for an out-of-range value, a held
 * slot count that leaves tenant flows none, or a lane that names nothing; `warn` hears about
 * lane members the registry does not have (a typo, or a flow this worker does not run).
 */
export function resolveFlowLanes(
  config: FlowLanesConfig | undefined,
  slots: number,
  catalog: FlowLaneCatalog,
  warn: (message: string, metadata: Record<string, unknown>) => void = () => {},
): ResolvedFlowLanes | undefined {
  if (config === undefined) return undefined;
  const parsed = flowLanesSchema.safeParse(config);
  if (!parsed.success) {
    throw new DataValidationError(
      `Invalid workers.flowLanes: ${parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  const value = parsed.data;
  const reservedUntenanted = value.reservedUntenanted ?? 0;
  if (reservedUntenanted >= slots) {
    throw new DataValidationError(
      `workers.flowLanes.reservedUntenanted (${reservedUntenanted}) must be less than flowConcurrency (${slots}): tenant flows would never run`,
    );
  }
  const lanes: ResolvedFlowLane[] = [];
  for (const [name, lane] of Object.entries(value.lanes ?? {})) {
    const flows = new Set<string>();
    for (const flow of lane.flows ?? []) {
      if (!catalog.has(flow)) {
        warn('Flow lane names a flow this worker does not have', { lane: name, flow });
      }
      flows.add(flow);
    }
    for (const domain of lane.domains ?? []) {
      const names = catalog.namesInDomain(domain);
      if (names.length === 0) {
        warn('Flow lane names a domain with no flow in this worker', { lane: name, domain });
      }
      for (const flow of names) flows.add(flow);
    }
    if ((lane.flows?.length ?? 0) === 0 && (lane.domains?.length ?? 0) === 0) {
      throw new DataValidationError(`workers.flowLanes.lanes.${name} names no flow and no domain`);
    }
    lanes.push({ name, max: lane.max, flows });
  }
  return Object.freeze({
    slots,
    reservedUntenanted,
    ...(value.maxPerTenant !== undefined ? { maxPerTenant: value.maxPerTenant } : {}),
    ...(value.maxPerFlow !== undefined ? { maxPerFlow: value.maxPerFlow } : {}),
    lanes: Object.freeze(lanes),
    tenantOrder: value.tenantOrder ?? 'fair',
  });
}

/** One execution a runner slot is draining, as the lanes count it. */
export interface FlowLaneEntry {
  readonly executionId: string;
  /** The execution's tenant; `undefined` for a flow with no tenant. */
  readonly tenant?: string;
  readonly flow: string;
  /**
   * The limit the execution broke when it was claimed, if any. A claim filters by the spine
   * hint's tenant route and definition id; a host acceptance that wrote other values there can
   * hand back an execution a limit should have held back. The pool releases such a claim.
   */
  readonly exceeded?: { kind: FlowLaneKind; key: string };
}

/** A limit reached now: what it holds back and since when. */
export interface FlowLaneFull {
  kind: FlowLaneKind;
  /** The tenant, the flow, the lane's name, or `'tenants'` for the held untenanted slots. */
  key: string;
  running: number;
  max: number;
  /** When the limit was reached (ISO 8601). */
  since: string;
}

/** What `WorkerPool.flowLanes` reports. */
export interface FlowLaneSnapshot {
  slots: number;
  reservedUntenanted: number;
  maxPerTenant?: number;
  maxPerFlow?: number;
  tenantOrder: FlowTenantOrder;
  running: {
    total: number;
    untenanted: number;
    tenanted: number;
    byTenant: Record<string, number>;
    byFlow: Record<string, number>;
    byLane: Record<string, number>;
  };
  /** Limits reached now; executions they cover wait in the database until one ends. */
  full: FlowLaneFull[];
}

export interface FlowLaneTracker {
  /** The claims to try, in order, until one returns an execution. Empty: claim nothing. */
  claimPlan(): FlowClaimFilter[];
  /** Count a claimed execution; reports a limit it broke (see `FlowLaneEntry.exceeded`). */
  admit(execution: { executionId: string; tenant?: string; flow: string }): FlowLaneEntry;
  /** Stop counting an execution whose drain ended. */
  release(entry: FlowLaneEntry): void;
  snapshot(): FlowLaneSnapshot;
}

function increment(map: Map<string, number>, key: string, by: number): void {
  const next = (map.get(key) ?? 0) + by;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

/**
 * Track the executions a pool runs against its lanes. `onFull` hears each limit the moment it
 * is reached (once per reach; again only after it had room).
 */
export function createFlowLaneTracker(
  lanes: ResolvedFlowLanes,
  onFull: (full: FlowLaneFull) => void = () => {},
): FlowLaneTracker {
  const entries = new Set<FlowLaneEntry>();
  const byTenant = new Map<string, number>();
  const byFlow = new Map<string, number>();
  const byLane = new Map<string, number>();
  let tenanted = 0;
  let untenanted = 0;
  const tenantSlots = lanes.slots - lanes.reservedUntenanted;
  /** Limits reached now, by `kind:key`. */
  const fullSince = new Map<string, FlowLaneFull>();
  const lanesOf = new Map<string, ResolvedFlowLane[]>();
  for (const lane of lanes.lanes) {
    for (const flow of lane.flows) {
      const list = lanesOf.get(flow) ?? [];
      list.push(lane);
      lanesOf.set(flow, list);
    }
  }

  function limitsOf(execution: { tenant?: string; flow: string }): Array<{
    kind: FlowLaneKind;
    key: string;
    running: number;
    max: number;
  }> {
    const limits: Array<{ kind: FlowLaneKind; key: string; running: number; max: number }> = [];
    if (execution.tenant !== undefined) {
      if (lanes.reservedUntenanted > 0) {
        limits.push({
          kind: FlowLaneKind.UntenantedReserve,
          key: 'tenants',
          running: tenanted,
          max: tenantSlots,
        });
      }
      if (lanes.maxPerTenant !== undefined) {
        limits.push({
          kind: FlowLaneKind.Tenant,
          key: execution.tenant,
          running: byTenant.get(execution.tenant) ?? 0,
          max: lanes.maxPerTenant,
        });
      }
    }
    if (lanes.maxPerFlow !== undefined) {
      limits.push({
        kind: FlowLaneKind.Flow,
        key: execution.flow,
        running: byFlow.get(execution.flow) ?? 0,
        max: lanes.maxPerFlow,
      });
    }
    for (const lane of lanesOf.get(execution.flow) ?? []) {
      limits.push({
        kind: FlowLaneKind.Lane,
        key: lane.name,
        running: byLane.get(lane.name) ?? 0,
        max: lane.max,
      });
    }
    return limits;
  }

  /** Flows no claim may take now: those at `maxPerFlow`, and every flow of a full lane. */
  function heldFlows(): string[] {
    const held = new Set<string>();
    if (lanes.maxPerFlow !== undefined) {
      for (const [flow, running] of byFlow) if (running >= lanes.maxPerFlow) held.add(flow);
    }
    for (const lane of lanes.lanes) {
      if ((byLane.get(lane.name) ?? 0) >= lane.max) for (const flow of lane.flows) held.add(flow);
    }
    return [...held].sort();
  }

  function tenantsAtOrAbove(level: number): string[] {
    const held: string[] = [];
    for (const [tenant, running] of byTenant) if (running >= level) held.push(tenant);
    return held;
  }

  function cappedTenants(): string[] {
    return lanes.maxPerTenant === undefined ? [] : tenantsAtOrAbove(lanes.maxPerTenant);
  }

  function filter(
    excludeFlows: string[],
    excludeTenants: string[],
    extra: Pick<FlowClaimFilter, 'tenancy' | 'untenantedFirst'> = {},
  ): FlowClaimFilter {
    return {
      ...(excludeFlows.length > 0 ? { excludeFlows } : {}),
      ...(excludeTenants.length > 0 ? { excludeTenants: [...excludeTenants].sort() } : {}),
      ...extra,
    };
  }

  function claimPlan(): FlowClaimFilter[] {
    const excludeFlows = heldFlows();
    if (tenanted >= tenantSlots) {
      // Every slot tenant flows may fill is taken: only untenanted flows may start.
      return [filter(excludeFlows, [], { tenancy: 'untenanted' })];
    }
    const capped = cappedTenants();
    if (lanes.tenantOrder === 'fifo') return [filter(excludeFlows, capped)];
    // Fair: first the tenants with nothing running here, then those with one, and so on, each
    // pass oldest first. Untenanted flows count as one more tenant and go first among equals.
    let highest = untenanted;
    for (const running of byTenant.values()) highest = Math.max(highest, running);
    const plan: FlowClaimFilter[] = [];
    let previous = '';
    for (let level = 1; level <= highest + 1; level += 1) {
      const held = new Set([...capped, ...tenantsAtOrAbove(level)]);
      const attempt = filter(excludeFlows, [...held], {
        untenantedFirst: true,
        ...(untenanted >= level ? { tenancy: 'tenanted' as const } : {}),
      });
      const key = JSON.stringify(attempt);
      if (key !== previous) plan.push(attempt);
      previous = key;
    }
    return plan;
  }

  function noteFull(): void {
    const now = new Date().toISOString();
    const reached = new Map<string, Omit<FlowLaneFull, 'since'>>();
    if (lanes.reservedUntenanted > 0 && tenanted >= tenantSlots) {
      reached.set('untenanted-reserve:tenants', {
        kind: FlowLaneKind.UntenantedReserve,
        key: 'tenants',
        running: tenanted,
        max: tenantSlots,
      });
    }
    if (lanes.maxPerTenant !== undefined) {
      for (const [tenant, running] of byTenant) {
        if (running >= lanes.maxPerTenant) {
          reached.set(`tenant:${tenant}`, {
            kind: FlowLaneKind.Tenant,
            key: tenant,
            running,
            max: lanes.maxPerTenant,
          });
        }
      }
    }
    if (lanes.maxPerFlow !== undefined) {
      for (const [flow, running] of byFlow) {
        if (running >= lanes.maxPerFlow) {
          reached.set(`flow:${flow}`, {
            kind: FlowLaneKind.Flow,
            key: flow,
            running,
            max: lanes.maxPerFlow,
          });
        }
      }
    }
    for (const lane of lanes.lanes) {
      const running = byLane.get(lane.name) ?? 0;
      if (running >= lane.max) {
        reached.set(`lane:${lane.name}`, {
          kind: FlowLaneKind.Lane,
          key: lane.name,
          running,
          max: lane.max,
        });
      }
    }
    for (const id of fullSince.keys()) if (!reached.has(id)) fullSince.delete(id);
    for (const [id, full] of reached) {
      const known = fullSince.get(id);
      if (known) {
        known.running = full.running;
        continue;
      }
      const entry = { ...full, since: now };
      fullSince.set(id, entry);
      onFull({ ...entry });
    }
  }

  function apply(entry: FlowLaneEntry, by: 1 | -1): void {
    if (entry.tenant === undefined) untenanted += by;
    else {
      tenanted += by;
      increment(byTenant, entry.tenant, by);
    }
    increment(byFlow, entry.flow, by);
    for (const lane of lanesOf.get(entry.flow) ?? []) increment(byLane, lane.name, by);
  }

  return {
    claimPlan,
    admit(execution) {
      const broken = limitsOf(execution).find((limit) => limit.running >= limit.max);
      const entry: FlowLaneEntry = Object.freeze({
        executionId: execution.executionId,
        ...(execution.tenant !== undefined ? { tenant: execution.tenant } : {}),
        flow: execution.flow,
        ...(broken ? { exceeded: { kind: broken.kind, key: broken.key } } : {}),
      });
      entries.add(entry);
      apply(entry, 1);
      noteFull();
      return entry;
    },
    release(entry) {
      if (!entries.delete(entry)) return;
      apply(entry, -1);
      noteFull();
    },
    snapshot() {
      return {
        slots: lanes.slots,
        reservedUntenanted: lanes.reservedUntenanted,
        ...(lanes.maxPerTenant !== undefined ? { maxPerTenant: lanes.maxPerTenant } : {}),
        ...(lanes.maxPerFlow !== undefined ? { maxPerFlow: lanes.maxPerFlow } : {}),
        tenantOrder: lanes.tenantOrder,
        running: {
          total: tenanted + untenanted,
          untenanted,
          tenanted,
          byTenant: Object.fromEntries(byTenant),
          byFlow: Object.fromEntries(byFlow),
          byLane: Object.fromEntries(byLane),
        },
        full: [...fullSince.values()].map((full) => ({ ...full })),
      };
    },
  };
}
