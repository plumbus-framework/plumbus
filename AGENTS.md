# Plumbus Framework — Development Instructions

> These instructions are for **developing the Plumbus framework itself**, not for building applications with Plumbus.
> For detailed architecture and SDK docs, read files under `docs/`.

## What Is Plumbus

Plumbus is an AI-native, contract-driven TypeScript application framework. Users define applications through five primitives — Capabilities, Entities, Events, Flows, and Prompts — using `define*()` functions. The framework provides an execution runtime, CLI tooling, code generation, and a full testing harness.

## Commands

All commands run from the **repo root**. Monorepo managed by pnpm 10.32.0 + Turborepo 2.4.

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Build all | `pnpm build` |
| Test all | `pnpm test` |
| Typecheck / Lint | `pnpm typecheck` (no separate linter) |
| Dev (watch) | `pnpm dev` |
| Test single file | `cd packages/plumbus-core && npx vitest run src/<module>/__tests__/<name>.test.ts` |
| Browser tests | `cd packages/plumbus-core && pnpm test:browser` |

## Coding Conventions

- **ESM only** — all imports require `.js` extensions (Node16 module resolution)
- **Strict TypeScript** — `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- **`as const` enums** — never TS `enum`; use `as const` objects + type extraction
- **Zod schemas** — all validation uses Zod, never manual type guards
- **`Object.freeze`** — all `define*()` outputs are deeply frozen
- **Structured errors** — use constructors from `src/errors/`, never raw `throw new Error`
- **Barrel imports** — import from `src/<module>/index.ts`, never from internal files
- **Context injection** — `ExecutionContext` is passed to handlers; no globals or singletons

### Naming

| Element | Pattern | Example |
|---------|---------|---------|
| Source files | kebab-case | `schema-generator.ts` |
| Types/interfaces | PascalCase | `CapabilityDefinition` |
| Functions | camelCase | `defineCapability` |
| Constants (as const) | PascalCase | `CapabilityKind` |
| Test files | `<subject>.test.ts` | `defineCapability.test.ts` |

### Module Structure

```
src/<module>/
├── index.ts              # Public barrel — only file imported by other modules
├── <implementation>.ts
└── __tests__/
    └── <name>.test.ts
```

## Testing

- **Vitest 3.2.4** — tests in `src/<module>/__tests__/*.test.ts`
- Use `createTestContext()` for a fully-mocked `ExecutionContext`
- Test through `runCapability()` / `simulateFlow()`, not internals
- Tests must be self-contained — no shared mutable state
- Always test both success and error paths
- **CRITICAL: Every code change must include corresponding test updates or new tests. No change ships without tests.**

## Adding New Features

- **New module**: create `src/<module>/index.ts` + `__tests__/` + re-export from `src/index.ts`
- **New CLI command**: `src/cli/commands/<name>.ts` with `register<Name>Command()`, register in `cli.ts`
- **New define function**: `src/define/define<Primitive>.ts` + types in `src/types/` + validate with Zod + freeze output
- **New governance rule**: add to `src/governance/rules/`, register in `rules/index.ts` — advisory only

## Key Design Decisions

- **Contract-first**: `define*()` functions are the source of truth for everything
- **Deny-by-default security**: no matching access policy = denial
- **Advisory governance**: warnings only, never hard blocks
- **Outbox pattern**: events written in same transaction, dispatched async (at-least-once)
- **No linter/formatter**: `tsc --noEmit` is the only code quality gate

## Detailed Documentation

For architecture, SDK reference, and design rationale, read files under `docs/`:

- `docs/architecture/` — system overview, execution lifecycle, diagrams
- `docs/core-concepts/` — capabilities, entities, flows, events, prompts
- `docs/sdk-reference/` — define functions, execution context, data layer, configuration
- `docs/cli/` — all CLI commands and options
- `docs/security/` — security model, auth, tenant isolation
- `docs/ai/` — prompts, RAG, cost tracking
- `docs/testing/` — test utilities, patterns, examples

## Documentation — CRITICAL

Before making changes, read the relevant docs under `docs/` to understand the current design and conventions.

After making changes, update the corresponding documentation in `docs/`. **This is mandatory — every code change must include documentation updates.** Outdated docs are worse than no docs.

## Keeping Agent Files in Sync

`AGENTS.md` and `CLAUDE.md` must stay identical. When editing one, always apply the same change to the other.

## Files You Should Not Edit

- `dist/`, `node_modules/`, `.turbo/` — generated/managed
- `packages/*/instructions/` — consumer-facing AI instructions (separate concern)
- `design/`, `general-desc/` — reference documentation (gitignored)
