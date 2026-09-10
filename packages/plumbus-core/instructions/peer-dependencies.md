# `@plumbus/core` peer dependency ranges

Read this file before editing `peerDependencies` in any `packages/*/package.json`.

## Security release family — explicit upgrade required

Core **0.7.x**, UI **0.8.x**, MCP **0.6.x**, voice **0.5.x**, and the remaining add-ons **0.2.x** form one coordinated release family. This is an intentional migration boundary: legacy caret ranges must not install these packages, and new packages must not accept legacy Plumbus peers. Do not widen these ranges to admit old core/voice lines just to make an installation pass.

The previous family remains on core 0.6.x, UI 0.7.x, MCP 0.5.x, voice 0.4.x, and add-ons 0.1.x. Historical feature floors are not peer contracts for the new release.

## Canonical literals — copy exactly

| Declaring package | Peer target | Literal |
| --- | --- | --- |
| Every add-on that peers on core | `@plumbus/core` | `"0.7.x"` |
| `@plumbus/core` | `@plumbus/mcp` | `"0.6.x"` (optional) |
| `@plumbus/core` | `@plumbus/api` | `"0.2.x"` (optional) |
| `@plumbus/core` | `@plumbus/ai-bedrock` | `"0.2.x"` (optional) |
| `@plumbus/chat` | `@plumbus/knowledge-base` | `"0.2.x"` (optional) |
| `@plumbus/chat-ui` | `@plumbus/chat` | `"0.2.x"` |
| `@plumbus/auth-cognito` | `@plumbus/auth` | `"0.2.x"` |
| Every `@plumbus/voice-*` provider | `@plumbus/voice` | `"0.5.x"` |

UI 0.8.0 replaces its direct core dependency with the required peer `"@plumbus/core": "0.7.x"` and uses `workspace:*` only for development. This prevents npm from accepting old application core plus a hidden new core nested inside UI. Install core and UI together. All Plumbus packages share the application runtime through peers.

Voice does not peer on vendor add-ons. Apps explicitly install only providers they use, register their `*_REGISTRATION` through `createProviderRegistry()`, and pass that registry to routes/workers.

## Rules

- Copy literals from the table and canonical manifests (`packages/mcp/package.json`, `packages/plumbus-core/package.json`, `packages/voice-livekit/package.json`). Never use `^0.x` core peers or derive unions from intuition.
- New-family packages require the new family. Do not publish narrowed peers or migration-requiring behavior as a patch on an old line: an existing caret could select that patch.
- `pnpm install` passing in this workspace does not prove npm consumer compatibility. Validate packed tarballs with npm; production installs use npm.
- Keep `release/security-release.json`, all manifests, READMEs, package instructions, changelogs, and AGENTS/CLAUDE in sync. `pnpm check:release` checks the version boundary and internal dependency graph.
- Packages stage under the **next** npm dist-tag. Promoting to latest is a separate operator decision after the entire family and consumer staging checks pass.

## Future releases

Within this family, patch releases must preserve supported behavior. For another migration-requiring release, first update this policy and `release/security-release.json`, then move every affected package outside its previous caret range. Re-check direct and transitive dependencies; a core-only bump is insufficient when UI bundles core or peers are auto-installed.

Run lint, format checking, typechecking, tests, and packed npm install checks before publication. Never mutate git, create a release tag, publish, or promote npm dist-tags without the authorization required by repository instructions.

## Consumer upgrade

Read [upgrading-security-release.md](./upgrading-security-release.md), explicitly select the new package versions for every installed Plumbus add-on, and run `plumbus init --patch` for agent wiring **v16**. Keep application business logic in Plumbus primitives and `ctx.*`; do not bypass security checks to make a migration pass.
