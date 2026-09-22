import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export async function startStdioServer(options: { server: Server }): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await options.server.connect(transport);
  return transport;
}
