# `@plumbus/core` peer dependency ranges

Read this file before editing `peerDependencies` in any `packages/*/package.json`.

## Stabilization release family — explicit upgrade required

Core **0.8.x**, UI **0.9.x**, MCP **0.7.x**, voice **0.6.x**, and the remaining add-ons **0.3.x** form the stabilization family. Read [stabilization.md](./stabilization.md) before upgrading. Migrate durable flow, scheduler, and job records; drain old flow-mutating API/worker processes before activation. Do not mix old and new schedulers or workers against the same queues.

The previous family remains core 0.7.x, UI 0.8.x, MCP 0.6.x, voice 0.5.x, and add-ons 0.2.x. Historical feature floors describe earlier releases, not current peer declarations.

## Canonical literals — copy exactly

| Declaring package | Peer target | Literal |
| --- | --- | --- |
| Every add-on that peers on core (except the four below) | `@plumbus/core` | `"0.8.x"` |
| `@plumbus/voice` 0.6.1+, `@plumbus/chat` 0.3.1+, `@plumbus/payments` 0.3.1+, `@plumbus/voice-livekit` 0.3.1+ | `@plumbus/core` | `">=0.8.3 <0.9.0"` (they import `@plumbus/core/sdk`, added in core 0.8.3) |
| `@plumbus/core` | `@plumbus/mcp` | `"0.7.x"` (optional) |
| `@plumbus/core` | `@plumbus/api` | `"0.3.x"` (optional) |
| `@plumbus/core` | `@plumbus/ai-bedrock` | `"0.3.x"` (optional) |
| `@plumbus/chat` | `@plumbus/knowledge-base` | `"0.3.x"` (optional) |
| `@plumbus/chat-ui` | `@plumbus/chat` | `"0.3.x"` |
| `@plumbus/auth-cognito` | `@plumbus/auth` | `"0.3.x"` |
| `@plumbus/payments-stripe` | `@plumbus/payments` | `"0.3.x"` |
| Every `@plumbus/voice-*` provider (except voice-livekit) | `@plumbus/voice` | `"0.6.x"` |
| `@plumbus/voice-livekit` 0.3.1+ | `@plumbus/voice` | `">=0.6.1 <0.7.0"` (imports `@plumbus/voice/session`, added in voice 0.6.1) |

UI 0.9.x uses the required peer `"@plumbus/core": "0.8.x"` and `workspace:*` only for development. This prevents npm from accepting old application core plus a hidden new core nested inside UI. Install core and UI together. All Plumbus packages share the application runtime through peers.

Voice does not peer on vendor add-ons. Apps explicitly install only providers they use, register their `*_REGISTRATION` through `createProviderRegistry()`, and pass that registry to routes/workers.

## Rules

- When an add-on starts importing an export that only exists from a later patch of core or voice, raise that add-on's peer to an explicit floor within the family (`">=0.8.N <0.9.0"`), list it in the table above, and say so in its changelog. Otherwise npm installs it next to an older core or voice and the import fails.
- Copy literals from the table and canonical manifests (`packages/mcp/package.json`, `packages/plumbus-core/package.json`, `packages/voice-livekit/package.json`). Never use `^0.x` core peers or derive unions from intuition.
- New-family packages require the new family. Do not publish narrowed peers or migration-requiring behavior as a patch on an old line: an existing caret could select that patch.
- `pnpm install` passing in this workspace does not prove npm consumer compatibility. Validate packed tarballs with npm; production installs use npm.
- Keep all manifests, READMEs, package instructions, changelogs, and AGENTS/CLAUDE in sync.
- Packages publish normally to npm’s **latest** dist-tag; there is no separate release-staging or promotion step.

## Future releases

Within this family, patch releases must preserve supported behavior. For another migration-requiring release, first update this policy and the release version table, then move every affected package outside its previous caret range. Re-check direct and transitive dependencies; a core-only bump is insufficient when UI bundles core or peers are auto-installed.

Run lint, format checking, typechecking, tests, and packed npm install checks before publication. Never mutate git, create a release tag, publish, or promote npm dist-tags without the authorization required by repository instructions.

## Consumer upgrade

Read [stabilization.md](./stabilization.md) and [upgrading-security-release.md](./upgrading-security-release.md), explicitly select the new package versions for every installed Plumbus add-on, and run `plumbus init --patch --agent all` for current agent wiring (**v21** with core 0.8.0+; v17 added the classification recipe). For classification/provider/model selection, read [ai-classification.md](./ai-classification.md). Keep application business logic in Plumbus primitives and `ctx.*`; do not bypass security checks to make a migration pass.
