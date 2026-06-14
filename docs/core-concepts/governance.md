# Governance

Plumbus uses an **Advisory-First Governance** model — the framework detects risky patterns, warns developers, and records decisions, but never hard-blocks.

## Philosophy

- **Guardrails, not gates** — risks are surfaced, not enforced
- **Transparency over restriction** — risky decisions are acceptable if intentional and documented
- **Advisory only** — governance warnings never prevent deployment

## What Gets Checked

### Security
- Capabilities without access policies
- Overly permissive roles
- Cross-tenant data access

### Privacy
- Missing data classification on entity fields
- Logging of personal data
- Excessive data retention

### Architecture
- Capabilities with excessive side effects
- Flows with too many steps or excessive branching
- Missing audit configuration
- `eventHandler` capabilities without `trigger.event` (`worker.event-handler-missing-trigger`)

### AI
- Prompts without explainability tracking
- Excessive AI usage patterns
- Missing output validation

## CLI Commands

### `plumbus verify`

Run all governance rules against the application:

```bash
plumbus verify
plumbus verify --json
```

Reports warnings with severity levels:

| Level | Meaning |
|-------|---------|
| `info` | Informational guidance |
| `warning` | Risky but acceptable |
| `high` | Significant security or compliance risk |

### `plumbus certify`

Run compliance profile assessment against built-in profiles:

```bash
plumbus certify
plumbus certify --json
```

Built-in profiles (`PolicyProfile` enum values): `soc2`, `gdpr`, `hipaa`, `pci_dss`, `internal_security_baseline`.

## Overrides

Developers may acknowledge governance warnings with explicit overrides:

```typescript
import { createOverrideStore } from '@plumbus/core';

const overrides = createOverrideStore();
overrides.add({
  rule: 'security.capability-access-policy',
  justification: 'Public health-check endpoint — no auth required',
  author: 'team-lead',
  timestamp: new Date(),
});
```

Overrides are recorded and appear in policy reports, ensuring deviations remain visible and auditable.

## Governance Engine

The rule engine evaluates registered rules against the full system inventory (capabilities, entities, events, flows, prompts):

```typescript
import {
  createGovernanceRuleEngine,
  securityRules,
  privacyRules,
  architectureRules,
  aiRules,
  mcpRules,
  apiRules,
} from '@plumbus/core';

const engine = createGovernanceRuleEngine();
engine.registerRules([
  ...securityRules,
  ...privacyRules,
  ...architectureRules,
  ...aiRules,
  ...mcpRules,
  ...apiRules,
]);

const result = engine.evaluate(inventory);
// result.signals — array of GovernanceSignal
```

### Built-in Rule Categories

| Category | Rules |
|----------|-----------|
| **Security** | `ruleCapabilityMissingAccessPolicy`, `ruleOverlyPermissiveRoles`, `ruleCrossTenantDataAccess`, `ruleEntityTenantIsolation` |
| **Privacy** | `ruleMissingFieldClassification`, `rulePersonalDataInLogs`, `ruleExcessiveDataRetention`, `ruleSensitiveFieldUnencrypted` |
| **Architecture** | `ruleExcessiveEffects`, `ruleExcessiveFlowSteps`, `ruleExcessiveFlowBranching`, `ruleEntityMissingDescription`, `ruleMissingAuditConfig` |
| **AI** | `ruleAIWithoutExplanation`, `ruleExcessiveAIUsage`, `rulePromptMissingModelConfig`, `rulePromptMissingOutputSchema` |
| **MCP** | `ruleMcpMissingDescription` |

## Policy Reports

Generate compliance reports showing pass/fail/override status:

```typescript
import { generatePolicyReport, formatPolicyReport } from '@plumbus/core';

const report = generatePolicyReport('SOC2', inventory, overrides);
console.log(formatPolicyReport(report));
```

## CI/CD Integration

Add governance checks to CI pipelines:

```yaml
- name: Governance check
  run: npx plumbus verify --json
```

Teams may configure failure thresholds (e.g., fail on `high` severity warnings only).

## Related

- [Security Model](../security/security-model.md) — access policies, auth, tenant isolation
- [Capabilities](capabilities.md) — access policy declaration
- [CLI Reference](../cli/commands.md) — `verify` and `certify` commands

---

## SDK reference

For the full rule list, the `PolicyProfile` enum values, and the `OverrideStore` API, see [SDK Reference → defineCapability (governance fields)](../sdk-reference/define-functions.md) and the governance source under `packages/plumbus-core/src/governance/rules/`. This page covers the common case; the reference is exhaustive.
