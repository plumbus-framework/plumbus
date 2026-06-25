# Plumbus Framework — Development Instructions

> These instructions are for **developing the Plumbus framework itself**, not for building applications with Plumbus.
> For detailed architecture and SDK docs, read files under `docs/`.

## ⛔ CRITICAL — NO GIT, NO BRANCHES, NO COMMITS (ABSOLUTE)

**Precedence (scoped to git):** if any other instruction or default agent behavior would lead you to run a state-changing git command, *this* rule wins and you must not. This is a precedence rule for git only — it does **not** override, relax, or excuse any other instruction in this file (linting, tests, doc sync, conventions all still fully apply).

- **Read-only git inspection is allowed** without asking: `git status`, `git diff`, `git log`, `git show`, `git branch --list`, `git remote -v`, and similar commands that only read and never mutate state.
- **NEVER**, under any circumstance, create a branch, commit, push, merge, rebase, tag, reset, restore, checkout, stash, cherry-pick, or otherwise **write to or mutate** any git repository — local or remote, here or anywhere else — **without explicit, per-command approval from the user first.** Ask, wait for an explicit "yes," then run only the one command approved.
- "Explicit approval" means the user, in this conversation, tells you to run that specific write command. Prior approval, a green test run, a finished task, or an implied next step is **NOT** approval.
- This applies to every tool and channel: the Bash tool, scripts, `gh`, hooks, aliases, or any wrapper that would invoke a state-changing git operation underneath.
- If a task seems to require a git write (committing a fix, opening a PR, branching for safety), **STOP and ask.** Do the non-git work, then report what git step you would take and wait for the user to either run it themselves or explicitly approve it.

## What Is Plumbus

Plumbus is an AI-native, contract-driven TypeScript application framework. Users define applications through six primitives — Capabilities, Entities, Events, Flows, Prompts, and Translations — using `define*()` functions. The framework provides an execution runtime, CLI tooling, code generation, and a full testing harness.

## Commands

All commands run from the **repo root**. Monorepo managed by pnpm 10.32.0 + Turborepo 2.4.

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Build all | `pnpm build` |
| Test all | `pnpm test` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Format | `pnpm format` |
| Format (check) | `pnpm format:check` |
| Dev (watch) | `pnpm dev` |
| Test single file | `cd packages/plumbus-core && npx vitest run src/<module>/__tests__/<name>.test.ts` |
| Browser tests | `cd packages/plumbus-core && pnpm test:browser` |
| Translation status | `plumbus translation status` |

## Consumer App Dependency Policy

The framework provides these packages to consumer apps. Consumers must **never** add them to their own `package.json`:

### From `@plumbus/core`

| Package | Consumer imports from | Provided by |
|---------|----------------------|-------------|
| zod | `@plumbus/core/zod` | `dependencies` |
| vitest | `vitest` (at runtime) | `dependencies` |
| vitest config | `@plumbus/core/vitest` | `dependencies` |
| playwright | `@plumbus/core/testing` | `dependencies` |
| drizzle-kit | used by `plumbus migrate` | `dependencies` |

### Optional add-on: `@plumbus/mcp`

`@plumbus/mcp` is an **optional peer dependency** of `@plumbus/core` (version-locked `0.5.x || 0.6.x`). Apps that want to serve capabilities to AI agents install it explicitly:

```
pnpm add @plumbus/mcp
```

Apps that don't use MCP never install it. `plumbus mcp serve` prints an install hint when the package is missing. `plumbus generate` (which emits the MCP manifest + skill files) does **not** require `@plumbus/mcp`.

### Optional add-on: `@plumbus/api`

`@plumbus/api` is the partner-grade external API contract layer (manifest validation, OpenAPI export, docs generation, test intent, compatibility diff). It is an optional peer dependency of `@plumbus/core` (version-locked `0.1.x`). Apps that want a documented partner-facing API install it explicitly:

```
pnpm add @plumbus/api
```

Then expose capabilities with `exposeAs: ['api']`, optionally maintain an `api.yaml` manifest, and call `registerApiRoutes()` from app bootstrap. `plumbus api validate` prints an install hint when the package is missing.

### Optional add-on: `@plumbus/browser-extension`

`@plumbus/browser-extension` is an optional dev-time scaffolder (version-lock **`0.1.x`**; peer `@plumbus/core` at **`0.5.x || 0.6.x`**). Apps that want a browser extension UI install it with `@plumbus/ui`:

```
pnpm add @plumbus/ui @plumbus/browser-extension
```

Then run `plumbus browser-extension scaffold`. The generated extension does not depend on `@plumbus/browser-extension` at runtime.

