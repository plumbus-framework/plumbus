# Governance

Plumbus governance is **advisory, not blocking** — "guardrails, not gates." Rules produce warnings that inform developers; they don't prevent deployment.

The same model applies to `plumbus api validate`: governance signals print to stderr but do not fail the command unless you pass `--fail-on-governance`. Hard contract findings (manifest, policy, path params, fixtures) still exit `1` without that flag.

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
- **`architecture.non-canonical-capability-reference`** — flow `step.capability` or `effects.capabilities` entries missing `<domain>.<name>` prefix
- **`architecture.missing-capability-dependency`** — declared invoke target not registered
- **`architecture.circular-capability-dependency`** — cycle in `effects.capabilities` graph
- **`architecture.deep-capability-chain`** — deep nested invoke chains (info; consider a flow)
- **`architecture.job-capability-dependency`** — `kind: 'job'` declared as synchronous invoke target
- **`architecture.direct-capability-handler-import`** — capability module imports another handler (source scan under `app/capabilities/`)

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
