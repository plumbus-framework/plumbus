import { z } from 'zod';
import { defineCapability } from '../../define/index.js';
import { browserExtensionHttpResources } from '../commands/browser-extension.js';
import { describe, expect, it } from 'vitest';
import { createCli } from '../cli.js';

describe('plumbus browser-extension command', () => {
  it('keeps only served client exports in registry and popup inputs', () => {
    const cap = defineCapability({
      name: 'visible',
      domain: 'testing',
      kind: 'query',
      input: z.object({}),
      output: z.object({}),
      access: { roles: ['user'] },
      exposeAs: ['api'],
      api: {
        operationId: 'testingVisible',
        method: 'GET',
        path: '/testing/visible',
        stability: 'experimental',
      },
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({}),
    });
    const hidden = { ...cap, name: 'hidden', exposeAs: [] };
    const event = { ...cap, name: 'onEvent', kind: 'eventHandler' as const };
    const routed = {
      name: 'explicit',
      domain: 'testing',
      description: undefined,
      startPath: '/api/testing/start-explicit',
    };
    const resources = browserExtensionHttpResources({
      capabilities: [hidden, event, cap],
      flows: [{ name: 'internal', domain: 'testing', description: undefined }, routed],
    });
    expect(resources.capabilities).toEqual([cap]);
    expect(resources.flows).toEqual([routed]);
  });

  it('registers browser-extension subcommand with scaffold', () => {
    const program = createCli();
    const be = program.commands.find((c) => c.name() === 'browser-extension');
    expect(be).toBeDefined();
    const scaffold = be?.commands.find((c) => c.name() === 'scaffold');
    expect(scaffold).toBeDefined();
  });
});
