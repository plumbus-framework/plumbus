import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ruleEventHandlerMissingTrigger,
  ruleEventHandlerPayloadCompatibility,
} from '../rules/worker.js';

describe('ruleEventHandlerMissingTrigger', () => {
  it('warns on eventHandler without trigger.event', () => {
    const signals = ruleEventHandlerMissingTrigger.evaluate({
      capabilities: [
        {
          kind: 'eventHandler',
          name: 'onOrderCreated',
          domain: 'orders',
        } as never,
      ],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe('worker.event-handler-missing-trigger');
  });

  it('passes when trigger.event is set', () => {
    const signals = ruleEventHandlerMissingTrigger.evaluate({
      capabilities: [
        {
          kind: 'eventHandler',
          name: 'onOrderCreated',
          domain: 'orders',
          trigger: { event: 'order.created' },
        } as never,
      ],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    });
    expect(signals).toHaveLength(0);
  });
});

describe('ruleEventHandlerPayloadCompatibility', () => {
  it('warns when handler input keys are missing on event payload', () => {
    const signals = ruleEventHandlerPayloadCompatibility.evaluate({
      capabilities: [
        {
          kind: 'eventHandler',
          name: 'onOrderPlaced',
          domain: 'orders',
          trigger: { event: 'order.placed' },
          input: z.object({ orderId: z.string(), extra: z.string() }),
        } as never,
      ],
      entities: [],
      flows: [],
      events: [
        {
          name: 'order.placed',
          payload: z.object({ orderId: z.string() }),
        } as never,
      ],
      prompts: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe('worker.event-handler-payload-compatibility');
    expect(signals[0]?.description).toContain('extra');
  });

  it('passes when handler input is subset of event payload', () => {
    const signals = ruleEventHandlerPayloadCompatibility.evaluate({
      capabilities: [
        {
          kind: 'eventHandler',
          name: 'onOrderPlaced',
          domain: 'orders',
          trigger: { event: 'order.placed' },
          input: z.object({ orderId: z.string() }),
        } as never,
      ],
      entities: [],
      flows: [],
      events: [
        {
          name: 'order.placed',
          payload: z.object({ orderId: z.string(), total: z.number() }),
        } as never,
      ],
      prompts: [],
    });
    expect(signals).toHaveLength(0);
  });
});
