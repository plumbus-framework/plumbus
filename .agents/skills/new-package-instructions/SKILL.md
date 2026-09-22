---
name: new-package-instructions
description: 'Ensure new Plumbus packages ship consumer-facing agent instructions. Use when: creating a new package under packages/, scaffolding a framework add-on, or when a package lacks an instructions/ folder.'
---

# New Package Agent Instructions

Every publishable package under `packages/` must ship `instructions/` so AI agents working in consumer apps have prescriptive recipes (not just README marketing copy).

## When to Use

- Creating a new package under `packages/`
- A package has `README.md` but no `instructions/`
- Reviewing whether a package is "complete" before release

## Reference packages

Mirror the dominant pattern from sibling packages:

| Package | Pattern |
|---|---|
| [`packages/mcp/instructions/`](../../packages/mcp/instructions/) | `README.md` index + topic files (`framework.md`, recipes, `testing.md`) |
| [`packages/chat/instructions/`](../../packages/chat/instructions/) | `README.md` index + `framework.md` + task-specific recipes |
| [`packages/knowledge-base/instructions/`](../../packages/knowledge-base/instructions/) | `README.md` index + conventions + integration recipes |

Read at least one sibling before authoring a new package's instructions.

## Required deliverables

### 1. `packages/<name>/instructions/`

Create a folder with at least:

- **`README.md`** — index table: file → when to read; critical rules summary; link to package README
- **`framework.md`** (or `conventions.md`) — package boundary (core vs add-on), when to install, public exports, file map, critical rules

Add topic files as needed (recipes, testing, CLI, integration with other packages). Keep files **prescriptive** ("do this, don't do that"). Point to `docs/<topic>/` for conceptual reference.

### 2. Content checklist

Every instructions set must cover:

- [ ] **Purpose** — what the package is for and when *not* to use it
- [ ] **Install / peer deps** — optional vs required; for `@plumbus/core` copy exactly `"0.5.x || 0.6.x"` from `packages/mcp/package.json` (read `packages/plumbus-core/instructions/peer-dependencies.md` — never derive ranges)
- [ ] **Quick start** — minimal working example (expose capability, wire bootstrap, run CLI)
- [ ] **Key exports** — table or list of public API surface
- [ ] **CLI commands** — if any ship in `@plumbus/core` via dynamic import
- [ ] **Docs links** — `docs/<topic>/` in monorepo + `packages/<name>/README.md`
- [ ] **Ecosystem context** — how it relates to `@plumbus/core`, `@plumbus/ui`, `@plumbus/mcp`, etc.
- [ ] **Framework-first rule** — business logic stays in Plumbus primitives (`defineCapability`, `ctx.*`); add-ons are adapters, not parallel implementations

### 3. `package.json` `files` array

Include `"instructions"` so agent recipes ship in the npm tarball:

```json
"files": ["dist", "instructions", "README.md", "CHANGELOG.md"]
```

### 4. Package `README.md`

