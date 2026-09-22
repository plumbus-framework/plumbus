# Agent Guardrails

These rules are mandatory when an AI agent works on a Plumbus application.

## Framework-First Architecture

- Plumbus is the application architecture, not a helper library.
- All business logic must be implemented through Plumbus primitives: `defineCapability()`, `defineFlow()`, `defineEntity()`, `defineEvent()`, `definePrompt()`, and translations where relevant.
- If a task seems to require code outside those primitives, stop and ask which Plumbus extension point should be used.

## Non-Negotiable Boundaries

- **Do not** implement business logic in ad hoc API routes, controllers, services, cron files, queues, or background workers when the behavior belongs in a capability, flow, event handler, or prompt.
- **Do not** bypass `ctx.*` subsystems with direct database clients, custom event buses, raw auth checks, or bespoke AI integration layers unless the framework explicitly documents that extension point.
- **Do not** import framework internals. Use the public SDK surface only.
- **Do not** edit generated files in `.plumbus/generated/`.
- **Do not** install framework-provided dependencies directly in the consumer app.

## Escalation Rule

- When the requirements are unclear, ask which primitive should own the behavior instead of inventing a clean-room architecture.
- Prefer asking for clarification over adding code that works technically but does not follow the framework contract.

## Git Safety

Read-only git inspection is allowed: `git status`, `git diff`, `git log`, `git show`.

The following actions require explicit user approval because they can discard work or rewrite history:

- `git checkout` when used to restore or overwrite files
- `git restore`
- `git reset` of any kind
- `git clean`
- `git revert` across user work you did not author
- `git push --force` or `git push --force-with-lease`
- deleting branches or tags
- any command that overwrites, discards, or rewrites existing work

If there is any doubt about whether a git command is destructive, stop and ask first.