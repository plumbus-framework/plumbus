// ── MCP governance rules ──

import { GovernanceSeverity } from '../../types/enums.js';
import { isMcpExposed } from '../../mcp/exposure.js';
import type { GovernanceRule } from '../rule-engine.js';

function hasAgentFacingDescription(cap: {
  description?: string;
  mcp?: { description?: string };
  explanation?: { summary?: string };
}): boolean {
  const summary = cap.explanation?.summary;
  if (typeof summary === 'string' && summary.length > 0) {
    return true;
  }
  if (typeof cap.description === 'string' && cap.description.length > 0) {
    return true;
  }
  const mcpDesc = cap.mcp?.description;
  return typeof mcpDesc === 'string' && mcpDesc.length > 0;
}

/** MCP-exposed capabilities should have an agent-facing description */
export const ruleMcpMissingDescription: GovernanceRule = {
  id: 'mcp.missing-description',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'MCP-exposed capabilities should declare an agent-facing description',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => isMcpExposed(cap) && !hasAgentFacingDescription(cap))
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'mcp.missing-description',
        description: `Capability "${cap.name}" is exposed via MCP but lacks description, mcp.description, or explanation.summary`,
        affectedComponent: `capability:${cap.name}`,
        remediation:
          'Add description, mcp.description, or explanation.summary for agent tool manifests',
      }));
  },
};

export const mcpRules = [ruleMcpMissingDescription];
