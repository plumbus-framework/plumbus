import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../../define/defineFlow.js';
import { formatFlowScheduleLine, mergeFlowScheduleList } from '../flow-schedule-list.js';
import { parseAllowRemove, runScheduleSync } from '../flow.js';

function scheduledFlow(name: string, domain: string, cron: string) {
  return defineFlow({
    name,
    domain,
    input: z.object({}),
    schedule: { cron },
    steps: [{ name: 'step', type: 'capability', capability: 'test.step' }],
  });
}

describe('mergeFlowScheduleList', () => {
  it('returns registry-only flows when DB is empty', () => {
    const flows = [scheduledFlow('nightlyCleanup', 'maintenance', '0 0 * * *')];
    const result = mergeFlowScheduleList([], flows);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      flowName: 'nightlyCleanup',
      domain: 'maintenance',
      cron: '0 0 * * *',
      lastRunAt: null,
      nextRunAt: null,
      enabled: true,
      synced: false,
    });
  });

  it('merges DB rows with registry domain and DB timings', () => {
    const flows = [scheduledFlow('nightlyCleanup', 'maintenance', '0 0 * * *')];
    const result = mergeFlowScheduleList(
      [
        {
          flowName: 'nightlyCleanup',
          cron: '0 0 * * *',
          lastRunAt: new Date('2026-06-19T00:00:00.000Z'),
          nextRunAt: new Date('2026-06-20T00:00:00.000Z'),
          enabled: true,
        },
      ],
      flows,
    );

    expect(result[0]).toEqual({
      flowName: 'nightlyCleanup',
      domain: 'maintenance',
      cron: '0 0 * * *',
      lastRunAt: '2026-06-19T00:00:00.000Z',
      nextRunAt: '2026-06-20T00:00:00.000Z',
      enabled: true,
      synced: true,
    });
  });

  it('uses DB cron and timings when both registry and DB exist', () => {
    const flows = [scheduledFlow('hourlySync', 'ops', '0 * * * *')];
    const result = mergeFlowScheduleList(
      [
        {
          flowName: 'hourlySync',
          cron: '*/15 * * * *',
          lastRunAt: new Date('2026-06-19T12:00:00.000Z'),
          nextRunAt: new Date('2026-06-19T12:15:00.000Z'),
          enabled: false,
        },
      ],
      flows,
    );

    expect(result[0]?.cron).toBe('*/15 * * * *');
    expect(result[0]?.enabled).toBe(false);
    expect(result[0]?.synced).toBe(true);
  });

  it('includes DB-only rows without registry domain', () => {
    const result = mergeFlowScheduleList(
      [
        {
          flowName: 'legacyJob',
          cron: 'every:24h',
          lastRunAt: null,
          nextRunAt: new Date('2026-06-20T08:00:00.000Z'),
          enabled: true,
        },
      ],
      [],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe('');
    expect(result[0]?.synced).toBe(true);
  });

  it('sorts by nextRunAt ascending with nulls last', () => {
    const flows = [
      scheduledFlow('unsynced', 'ops', '0 * * * *'),
      scheduledFlow('later', 'ops', '0 2 * * *'),
      scheduledFlow('sooner', 'ops', '0 1 * * *'),
    ];
    const result = mergeFlowScheduleList(
      [
        {
          flowName: 'later',
          cron: '0 2 * * *',
          lastRunAt: null,
          nextRunAt: new Date('2026-06-20T02:00:00.000Z'),
          enabled: true,
        },
        {
          flowName: 'sooner',
          cron: '0 1 * * *',
          lastRunAt: null,
          nextRunAt: new Date('2026-06-20T01:00:00.000Z'),
          enabled: true,
        },
      ],
      flows,
    );

    expect(result.map((entry) => entry.flowName)).toEqual(['sooner', 'later', 'unsynced']);
  });
});

