import { describe, expect, it } from 'vitest';
import {
  assertProtocolProperties,
  CrashSignal,
  CRASH_POINTS,
  createProtocolAWorld,
  driveToIdle,
  type CrashPoint,
} from '../crash-matrix-simulation.js';
import { DurableExecutionStatus, SpineDeliveryState } from '../../durable/types.js';

const acceptArgs = {
  executionId: 'exec-1',
  tenantRef: 'tenant-a',
  correlationId: 'corr-1',
  idempotencyKey: 'accept:exec-1',
};

function runAccept(crashAt?: CrashPoint) {
  const world = createProtocolAWorld({ crashAt });
  try {
    world.accept(acceptArgs);
  } catch (error) {
    if (!(error instanceof CrashSignal)) throw error;
  }
  return world;
}

function completeHappyPath() {
  const world = createProtocolAWorld();
  world.accept(acceptArgs);
  driveToIdle(world);
  return world;
}

describe('Protocol A crash-matrix simulation', () => {
  it('completes two steps with persist-before-ack and one side effect per step', () => {
    const world = completeHappyPath();
    const snap = world.inspect();
    assertProtocolProperties(snap);
    expect(snap.executions[0]?.status).toBe(DurableExecutionStatus.Succeeded);
    expect(snap.executions[0]?.terminal).toBe(true);
    expect(snap.sideEffects).toEqual(['exec-1:step-a', 'exec-1:step-b']);
    expect(snap.spine.every((row) => row.deliveryState === SpineDeliveryState.Acknowledged)).toBe(
      true,
    );
  });

  it('does not persist acceptance when the tenant transaction crashes before commit', () => {
    const world = runAccept('before-tenant-commit');
    const snap = world.inspect();
    expect(snap.lastCrash).toBe('before-tenant-commit');
    expect(snap.executions).toEqual([]);
    expect(snap.outbox).toEqual([]);
    driveToIdle(world);
    expect(world.inspect().executions).toEqual([]);
    expect(world.inspect().sideEffects).toEqual([]);
  });

  it.each(
    CRASH_POINTS.filter(
      (point) => point !== 'before-tenant-commit' && point !== 'during-spine-sweep-after-ack',
    ),
  )(
    'loses no accepted work and duplicates no side effect when crashing at %s',
    (point) => {
      const world = createProtocolAWorld({ crashAt: point });
      try {
        world.accept(acceptArgs);
      } catch (error) {
        if (!(error instanceof CrashSignal)) throw error;
      }
      driveToIdle(world);
      const snap = world.inspect();
      assertProtocolProperties(snap);
      expect(snap.lastCrash).toBe(point);
      expect(snap.executions).toHaveLength(1);
      expect(snap.executions[0]?.status).toBe(DurableExecutionStatus.Succeeded);
      expect(snap.sideEffects).toEqual(['exec-1:step-a', 'exec-1:step-b']);
    },
  );

  it('acks dangling spine rows when tenant state is gone, including crash during sweep', () => {
    const world = createProtocolAWorld({ crashAt: 'during-spine-sweep-after-ack' });
    world.accept(acceptArgs);
    world.loseTenantExecution('exec-1');
    driveToIdle(world);
    const snap = world.inspect();
    assertProtocolProperties(snap);
    expect(snap.lastCrash).toBe('during-spine-sweep-after-ack');
    expect(snap.executions).toEqual([]);
    expect(snap.sideEffects).toEqual([]);
    expect(snap.spine.every((row) => row.deliveryState === SpineDeliveryState.Acknowledged)).toBe(
      true,
    );
  });

  it('no-ops a duplicate spine delivery after the revision has advanced', () => {
    const world = completeHappyPath();
    world.injectDuplicateDispatch('exec-1', 1);
    world.workerTick('dup-worker');
    const snap = world.inspect();
    assertProtocolProperties(snap);
    expect(snap.sideEffects).toEqual(['exec-1:step-a', 'exec-1:step-b']);
    expect(snap.executions[0]?.revision).toBeGreaterThan(1);
  });

  it('no-ops a delayed dispatch after the execution is terminal', () => {
    const world = completeHappyPath();
    world.advanceTime(60_000);
    world.injectDuplicateDispatch('exec-1', 1);
    world.workerTick('delayed');
    expect(world.inspect().sideEffects).toEqual(['exec-1:step-a', 'exec-1:step-b']);
    expect(world.inspect().executions[0]?.terminal).toBe(true);
  });

  it('schedules a retry then completes without duplicating the protected side effect', () => {
    const world = createProtocolAWorld();
    world.accept(acceptArgs);
    world.failNextExecute();
    driveToIdle(world);
    const snap = world.inspect();
    assertProtocolProperties(snap);
    expect(snap.executions[0]?.status).toBe(DurableExecutionStatus.Succeeded);
    expect(snap.sideEffects).toEqual(['exec-1:step-a', 'exec-1:step-b']);
  });

  it('sweeps dangling spine rows after a tenant-epoch restore', () => {
    const world = createProtocolAWorld();
    world.accept(acceptArgs);
    const before = world.inspect();
    expect(before.spine.length).toBeGreaterThan(0);
    const newEpoch = world.restore();
    expect(newEpoch).toBe(2);
    driveToIdle(world);
    const snap = world.inspect();
    assertProtocolProperties(snap);
    expect(snap.epoch).toBe(2);
    expect(snap.executions[0]?.tenantEpoch).toBe(2);
    expect(snap.executions[0]?.status).toBe(DurableExecutionStatus.Succeeded);
    expect(snap.sideEffects).toEqual(['exec-1:step-a', 'exec-1:step-b']);
    const stale = snap.spine.filter((row) => row.tenantEpoch === 1);
    expect(stale.every((row) => row.deliveryState === SpineDeliveryState.Acknowledged)).toBe(true);
  });

  it('two workers cannot claim the same unexpired lease', () => {
    const world = createProtocolAWorld({ crashAt: 'after-claim-before-tenant-reread' });
    world.accept(acceptArgs);
    try {
      world.workerTick('worker-a');
    } catch (error) {
      if (!(error instanceof CrashSignal)) throw error;
    }
    const afterCrash = world.inspect();
    const leased = afterCrash.spine.filter((row) => row.deliveryState === SpineDeliveryState.Leased);
    expect(leased).toHaveLength(1);
    expect(world.workerTick('worker-b')).toBe(false);
    driveToIdle(world);
    expect(world.inspect().sideEffects).toEqual(['exec-1:step-a', 'exec-1:step-b']);
  });
});