Add an **Agent recipes** section linking to each file under `instructions/` (see [`packages/mcp/README.md`](../../packages/mcp/README.md#documentation) for the pattern).

For the cross-package "ecosystem" section, add a **single static pointer** to the root [`README.md`](../../README.md#packages) Packages table — do **not** replicate the package list as a per-package table. The root table is the single source of truth; a replicated table forces an all-READMEs edit (and a republish of every package) each time a package is added. Use this exact shape:

```md
## The Plumbus ecosystem

`@plumbus/<name>` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
```

A package-specific `## When to use this vs alternatives` decision table is fine and encouraged — that is distinct from the global package list.

### 5. Monorepo docs (when applicable)

If the package has a `docs/<topic>/` tree, cross-link from the instructions index and ensure `docs/README.md` lists the topic.

## Procedure

### Step 1: Scaffold

```text
packages/<name>/instructions/
├── README.md           # index + critical rules
├── framework.md        # package boundary, exports, rules
└── <topic>.md          # recipes as needed
```

### Step 2: Write prescriptive content

- Match tone and length of [`packages/mcp/instructions/`](../../packages/mcp/instructions/) or [`packages/chat/instructions/`](../../packages/chat/instructions/)
- Use code examples with `@plumbus/core` imports and `.js` extensions only in framework `src/` references, not consumer examples
- Call out gotchas that agents commonly get wrong (auth, scopes, footguns)

### Step 3: Wire publishing surface

1. Add `"instructions"` to `package.json` `files`
2. Set `peerDependencies["@plumbus/core"]` to exactly `"0.5.x || 0.6.x"` (copy from `packages/mcp/package.json`; see `packages/plumbus-core/instructions/peer-dependencies.md`)
3. Link instructions from package `README.md`, and add its "ecosystem" section as a **static pointer** to the root Packages table — never a replicated table (see §4)
4. Add **one row** to the root [`README.md`](../../README.md#packages) `## Packages` table (the single source of truth for the package list), and update `docs/` if a new topic area was added
5. Add a publish step to [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) **after** any packages it peer-depends on (e.g. `@plumbus/api` after `@plumbus/core`)

### Step 3b: Register in `plumbus init` agent wiring

So consumer apps discover instructions via `plumbus init --patch` and `plumbus doctor`, register the package in [`packages/plumbus-core/src/cli/commands/init.ts`](../../packages/plumbus-core/src/cli/commands/init.ts):

1. Add a `<PKG>_INSTRUCTION_REFERENCES` array (mirror [`MCP_INSTRUCTION_REFERENCES`](../../packages/plumbus-core/src/cli/commands/init.ts)) with `area` + `node_modules/@plumbus/<pkg>/instructions/<file>.md` paths
2. Loop over it in `addInstructionReferenceLines()`
3. Mention the package in the inline-mode string if applicable
4. Bump `AGENT_WIRING_VERSION`
5. Add assertions in [`packages/plumbus-core/src/cli/__tests__/init.test.ts`](../../packages/plumbus-core/src/cli/__tests__/init.test.ts) for each instruction path
6. Update [`docs/agents/agent-setup.md`](../../docs/agents/agent-setup.md) (diagram + instruction table)

Optional: add a bridge doc under `packages/plumbus-core/instructions/<topic>.md`, append to `CORE_INSTRUCTION_TOPICS`, and extend `generateCursorCapabilityRule()` / scaffold templates if the add-on has an `exposeAs` pattern.

### Step 4: Update framework agent docs

If this is a new optional add-on, ensure `AGENTS.md` / `CLAUDE.md` Consumer App Dependency Policy mentions the package (keep both files identical).

### Step 5: Validate

From repo root:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

## Package completeness checklist

Before considering a new package done:

- [ ] `packages/<name>/instructions/README.md` exists
- [ ] At least one framework/conventions file exists
- [ ] `package.json` `files` includes `"instructions"`
- [ ] Package `README.md` links to agent recipes
- [ ] Root `README.md` `## Packages` table has a row for the new package; the package `README.md` uses a static ecosystem **pointer**, not a replicated table
- [ ] `docs/<topic>/` exists or is cross-linked if the package has conceptual docs
- [ ] Tests cover the package's public API
- [ ] `AGENTS.md` / `CLAUDE.md` mention the optional add-on if consumer-facing
- [ ] `init.ts` `*_INSTRUCTION_REFERENCES` registered and `AGENT_WIRING_VERSION` bumped
- [ ] `init.test.ts` asserts instruction paths; `docs/agents/agent-setup.md` updated
- [ ] `.github/workflows/publish.yml` includes the package (after its peer dependencies)
- [ ] `CHANGELOG.md` has an entry for the release version

## Anti-patterns

- README-only packages with no `instructions/` — agents in consumer apps read `node_modules/@plumbus/<pkg>/instructions/`, not monorepo `docs/`
- Conceptual-only docs in `docs/` with no prescriptive recipes in the package
- Instructions that teach raw HTTP/Fastify patterns instead of Plumbus primitives
- Forgetting `"instructions"` in `package.json` `files` — tarball consumers won't see the folder
- Replicating the full package list as a table in each package `README.md` — it drifts and forces an all-packages edit/republish on every addition; use a static pointer to the root `## Packages` table instead
