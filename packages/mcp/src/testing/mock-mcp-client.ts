import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * Returns an unconnected MCP client paired with a server-side transport.
 * Pass `serverTransport` to `Server.connect(...)`, then `await client.connect(clientTransport)`.
 * Lower-level than `createTestMcpServer` — use when you need to drive the server side manually.
 */
export function mockMcpClient(): {
  client: Client;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
} {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plumbus-mcp-mock-client', version: '0.0.0' });
  return { client, clientTransport, serverTransport };
}
