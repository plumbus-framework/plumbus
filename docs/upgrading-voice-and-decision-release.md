# Voice and decision provider release — 2026-09-23

This page describes the initial release. For core integration, classification
provider/model selection, and current agent wiring, see the
[classification upgrade guide](upgrading-classification.md).

This release adds optional typed decision packages, improves voice delivery and
recognition recovery, and updates core AI pricing and structured tool output.
Existing packages stay within the core `0.7.x` compatibility family. No database
migration or new agent-wiring version is introduced by this release.

## Package versions

| Package | Previous | Prepared |
| --- | --- | --- |
| `@plumbus/core` | 0.7.1 | 0.7.2 |
| `@plumbus/chat` | 0.2.1 | 0.2.2 |
| `@plumbus/voice` | 0.5.1 | 0.5.2 |
| `@plumbus/voice-livekit` | 0.2.1 | 0.2.2 |
| `@plumbus/voice-soniox` | 0.2.1 | 0.2.2 |
| `@plumbus/voice-deepdub` | 0.2.1 | 0.2.2 |
| `@plumbus/ai-decision` | New | 0.2.0 |
| `@plumbus/ai-decision-typesafe` | New | 0.2.0 |
| `@plumbus/ai-decision-laya` | New | 0.2.0 |

UI and other unchanged packages retain their current versions. Canonical peer
ranges remain core `0.7.x`, voice `0.5.x`, and add-ons `0.2.x`; see the
[peer policy](../packages/plumbus-core/instructions/peer-dependencies.md).
Applications on earlier minor families must first follow the
[security release migration](./upgrading-security-release.md).

## Upgrading existing applications

- Upgrade core to `0.7.2` for GPT-6 Sol/Luna and Claude Opus 5.5 pricing, plus
  same-call final-answer schema validation with native tools. Install chat
  `0.2.2` alongside it when using structured custom-agent output. The server-only
  `onAgentOutput` callback observes the validated result; only `content` reaches
  the chat event stream. See [tool calling](./chat/tool-calling.md).
- Upgrade voice to `0.5.2` for server-resolved recognition context, STT confidence
  and failure handling, configurable transcript bounds, and opt-in
  `tts.responseMode: 'reply'`. Sentence delivery and the default 4,000 UTF-16-code-unit
  transcript bound remain the defaults. Use Soniox `0.2.2` with voice `0.5.2`
  for dynamic recognition hints and provider error recovery. See
  [voice configuration](./voice/configuration.md).
- Upgrade both the LiveKit browser bundle and agent/worker to `0.2.2` before
  enabling longer transcripts or large events. Events above 15 KiB use native
  text streams, with a 256 KiB limit; older browser bundles cannot receive that
  path. Audio is framed into captures of at most 20 ms. See
  [continuous LiveKit voice](./voice/livekit-continuous-voice.md).
- Deepdub `0.2.2` changes the default/recommended model to `dd-etts-3.3`.
  Explicit `dd-etts-3.2` and `dd-etts-3.0` pins remain supported. Pin a model if
  its output must remain stable across upgrades.

Install only the optional packages the application uses, refresh its lockfile,
and deploy the API, workers, and browser from the intended dependency set.
Keep business logic in Plumbus primitives and `ctx.*`; provider classes remain
infrastructure. Vendor voice packages still require explicit registry wiring.

## New decision packages

Install `@plumbus/ai-decision-typesafe@0.2.0` or
`@plumbus/ai-decision-laya@0.2.0`. Each depends on the shared
`@plumbus/ai-decision@~0.2.0`, independently of the other provider. All require
core `0.7.x` and Node.js 20.6 or later.

These are package-only adapters for infrastructure testing. Core `ctx.ai.decide()`,
named decision registration, automatic budget/audit integration, and CLI/agent
discovery remain deferred. Do not register a decision adapter in core's text
generation registry or bypass Plumbus primitives for application business logic.

Laya includes a separate Python service and CPU Dockerfile. Installing its npm
package does not install Python, PyTorch, or model weights. The
[decision guide](./ai/decision-providers.md) and
[local smoke example](../examples/ai-decision-smoke/README.md) describe setup.
Both adapters have been exercised against real local Laya inference; hosted
TypeSafe authentication, model behavior, and billing require a TypeSafe endpoint
and have not been verified by that test.

## Release validation and publication

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`,
`pnpm build`, `pnpm typecheck`, and `pnpm test` before publication. The publish
workflow now includes all these gates and explicitly provisions Python 3.11 for
the offline Laya tests; default tests require no model weights or credentials.

Pack the nine packages with `pnpm pack` and install the tarballs in clean npm
consumers without `--force` or `--legacy-peer-deps`. Check rewritten workspace
dependencies, a single shared core runtime, exported entry points, packaged
instructions/changelogs, and the Laya service files. This catches problems that
workspace symlinks can conceal.

The tag-triggered workflow already publishes core before the decision packages,
the shared decision package before its adapters, and voice before vendor voice
packages. Existing published versions are skipped. Publication uses npm's default
`latest` dist-tag. Repository release tags are independent of package versions;
do not reuse or move an existing tag.

Before the first publication, confirm npm publish access and trusted-publisher
configuration for the three new package names and this repository's
`.github/workflows/publish.yml`. Those account settings cannot be established by
local package validation. Git commits/tags/pushes and npm publication are separate
release actions; preparing these files does not perform them.
