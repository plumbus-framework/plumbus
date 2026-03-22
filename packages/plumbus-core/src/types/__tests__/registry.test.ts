import { describe, expectTypeOf, it } from 'vitest';
import type { DataService, EventService, FlowService, Repository } from '../../types/context.js';
import type { CapabilityStep, FlowTrigger, WaitStep } from '../../types/flow.js';
import type {
  RegisteredCapabilityName,
  RegisteredEntities,
  RegisteredEventName,
  RegisteredFlowName,
} from '../../types/registry.js';

describe('PlumbusRegistry — default (no augmentation)', () => {
  it('RegisteredCapabilityName defaults to string', () => {
    expectTypeOf<RegisteredCapabilityName>().toEqualTypeOf<string>();
  });

  it('RegisteredEventName defaults to string', () => {
    expectTypeOf<RegisteredEventName>().toEqualTypeOf<string>();
  });

  it('RegisteredFlowName defaults to string', () => {
    expectTypeOf<RegisteredFlowName>().toEqualTypeOf<string>();
  });

  it('RegisteredEntities defaults to Record<string, Repository>', () => {
    expectTypeOf<RegisteredEntities>().toEqualTypeOf<Record<string, Repository>>();
  });

  it('DataService is assignable from Record<string, Repository>', () => {
    expectTypeOf<Record<string, Repository>>().toMatchTypeOf<DataService>();
  });

  it('CapabilityStep.capability accepts string without augmentation', () => {
    expectTypeOf<CapabilityStep['capability']>().toEqualTypeOf<string | undefined>();
  });

  it('FlowTrigger.event accepts string without augmentation', () => {
    expectTypeOf<FlowTrigger['event']>().toEqualTypeOf<string>();
  });

  it('WaitStep.event accepts string without augmentation', () => {
    expectTypeOf<WaitStep['event']>().toEqualTypeOf<string>();
  });

  it('EventService.emit eventName parameter accepts string', () => {
    expectTypeOf<EventService['emit']>().parameter(0).toEqualTypeOf<string>();
  });

  it('FlowService.start flowName parameter accepts string', () => {
    expectTypeOf<FlowService['start']>().parameter(0).toEqualTypeOf<string>();
  });
});
