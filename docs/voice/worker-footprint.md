# Voice worker dependency footprint

LiveKit runs each dispatched call in its own Node process. Every process imports
its own runtime and application resources; removing unrelated application imports
reduces both startup work and retained memory. The vendor SDK and its process-per-job
model remain in use. See [continuous voice](./livekit-continuous-voice.md).

## Scoped application bootstrap

By default `plumbus voice worker` retains the legacy full-app discovery and server
extension loading. To opt into scoped discovery, create `app/voice/runtime.ts`
(or `runtime.js`) exporting `voiceRuntime`, typed with `VoiceRuntimeConfig` from
`@plumbus/core`:

```ts
import type { VoiceRuntimeConfig } from '@plumbus/core';
import { conductInterviewTurn } from '../capabilities/interview/conduct-turn/capability.js';
import { InterviewSession } from '../entities/interview-session.entity.js';
import { interviewReply } from '../prompts/interview-reply.prompt.js';
import { onAICostRecorded, resolveAiOverrides } from '../shared/ai-hooks.js';

export const voiceRuntime = {
  resources: {
    capabilities: [conductInterviewTurn],
    entities: [InterviewSession],
    events: [],
    prompts: [interviewReply],
    // Optional: translations, flows, decisions.
  },
  extensions: {
    onAICostRecorded,
    resolveAiOverrides,
    // Optional: enableStrictStructuredOutputs, decisions (provider registration).
  },
} satisfies VoiceRuntimeConfig;
```

Names and imports above are illustrative. Include **all transitive resources** used
by the voice definition, its brain and recognition-context hooks, nested capability
invocations, and accounting/override hooks. Include tenant and encrypted entities,
emitted event definitions, prompts, translations, and any flows the interview starts.
An omitted capability is unavailable to `ctx.capabilities.invoke`; there is no
fallback to scanning the rest of the app when a lookup fails.

The default child bootstrap and explicit `--room` mode use this module.
The dispatch parent loads only voice definitions and provider registrations, so it
opens no application DB/queue connection and constructs no AI/resource context.
It still validates voice/provider configuration before registering with LiveKit.
DB, AI hook and resource configuration errors are detected when a child starts.
Both parent and child still discover `app/voices/` and load `app/voice/registry.ts` for the
explicit provider registrations and credentials. `config/app.config.*` and the
worker environment still configure the DB, AI, and runtime.

Scoped mode skips `discoverResources()` and **does not import `app/server.ts`**.
Extract the existing AI hooks into a shared module and import that module from
both the API server and `voiceRuntime.extensions`. Do not re-export the hooks from
`app/server.ts`: doing so imports the server and its payment/auth dependencies again.
The `extensions` object is required, even if intentionally empty. Preserve all
accounting and model/prompt override hooks that the interview needs. Decision
provider registrations come from `extensions.decisions`; any listed resource decision
definitions are appended to that registration.

The framework still builds the normal governed context: participant identity,
tenant-scoped data, encryption, audit persistence, transactional event outbox,
capability access/dependency checks, AI accounting, and translations. Scoped mode
creates no MCP authenticator or Redis queue connections. Its unused HTTP adapter
authenticates no bearer tokens; it is not a route-serving context. Participant
identity still comes through the existing voice transport. Events persist to the
outbox for the application's ordinary workers. Flow services are constructed only
when `resources.flows` is nonempty; flow execution remains worker-owned. This
bootstrap does not supply job enqueue wiring.

If the module is missing, the legacy path still applies, including its MCP auth
configuration requirements. If it exists but cannot be imported or has an invalid
module envelope, startup fails instead of silently loading the full app.

A custom `PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE` continues to own its child bootstrap;
this convention applies to the default core bootstrap.

## Production JavaScript build

From the application root, build into an empty output directory:

```bash
plumbus voice build --out-dir .plumbus/voice-build
plumbus voice worker --compiled .plumbus/voice-build --voice interviewer
```

The build requires `app/voice/runtime.ts` (or `.js`/`.mjs`), the provider registry,
and `app/voices` modules. It bundles reachable application modules into shared ESM
chunks, including `config/app.config.*` when present. It does not execute application
code or embed environment variable values at build time. Package dependencies remain
external, including native LiveKit modules. Keep the output under the application
installation or otherwise provide its normal `node_modules` dependencies.

Output must be empty: existing files are never overwritten or silently left as stale
voice definitions. Use a fresh output directory for each build. Static imports are
compiled; unresolved imports and reported unsupported dynamic imports fail the build.
Computed imports/requires and filesystem assets are not a general application packaging
mechanism: make imports static and arrange required assets explicitly. Bundling changes
module locations, so review any code using `import.meta.url` to locate data files.

The builder rewrites exact app imports of `@plumbus/core` to `@plumbus/core/sdk`,
and `@plumbus/voice` to `@plumbus/voice/session`. Voice build inputs must use runtime
APIs from those surfaces; CLI tooling and HTTP/admin registration belong in the API
server. Other subpath imports and third-party package imports remain unchanged.
Third-party packages that import the broad roots can still bring those graphs back.

`--compiled` validates the build marker and passes the absolute directory to child
processes through `PLUMBUS_VOICE_APP_ROOT`, with
`PLUMBUS_VOICE_JAVASCRIPT_ONLY=true`. The default parent/child loaders select only
JavaScript and do not register `tsx` or load esbuild. Missing scoped runtime output
and broken compiled voice imports fail startup rather than falling back to source.
Keep supplying the normal worker environment and runtime configuration: this option
does not change participant auth, tenant scoping, accounting, or DB requirements.
Custom child bootstrap modules must honor the compiled-directory contract themselves.

