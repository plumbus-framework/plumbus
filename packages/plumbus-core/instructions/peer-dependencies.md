# `@plumbus/core` peer dependency ranges

Read this file **before** editing `peerDependencies` in any `packages/*/package.json`.

## CRITICAL rules

1. **Copy literals — do not derive ranges.** Never compute semver ranges from intuition. Copy the exact string from the table below or from a canonical `package.json` (`packages/mcp/package.json`, `packages/api/package.json`).
2. **Never use `^0.x` caret ranges** on `@plumbus/core` peers in add-on packages. npm treats `^0.5.0` as **0.5.x only** (`>=0.5.0 <0.6.0`), not "0.5 and above."
3. **pnpm passing locally does not prove peers are correct.** Backend Docker images install production deps with **npm** (`deployment.md` Rule 7). Wrong peers break Docker builds even when `pnpm install` succeeds.
4. **Do not copy from CHANGELOG history.** Older releases documented incorrect ranges (`^0.5.0 <0.7.0` claimed to support 0.6.x — it does not under npm). Use this file and the canonical `package.json` files instead.

## Canonical `@plumbus/core` peer strings

| Package kind | `peerDependencies["@plumbus/core"]` | Canonical copy-from |
|---|---|---|
| Most add-ons (chat, chat-ui, knowledge-base, mcp, api, browser-extension) | `"0.5.x \|\| 0.6.x"` | `packages/mcp/package.json` |
| Voice only (requires core 0.6+ media/cost APIs) | `"^0.6.0 <0.7.0"` | `packages/voice/package.json` |

When adding a **new** publishable add-on under `packages/`, use `"0.5.x || 0.6.x"` unless the package genuinely requires core 0.6+ only (then use the voice pattern).

## Forbidden patterns

| Range | Why it is wrong |
|---|---|
| `"^0.5.0 <0.7.0"` | npm resolves `^0.5.0` to 0.5.x only — **rejects `@plumbus/core@0.6.0`** |
| `"^0.5.0 <0.6.0"` | 0.5.x only — rejects 0.6.x |
| `"^0.6.x"` or `"^0.6.0"` alone | Too loose or wrong syntax for multi-line support; use the table literals |
| Widening an upper bound on a caret range | e.g. changing `<0.6.0` to `<0.7.0` on `^0.5.0` does **not** add 0.6.x support |

## When `@plumbus/core` gets a new minor line (e.g. 0.7.0)

Before tagging a core release:

1. Update the literal table in **this file** (add `0.7.x` to the union, e.g. `"0.5.x || 0.6.x || 0.7.x"`).
2. Update `peerDependencies["@plumbus/core"]` in **every** publishable add-on under `packages/` — copy the new literal everywhere; do not edit packages one-off with different strings.
3. Patch-bump and publish each affected add-on.
4. Update add-on `instructions/framework.md` (or `conventions.md`) peer lines to match.
5. Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` from repo root.

See also: `.agents/skills/bump-version/SKILL.md` (core **minor** bump checklist).

## Related docs

- `deployment.md` Rule 7 — backend `proddeps` uses `npm install --omit=dev`
- `.agents/skills/new-package-instructions/SKILL.md` — new package `package.json` peers
- `packages/mcp/package.json` / `packages/api/package.json` — canonical examples
