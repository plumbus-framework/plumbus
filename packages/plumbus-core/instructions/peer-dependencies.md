# `@plumbus/core` peer dependency ranges

Read this file **before** editing `peerDependencies` in any `packages/*/package.json`.

## CRITICAL rules

1. **Copy literals — do not derive ranges.** Never compute semver ranges from intuition. Copy the exact string from the table below or from a canonical `package.json` (`packages/mcp/package.json`, `packages/api/package.json`, `packages/voice/package.json`).
2. **Never use `^0.x` caret ranges** on `@plumbus/core` peers in add-on packages. npm treats `^0.5.0` as **0.5.x only** (`>=0.5.0 <0.6.0`), not "0.5 and above."
3. **pnpm passing locally does not prove peers are correct.** Backend Docker images install production deps with **npm** (`deployment.md` Rule 7). Wrong peers break Docker builds even when `pnpm install` succeeds.
4. **Do not copy from CHANGELOG history.** Older releases documented incorrect ranges (`^0.5.0 <0.7.0` claimed to support 0.6.x — it does not under npm). Use this file and the canonical `package.json` files instead.

## Canonical `@plumbus/core` peer strings (add-ons → core)

| Package kind | `peerDependencies["@plumbus/core"]` | Canonical copy-from |
|---|---|---|
| Most add-ons (chat, chat-ui, knowledge-base, mcp, api, browser-extension) | `"0.5.x \|\| 0.6.x"` | `packages/mcp/package.json` |
| Voice only (requires core 0.6+ media/cost APIs) | `"0.6.x"` | `packages/voice/package.json` |
| Auth only (requires core 0.6.8+ HttpAuthenticationRuntime) | `"0.6.x"` | `packages/auth/package.json` |
| AI Bedrock (requires provider `cost` preference + optional peer load) | `"0.6.x"` | `packages/ai-bedrock/package.json` |

When adding a **new** publishable add-on under `packages/`, use `"0.5.x || 0.6.x"` unless the package genuinely requires core 0.6+ only (then use the voice pattern).

**Documented runtime floors (declared peer may be wider):** npm peer strings stay on the coarse literals above. When a release needs a patch floor inside a minor line, document it in that package's README / CHANGELOG / `instructions/framework.md` — do not invent fine-grained peer ranges. Current floors:

| Package | Declared peer | Runtime floor |
|---|---|---|
| `@plumbus/chat` **0.1.11+** | `0.5.x \|\| 0.6.x` | `@plumbus/core` **≥ 0.6.11** (tool protocol + `updateWhere`) |
| `@plumbus/chat-ui` **0.1.7+** | `0.5.x \|\| 0.6.x` (+ `@plumbus/chat` `0.1.x`) | `@plumbus/chat` **≥ 0.1.11** (and thus core **≥ 0.6.11**) |
| `@plumbus/auth` | `0.6.x` | `@plumbus/core` **≥ 0.6.8** (`HttpAuthenticationRuntime`) |
| `@plumbus/api` **0.1.4+** | `0.5.x \|\| 0.6.x` | `@plumbus/core` **≥ 0.6.9** (`buildAuthenticationRequest` for partner session auth) |

## Other publishable peer strings

| Declaring package | Peer target | Literal | Required? | Canonical copy-from |
|---|---|---|---|---|
| `@plumbus/core` | `@plumbus/mcp` | `"0.5.x \|\| 0.6.x"` | optional | `packages/plumbus-core/package.json` |
| `@plumbus/core` | `@plumbus/api` | `"0.1.x"` | optional | `packages/plumbus-core/package.json` |
| `@plumbus/core` | `@plumbus/ai-bedrock` | `"0.1.x"` | optional | `packages/plumbus-core/package.json` |
| `@plumbus/ai-bedrock` | `@plumbus/core` | `"0.6.x"` | required | `packages/ai-bedrock/package.json` |
| `@plumbus/chat` | `@plumbus/knowledge-base` | `"^0.1.0"` | optional | `packages/chat/package.json` |
| `@plumbus/chat-ui` | `@plumbus/chat` | `"0.1.x"` | required | `packages/chat-ui/package.json` |
| `@plumbus/chat-ui` | `@plumbus/core` | `"0.5.x \|\| 0.6.x"` | required | `packages/chat-ui/package.json` |
| `@plumbus/auth` | `@plumbus/core` | `"0.6.x"` | required | `packages/auth/package.json` |
| `@plumbus/auth-cognito` | `@plumbus/auth` | `"0.1.x"` | required | `packages/auth-cognito/package.json` |
| `@plumbus/voice-deepdub` / `-soniox` / `-elevenlabs` / `-minimax` / `-livekit` | `@plumbus/core` | `"0.6.x"` | required | `packages/voice-deepdub/package.json` (same literal on all five) |
| `@plumbus/voice-deepdub` / `-soniox` / `-elevenlabs` / `-minimax` / `-livekit` | `@plumbus/voice` | `"0.4.x"` | required | `packages/voice-deepdub/package.json` (same literal on all five) |
| `@plumbus/voice` | `@plumbus/voice-deepdub` | `"0.1.x"` | optional | `packages/voice/package.json` |
| `@plumbus/voice` | `@plumbus/voice-soniox` | `"0.1.x"` | optional | `packages/voice/package.json` |
| `@plumbus/voice` | `@plumbus/voice-elevenlabs` | `"0.1.x"` | optional | `packages/voice/package.json` |
| `@plumbus/voice` | `@plumbus/voice-minimax` | `"0.1.x"` | optional | `packages/voice/package.json` |
| `@plumbus/voice` | `@plumbus/voice-livekit` | `"0.1.x"` | optional | `packages/voice/package.json` |

**Peering direction:** add-ons declare `@plumbus/core` as a peer — consumer apps install both. `@plumbus/core` optionally peers `@plumbus/mcp`, `@plumbus/api`, and `@plumbus/ai-bedrock` when those packages are present. `@plumbus/chat` optionally peers `@plumbus/knowledge-base` for registry-backed context sources — **not** the reverse. `@plumbus/knowledge-base` only peers `@plumbus/core`. `@plumbus/auth-cognito` peers `@plumbus/auth` only — not `@plumbus/core` directly. Voice provider packages peer `@plumbus/voice` `0.4.x` (and `@plumbus/core` `0.6.x`); `@plumbus/voice` does **not** peer the add-ons — apps install add-ons and pass `*_REGISTRATION` into `createProviderRegistry()` — **copy these literals; do not derive**.

## Forbidden patterns

| Range | Why it is wrong |
|---|---|
| `"^0.5.0 <0.7.0"` | npm resolves `^0.5.0` to 0.5.x only — **rejects `@plumbus/core@0.6.0`** |
| `"^0.5.0 <0.6.0"` | 0.5.x only — rejects 0.6.x |
| `"^0.6.0 <0.7.0"` or `"^0.6.x"` on voice | Use the voice literal `"0.6.x"` from `packages/voice/package.json` |
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
- `packages/mcp/package.json` / `packages/api/package.json` / `packages/voice/package.json` — canonical examples