## Narrow framework entry points

`@plumbus/core/sdk` exposes the existing runtime SDK without CLI commands,
scaffolding and governance reports. The original `@plumbus/core` remains a compatibility
entry containing both runtime and tooling exports. Both entries share the same
implementation modules and state; this is not a second execution runtime.

`@plumbus/voice/session` exposes definitions, provider registry/factories, costs and
session execution without HTTP/catalog/clone-management route registration. The
LiveKit worker and cost adapter use it directly. Voice provider implementations use
`@plumbus/core/errors` for error-only imports. The normal voice root still exposes
HTTP/admin APIs. Provider validation still uses catalog metadata where required;
not every catalog-related helper can be removed.

The CLI executable selects a small voice-only command parser for `voice worker`;
other commands retain the full CLI. Existing source-mode workers and `--room` remain
supported. With `startVoiceAgentWorker`, `createDependencies` may now be omitted when
a child bootstrap module is supplied (explicitly or through the existing bootstrap
environment variable). The parent then retains no dependency factory. Custom
`createVoiceAgentEntry` and child payloads still require the factory.

Use the updated core, voice and provider builds together. Apps can adopt the narrow
imports directly in source, or use the voice build's import rewriting.

## Deferred framework dependencies

Importing core no longer evaluates Fastify, SAML's XML/signature libraries or the
cron parser. HTTP construction loads Fastify synchronously; SAML verification loads
its libraries synchronously; cron-expression evaluation loads the parser. Existing
API signatures and validation behavior are preserved. Simple `every:` intervals do
not require the cron parser.

The LiveKit add-on loads RNNoise's WebAssembly package only when an agent RNNoise
processor is constructed. Disabled or client-side noise cancellation does not load
it on the agent. The established asynchronous initialization/raw-audio fallback
continues to apply. See [noise cancellation](./noise-cancellation.md).

Plumbus's token-minting function imports `livekit-server-sdk` on demand. However,
`@livekit/agents` 1.9.0 also imports that SDK itself, including from its worker, job
and telemetry code. It therefore **remains loaded in a dispatched call**. The
vendor's other eager imports (including image processing and telemetry) remain too.

## Measurement and limits

Measure in fresh processes with identical Node versions, dependency installations,
configuration and workloads. Record RSS, heap usage, elapsed startup time, and the
loaded module set before and after each change. RSS deltas overlap and fluctuate;
adding isolated package measurements does not predict the final process size.

A local Node 22.23.2 import-only check on 2026-10-18 measured approximately:

- Core public import: 108 MB RSS before, 100 MB after; 551 resolved modules before,
  386 after.
- LiveKit add-on public import: 183 MB RSS before, 165 MB after; 2,003 resolved modules
  before, 1,842 after.

These are single-run observations, not production call measurements or memory caps.
The import test verifies that core no longer evaluates the listed unused CommonJS
dependencies; RNNoise tests verify loading only on selection. Savings from scoped app
resources depend on the app's explicit module and its transitive imports. Verify a
real interview, cost records, events and tenant access after adopting the module.
Neither the historic 190–210 MB estimate nor a startup-time target is guaranteed.

A second local check compared source and compiled modes using the same small fixture
(one voice/capability, no AI requests), with the real LiveKit agent module imported
in both. Across three fresh processes per mode, median RSS was **206.6 MB for source
context startup** and **153.9 MB for compiled context startup**. Median elapsed startup
was 1.58 s and 1.17 s respectively; resolved module URLs fell from 1,885 to 1,762,
with no `tsx`/esbuild URLs in compiled mode. The compiled parent was 156.2 MB median;
its tiny fixture has too little app state to isolate a meaningful parent-only RSS
saving. These are synthetic bootstrap results, not MemoirAI production interviews.
The original 10–30 MB/call and 30–70 MB/parent figures were estimates, not guarantees.

## Upstream local inference preload

The LiveKit add-on now pins Agents 1.9.3 together with rtc-node 1.1.0. Do not upgrade
only Agents: its peer must resolve to the same native RTC binding as the add-on.
For external endpointing (for example Soniox), set
`LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE=0` before starting the worker. Upstream
1.9.3 defers the job binding preload and EOT model warm-up; first use can still load
the model. The inference helper may still exist, so measure its resident memory
rather than claiming the process is absent. Default SDK behavior remains unchanged
when the variable is unset. This is a vendor-supported flag, with no patched
registry or replacement of the agent runtime.

Source: [LiveKit inference warm-up](https://github.com/livekit/agents-js/blob/main/agents/src/inference/_warmup.ts).

## Classification metadata without repositories

`voiceRuntime.resources.securityEntities` optionally supplements the entities used
for AI field classifications and log masking. Only `resources.entities` gets data
repositories/tables. Classification metadata is combined with registered entities,
so omitting a data entity from the supplemental list cannot weaken its protection.
The caller should supply its full classification universe when narrowing repositories.
The default without supplemental metadata remains the registered entity list.

Chat-based voice workers can use `@plumbus/chat/session` for the governed chat runtime,
persistence entities and events without HTTP/admin/evaluation exports. Payment
schema imports can use `@plumbus/payments/entities`. Both retain the same definitions
and module identities as their compatibility roots.

## Projected data reads

Scope query fields as well as registered resources. `ctx.data.Entity.findMany` now
accepts `{ select: ['id', 'summary'] }` so large document bodies and JSON chunks
need not enter a call process when only their summaries are used. This retains
the governed repository, tenant/soft-delete filters and selected-field decryption.
See [field projection](../sdk-reference/data-layer.md#findmany). It reduces data-heavy
read allocations, not the fixed Node/RTC startup cost.
