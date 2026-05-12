# Agent Guardrails

Plumbus ships agent guidance that treats the framework as mandatory architecture, not optional scaffolding.

## Framework-First Rule

When an AI agent works on a Plumbus app, it should treat these primitives as the only normal place for application behavior:

- capabilities for business logic
- flows for orchestration
- entities for data contracts
- events for domain facts and side effects
- prompts for structured AI interactions
- translations for localization catalogs

If a task appears to require custom routes, controllers, service layers, background workers, queues, cron jobs, or ad hoc integrations, the correct response is to stop and ask which Plumbus extension point should own the behavior.

## Forbidden Escape Hatches

Agents should not:

- implement business logic outside Plumbus primitives when a framework primitive applies
- bypass `ctx.*` subsystems with direct database access, raw event buses, bespoke auth enforcement, or custom AI plumbing unless Plumbus explicitly documents that extension point
- edit `.plumbus/generated/` files
- install framework-provided dependencies directly in the app

## Git Safety

Read-only git inspection is fine:

- `git status`
- `git diff`
- `git log`
- `git show`

The following commands or behaviors require explicit user approval because they can erase work or rewrite history:

- `git checkout` when used to overwrite files
- `git restore`
- `git reset`
- `git clean`
- `git revert` affecting user-authored work
- `git push --force` or `git push --force-with-lease`
- deleting branches or tags
- any command that discards local changes or rewrites history

## Instructions vs Enforcement

Instruction files improve agent behavior, but they are still guidance.

If you need hard prevention for destructive commands, use platform-specific enforcement such as workspace hooks, approval policies, or restricted tool permissions in addition to `plumbus init`.

## Regenerating Guardrails

When upgrading `@plumbus/core`, prefer `plumbus init --patch` so your project refreshes the Plumbus-managed wiring sections while preserving surrounding custom notes. If a generated file does not contain a patchable Plumbus-managed block, use `plumbus init --force` for that full replacement.