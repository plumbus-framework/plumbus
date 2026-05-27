import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { describe, expect, it } from 'vitest';
import { createTestMcpServer } from '../create-test-mcp-server.js';

const echo = defineCapability({
  name: 'echo',
  kind: 'query',
  domain: 'test',
  description: 'Echo back the message field',
  input: z.object({ message: z.string() }),
  output: z.object({ echoed: z.string() }),
  access: { public: true },
  effects: { data: [], events: [], external: [], ai: false },
  exposeAs: ['mcp'],
  mcp: { description: 'Echo a message' },
  async handler(_ctx, input) {
    return { echoed: input.message };
  },
});

describe('createTestMcpServer', () => {
  it('lists and calls a registered capability over MCP', async () => {
    const { client, close } = await createTestMcpServer({ capabilities: [echo] });
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((t) => t.name === 'echo')).toBeDefined();

      const result = await client.callTool({
        name: 'echo',
        arguments: { message: 'hi' },
      });
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      expect(JSON.parse(content.text)).toEqual({ echoed: 'hi' });
    } finally {
      await close();
    }
  });
});