### Optional add-on: `@plumbus/chat` (+ `@plumbus/chat-ui`)

`@plumbus/chat` provides the conversational runtime (`defineChat`, `runChatTurn`, `registerChatRoutes`, policy guards, context sources). It is a peer dependency of `@plumbus/core` (version-locked `0.1.x`). Apps that want a chat surface install it explicitly:

```
pnpm add @plumbus/chat
pnpm add @plumbus/chat-ui   # React hooks + <ChatPanel /> for browser clients
```

`@plumbus/chat-ui` peer-depends on `@plumbus/chat` and reuses React from `@plumbus/ui` in Plumbus apps. Apps without a chat surface install neither.

### Optional add-on: `@plumbus/voice`

`@plumbus/voice` provides the real-time voice runtime (`defineVoice`, `runVoiceTurn`, `registerVoiceRoutes`, transport/STT/TTS providers, cost helpers). It is a peer dependency of `@plumbus/core` (version-locked `^0.6.x`). Apps that want speech input/output install it explicitly:

```
pnpm add @plumbus/voice
```

Use it when the product needs speech I/O around an app-owned brain hook. It complements `@plumbus/chat` text surfaces; it is not a speech-to-speech replacement for Plumbus primitives. Start with `docs/voice/` for the runtime, transport, security, and testing guidance.

### Optional add-on: `@plumbus/knowledge-base`

`@plumbus/knowledge-base` provides scoped knowledge providers (`defineKnowledgeSource`, `createKnowledgeRegistry`, `staticBlocks`, `ragCorpus`, etc.) for registry-backed grounding in chat, capabilities, and search UIs. It is an optional peer of `@plumbus/chat` (version-locked `0.1.x`). Apps that want named, reusable knowledge sources install it explicitly:

```
pnpm add @plumbus/knowledge-base
```

Apps that only need a single direct RAG corpus in chat can use `ragContext` from `@plumbus/chat` without installing KB. Vector ingest remains in `@plumbus/core` (`plumbus rag ingest`).

### From `@plumbus/ui`

| Package | Provided by |
|---------|-------------|
| next | `dependencies` |
| next-intl | `dependencies` |
| react | `dependencies` |
| react-dom | `dependencies` |
| tailwindcss | `dependencies` |
| @tailwindcss/postcss | `dependencies` |
| typescript | `dependencies` |
| @types/react | `dependencies` |
| @types/react-dom | `dependencies` |

Consumer apps run tests with `plumbus test` (wraps vitest). The CLI command resolves vitest from within the framework.

## `@plumbus/core` peer ranges — CRITICAL

When editing `peerDependencies` in any `packages/*/package.json` (releases, new add-ons, compatibility bumps):

- Read `packages/plumbus-core/instructions/peer-dependencies.md` first.
- **Copy literals — do not derive ranges.** Most add-ons use exactly `"0.5.x || 0.6.x"` (see `packages/mcp/package.json`). Never use `^0.x` caret ranges on `@plumbus/core` peers.
- **pnpm passing locally does not prove peers are correct.** Backend Docker installs with **npm**; wrong peers break production builds.

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

- **New package**: scaffold under `packages/<name>/` and follow [`.agents/skills/new-package-instructions/SKILL.md`](.agents/skills/new-package-instructions/SKILL.md) — every publishable package needs `instructions/`, README links, and `"instructions"` in `package.json` `files`
- **New module**: create `src/<module>/index.ts` + `__tests__/` + re-export from `src/index.ts`
- **New CLI command**: `src/cli/commands/<name>.ts` with `register<Name>Command()`, add export to `commands/index.ts`, register in `cli.ts`
- **New define function**: `src/define/define<Primitive>.ts` + types in `src/types/` + validate with Zod + freeze output
- **New translation catalog**: `src/cli/commands/translation.ts` scaffolds to `app/translations/<name>.translation.ts`
- **New governance rule**: add to `src/governance/rules/`, register in `rules/index.ts` — advisory only

## Barrel Structure

- Each module has an `index.ts` barrel with a doc comment explaining the module’s purpose
- `src/index.ts` is split into **TIER 1** (SDK surface) and **TIER 2** (CLI/tooling internals)
- `src/cli/commands/index.ts` exports all `register*Command()` functions
- When adding exports to `src/index.ts`, place them in the correct tier

## Key Design Decisions

- **Contract-first**: `define*()` functions are the source of truth for everything
- **Deny-by-default security**: no matching access policy = denial
- **Advisory governance**: warnings only, never hard blocks
- **Outbox pattern**: events written in same transaction, dispatched async (at-least-once)
- **Biome**: Biome for linting and formatting. `tsc --noEmit` remains the type-checking gate

