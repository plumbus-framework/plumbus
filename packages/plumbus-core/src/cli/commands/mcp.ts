// ── plumbus mcp ──
// Expose MCP-exposed capabilities over stdio or HTTP.

import type { Command } from 'commander';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { buildMcpManifest, isMcpExposed, renderSkillFile } from '../../mcp/index.js';
import { buildMcpServeContext } from '../mcp-serve-context.js';
import { discoverResources } from '../discover.js';
import * as path from 'node:path';
import { info, resolvePath, success, toKebabCase, warn, writeFile } from '../utils.js';

export interface McpServeOptions {
  stdio?: boolean;
  http?: boolean;
  port?: string;
  host?: string;
}

async function loadMcpRuntime(): Promise<typeof import('@plumbus/mcp')> {
  try {
    return await import('@plumbus/mcp');
  } catch {
    console.error('');
    console.error('MCP runtime not installed.');
    console.error('Run: pnpm add @plumbus/mcp');
    console.error('');
    process.exit(1);
  }
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('Model Context Protocol — expose capabilities to AI agents');

  mcp
    .command('serve')
    .description('Start an MCP server for capabilities with exposeAs: ["mcp"]')
    .option('--stdio', 'Use stdio transport (default when neither --stdio nor --http is set)')
    .option('--http', 'Use Streamable HTTP transport')
    .option('--port <port>', 'HTTP listen port', '3001')
    .option('--host <host>', 'HTTP listen host', '0.0.0.0')
    .action(async (opts: McpServeOptions) => {
      const useHttp = opts.http === true;
      const useStdio = opts.stdio === true || !useHttp;

      const ctx = await buildMcpServeContext();
      const exposed = ctx.capabilities.getAll().filter(isMcpExposed);
      if (exposed.length === 0) {
        warn('No capabilities with exposeAs: ["mcp"] — MCP server will expose zero tools');
      } else {
        info(`Exposing ${exposed.length} MCP tool(s)`);
      }

      const { createMcpServer, startStdioServer, startHttpServer } = await loadMcpRuntime();

      const mcpConfig = {
        registry: ctx.capabilities,
        db: ctx.db,
        authAdapter: ctx.routeConfig.authAdapter,
        createDependencies: ctx.routeConfig.createDependencies,
      };

      const shutdown = async (): Promise<void> => {
        await ctx.closeDb();
      };

      if (useStdio) {
        const server = createMcpServer(mcpConfig);
        info('MCP stdio server running (PLUMBUS_MCP_TOKEN / Bearer for auth)');
        await startStdioServer({ server });
        process.on('SIGINT', () => {
          void shutdown().then(() => process.exit(0));
        });
        return;
      }

      if (useHttp) {
        const port = parseInt(opts.port ?? '3001', 10);
        const host = opts.host ?? '0.0.0.0';
        const { close } = await startHttpServer({
          config: mcpConfig,
          port,
          host,
        });
        success(`MCP HTTP server listening on http://${host}:${port}/mcp`);
        info(`Discovery: http://${host}:${port}/mcp/discovery`);
        const stop = async (): Promise<void> => {
          await close();
          await shutdown();
        };
        process.on('SIGINT', () => {
          void stop().then(() => process.exit(0));
        });
      }
    });

  mcp
    .command('generate')
    .description('Generate MCP manifest and skill files (alias for plumbus generate MCP outputs)')
    .action(async () => {
      const outputDir = resolvePath('.plumbus', 'generated');
      const resources = await discoverResources();
      const registry = new CapabilityRegistry();
      for (const cap of resources.capabilities) {
        if (isMcpExposed(cap)) {
          registry.register(cap);
        }
      }
      const manifest = buildMcpManifest(registry);
      writeFile(path.join(outputDir, 'mcp-manifest.json'), JSON.stringify(manifest, null, 2));
      const generated: string[] = ['mcp-manifest.json'];
      for (const cap of resources.capabilities.filter(isMcpExposed)) {
        const skillDir = path.join(outputDir, 'skills', cap.domain);
        const skillPath = path.join(skillDir, `${toKebabCase(cap.name)}.md`);
        writeFile(skillPath, renderSkillFile(cap));
        generated.push(path.join('skills', cap.domain, `${toKebabCase(cap.name)}.md`));
      }
      success(`Generated ${generated.length} MCP artifact(s) under .plumbus/generated/`);
    });

  mcp
    .command('list-tools')
    .description('List MCP-exposed tools from the current app contracts')
    .action(async () => {
      const resources = await discoverResources();
      const registry = new CapabilityRegistry();
      for (const cap of resources.capabilities) {
        if (isMcpExposed(cap)) {
          registry.register(cap);
        }
      }
      const manifest = buildMcpManifest(registry);
      if (manifest.tools.length === 0) {
        warn('No MCP-exposed capabilities found');
        return;
      }
      for (const tool of manifest.tools) {
        console.log(`${tool.name}\t${tool.description}`);
      }
    });
}
