import type { CapabilityContract } from '../types/capability.js';
import { buildMcpToolDefinition } from './manifest-generator.js';

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Render a markdown skill file for one MCP-exposed capability. */
export function renderSkillFile(cap: CapabilityContract): string {
  const tool = buildMcpToolDefinition(cap);
  const scopes = cap.access?.scopes ?? [];
  const roles = cap.access?.roles ?? [];
  const tenantScoped = cap.access?.tenantScoped === true;
  const dangerous = cap.mcp?.dangerous === true;
  const agentTags = tool.agentTags ?? [];

  const lines = [
    `# ${tool.name}`,
    '',
    '## Name',
    '',
    tool.name,
    '',
    '## Description',
    '',
    tool.description,
    '',
    '## Input Schema',
    '',
    '```json',
    formatJson(tool.inputSchema),
    '```',
    '',
    '## Agent Tags',
    '',
    agentTags.length > 0 ? agentTags.join(', ') : '(none)',
    '',
    '## Required Scopes',
    '',
    scopes.length > 0 ? scopes.map((s) => `- \`${s}\``).join('\n') : '(none)',
    '',
    '## Required Roles',
    '',
    roles.length > 0 ? roles.map((r) => `- \`${r}\``).join('\n') : '(none)',
    '',
    '## Tenant Scoped',
    '',
    tenantScoped ? 'yes' : 'no',
    '',
    '## Dangerous',
    '',
    dangerous ? 'yes' : 'no',
    '',
    '## Effects',
    '',
    `- Data: ${cap.effects.data.join(', ') || '(none)'}`,
    `- Events: ${cap.effects.events.join(', ') || '(none)'}`,
    `- External: ${cap.effects.external.join(', ') || '(none)'}`,
    '',
  ];

  return lines.join('\n');
}
