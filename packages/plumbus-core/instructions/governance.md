# Governance

Plumbus governance is **advisory, not blocking** — "guardrails, not gates." Rules produce warnings that inform developers; they don't prevent deployment.

## Governance Signals

```ts
{
  severity: "warning",                    // "info" | "warning" | "high"
  rule: "security.missing-access-policy",
  description: "Capability 'deleteUser' has no access policy",
  affectedComponent: "capabilities/users/deleteUser",
  remediation: "Add an access policy to restrict who can delete users"
}
```

## Built-in Rules

### Security
- Capabilities without access policies
- Overly permissive roles (e.g., `public: true` on mutations)
- Missing tenant isolation on multi-tenant entities
- Cross-tenant data access patterns

### Privacy
- `highly_sensitive` fields stored without `encrypted: true`
- Personal data fields without `maskedInLogs: true`
- Missing `classification` on entity fields
- Excessive data retention durations

### Architecture
- Capabilities with too many side effects
- Flows with excessive branching depth
- Large handler implementations (complexity warning)

### AI
- Prompts receiving sensitive classified data
- Missing output validation schemas
- Prompts without model configuration

## Running Governance Checks

```bash
plumbus verify              # Run all rules, human-readable output
plumbus verify --json       # Machine-readable output
```

Exit code is non-zero if any `high` severity signals are found.

## Overrides

When a governance warning is acknowledged and accepted:

```yaml
# app/compliance/overrides/delete-user-public.yaml
rule: security.missing-access-policy
justification: "This is an internal admin tool with network-level access control"
author: "jane@company.com"
timestamp: "2026-01-15T10:30:00Z"
```

Overrides appear in governance reports as acknowledged deviations.

## Policy Profiles

Assess compatibility with compliance frameworks:

```bash
plumbus certify policy gdpr
plumbus certify policy pci_dss
plumbus certify policy soc2
plumbus certify policy hipaa
```

Each profile defines rules specific to that standard. Reports include:
- Compatibility score (0-100%)
- Per-rule pass/partial/fail/override results
- Remediation recommendations