## Detailed Documentation

For architecture, SDK reference, and design rationale, read files under `docs/`:

- `docs/architecture/` — system overview, execution lifecycle, diagrams
- `docs/core-concepts/` — capabilities, entities, flows, events, prompts, governance
- `docs/sdk-reference/` — define functions, execution context, data layer, configuration
- `docs/cli/` — all CLI commands and options
- `docs/security/` — security model, auth, tenant isolation
- `docs/ai/` — prompts, RAG, cost tracking
- `docs/testing/` — test utilities, patterns, examples
- `packages/plumbus-core/instructions/peer-dependencies.md` — **required reading** before editing add-on `peerDependencies` on `@plumbus/core`
- `packages/plumbus-core/instructions/deployment.md` — production deployment, Docker, environment variables
- `packages/plumbus-core/instructions/upgrading-0.5-capabilities.md` — consumer agent playbook for 0.5.x capability invocation breaking changes
- `docs/upgrading-workers.md` — 0.5.0 workers/queues migration and breaking-behavior checklist
- `docs/upgrading-capability-names.md` — canonical capability names, invoke policy, flow auth snapshot

## Documentation — CRITICAL

Before making changes, read the relevant docs under `docs/` to understand the current design and conventions.

After making changes, update the corresponding documentation in `docs/`. **This is mandatory — every code change must include documentation updates.** Outdated docs are worse than no docs.

## Keeping Agent Files in Sync

`AGENTS.md` and `CLAUDE.md` must stay identical. When editing one, always apply the same change to the other.

## Agent Safety

- Framework-first is mandatory. When modifying consumer-facing agent templates, docs, or instruction files, preserve the rule that Plumbus primitives and `ctx.*` subsystems are the required implementation path for app business logic.
- Read-only git inspection is allowed: `git status`, `git diff`, `git log`, `git show`.
- Do **not** run destructive git commands without explicit user approval: `git checkout` when restoring files, `git restore`, `git reset`, `git clean`, `git push --force`, branch deletion, or tag deletion.
- Do **not** overwrite or discard user changes to clean up a worktree. If reverting or discarding work is being considered, stop and ask first.
- `packages/*/instructions/` are consumer-facing AI instructions. Leave them alone unless the task explicitly targets agent guidance or framework instruction behavior.

## Linting & Formatting

- **Tool**: [Biome](https://biomejs.dev/) — single tool for both linting and formatting
- **Config**: `biome.json` at repo root
- **Lint**: `pnpm lint` (or `npx biome lint ./src` in a package)
- **Format**: `pnpm format` (or `npx biome format --write ./src` in a package)
- **Check format**: `pnpm format:check`
- **Suppress a rule inline**: `// biome-ignore lint/ruleName: reason`
- **Suppress for entire file**: `// biome-ignore-all lint/ruleName: reason` (at top of file)
- Do **not** use ESLint, Prettier, or any other linter/formatter — Biome replaces all of them
- Biome rule names differ from ESLint (e.g. `noNonNullAssertion` not `@typescript-eslint/no-non-null-assertion`)

### Mandatory Validation — CRITICAL

After **every** code change, you **must** run all four checks before considering the work done:

```bash
pnpm lint          # Biome lint — zero errors, zero warnings
pnpm format:check  # Biome format — zero formatting drift
pnpm typecheck     # tsc --noEmit — zero type errors
pnpm test          # Vitest — all tests pass
```

**`pnpm lint` and `pnpm format:check` are separate commands.** Passing lint does NOT mean formatting is correct. Both must pass. If `format:check` fails, run `pnpm format` to auto-fix, then verify with `format:check` again.

Do **not** push, commit, or report completion until all four commands succeed.

### Zero-Tolerance Lint Policy

- **All lint rules are errors** — `pnpm lint` must produce zero errors and zero warnings
- **`noExplicitAny`**: turned **off** — `any` is allowed where needed (test mocks, Zod generics, FFI)
- **`noConsole`**: turned **off** — `console.*` is used intentionally in CLI and logger code
- **`noNonNullAssertion`**: **error** — never use `!` postfix; prefer optional chaining (`?.`), nullish coalescing (`??`), or explicit guards
- **`noUnusedVariables`**: **error** — no dead code
- **No new warnings allowed** — every PR must pass `pnpm lint` cleanly

## Files You Should Not Edit

- `dist/`, `node_modules/`, `.turbo/` — generated/managed
- `design/`, `general-desc/` — reference documentation (gitignored)