describe('formatFlowScheduleLine', () => {
  it('omits next and last when not synced', () => {
    const line = formatFlowScheduleLine({
      flowName: 'nightlyCleanup',
      domain: 'maintenance',
      cron: '0 0 * * *',
      lastRunAt: null,
      nextRunAt: null,
      enabled: true,
      synced: false,
    });

    expect(line).toBe(
      'nightlyCleanup domain=maintenance cron="0 0 * * *" enabled=true synced=false',
    );
  });

  it('includes next and last when synced', () => {
    const line = formatFlowScheduleLine({
      flowName: 'nightlyCleanup',
      domain: 'maintenance',
      cron: '0 0 * * *',
      lastRunAt: '2026-06-19T00:00:00.000Z',
      nextRunAt: '2026-06-20T00:00:00.000Z',
      enabled: true,
      synced: true,
    });

    expect(line).toContain('next=2026-06-20T00:00:00.000Z');
    expect(line).toContain('last=2026-06-19T00:00:00.000Z');
    expect(line).toContain('synced=true');
  });
});

describe('parseAllowRemove', () => {
  it('returns undefined when the option is absent', () => {
    expect(parseAllowRemove(undefined)).toBeUndefined();
  });
  it('treats * as allowing any removal', () => {
    expect(parseAllowRemove(' * ')).toBe(true);
  });
  it('splits and trims comma-separated flow names, dropping empty entries', () => {
    expect(parseAllowRemove('nightlyCleanup, weeklyReport,,')).toEqual([
      'nightlyCleanup',
      'weeklyReport',
    ]);
  });
});

describe('runScheduleSync', () => {
  const resources = { flows: [], capabilities: [] } as any;
  function deps(result: any) {
    const out: string[] = [];
    const err: string[] = [];
    const reconcile = vi.fn(async () => result);
    const discover = vi.fn(async () => resources);
    return {
      out,
      err,
      reconcile,
      discover,
      deps: {
        discover,
        reconcile,
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
      },
    };
  }

  it('discovers flows strictly and forwards the approval options', async () => {
    const t = deps({ revision: 'r1', changes: [], applied: true });
    const options = { apply: true, expectedRevision: 'r1', allowRemove: ['old'] };
    await runScheduleSync(options, t.deps);
    expect(t.discover).toHaveBeenCalledWith({ strict: ['flows'] });
    expect(t.reconcile).toHaveBeenCalledWith(resources, options);
  });

  it('does not reconcile when a flow module fails to load', async () => {
    const t = deps({ revision: 'r1', changes: [], applied: false });
    t.discover.mockRejectedValueOnce(new Error('Unable to load flow module: broken.ts'));
    await expect(runScheduleSync({ apply: true }, t.deps)).rejects.toThrow('broken.ts');
    expect(t.reconcile).not.toHaveBeenCalled();
    expect(t.out).toEqual([]);
  });

  it('keeps stdout JSON-only and reports removals on stderr', async () => {
    const preview = {
      revision: 'r1',
      changes: [
        { flowName: 'kept', action: 'update' },
        { flowName: 'old', action: 'remove' },
      ],
      applied: false,
    };
    const t = deps(preview);
    await runScheduleSync({}, t.deps);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0] ?? '')).toEqual(preview);
    expect(t.err).toEqual([
      '⚠ Would remove schedule: old (if the flow was deleted on purpose, approve with --allow-remove old; otherwise fix the flow registry)',
    ]);
  });

  it('marks removals already approved in a preview', async () => {
    const t = deps({
      revision: 'r1',
      changes: [
        { flowName: 'old', action: 'remove' },
        { flowName: 'other', action: 'remove' },
      ],
      applied: false,
    });
    await runScheduleSync({ allowRemove: ['old'] }, t.deps);
    expect(t.err[0]).toBe('⚠ Would remove schedule: old (approved)');
    expect(t.err[1]).toContain('approve with --allow-remove other');
  });

  it('reports applied removals on stderr', async () => {
    const t = deps({
      revision: 'r1',
      changes: [{ flowName: 'old', action: 'remove' }],
      applied: true,
    });
    await runScheduleSync({ apply: true, expectedRevision: 'r1', allowRemove: true }, t.deps);
    expect(t.err).toEqual(['⚠ Removed schedule: old']);
  });
});
