import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../../../define/defineFlow.js';
import { formatFlowScheduleLine, mergeFlowScheduleList } from '../flow-schedule-list.js';

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
