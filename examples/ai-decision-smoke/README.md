# Local Laya + TypeSafe adapter smoke app

From the repository root, run one command:

```bash
node examples/ai-decision-smoke/run.mjs
```

Requires Node 22+, installed workspace dependencies (`pnpm install`), and a running
Docker daemon. The script builds the framework packages, generates a password,
starts the Laya CPU container, waits for the actual English checkpoint, and runs
both the Laya and TypeSafe adapters against it, and stops a server started by that
run when the checks finish (including failures). **No TypeSafe account is needed.**
First startup downloads model weights. This is real local inference, not the fake
backend used by offline unit tests.

## Password — already handled

The script creates **`examples/ai-decision-smoke/.env`** with a random password and
owner-only permissions. It passes that file to Docker and loads the same password
for both adapters. Do not copy `.env.example` over the generated file.

To choose your own password, edit `LAYA_API_KEY` in that example's `.env`, then run:

```bash
node examples/ai-decision-smoke/run.mjs restart
```

The repository-root `.env` is never read or modified. `.env` is ignored by Git.

## Commands

For repeated tests, explicitly start a persistent server first:

```bash
node examples/ai-decision-smoke/run.mjs start    # Start and wait, without inference
node examples/ai-decision-smoke/run.mjs smoke    # Run the checks again
node examples/ai-decision-smoke/run.mjs smoke "My account cannot log in."
node examples/ai-decision-smoke/run.mjs status
node examples/ai-decision-smoke/run.mjs logs
node examples/ai-decision-smoke/run.mjs stop
```

`restart` rebuilds/recreates only the example-owned container so config/image
changes take effect. It preserves the named model cache. The runner refuses to
modify a container with the same name if it belongs to another workspace.

Defaults:

- Endpoint: `http://127.0.0.1:8080/v1`; health: `http://127.0.0.1:8080/healthz`.
- Container: `plumbus-ai-decision-smoke`.
- Cache volume: `plumbus-ai-decision-smoke-cache`.
- Resources: 2 CPU cores, 6 GiB RAM limit, no container swap; allow extra host RAM
  for other work and disk space for Docker/model downloads.
- Checkpoint: `english`. For other checkpoints change `LAYA_MODEL` and include it
  in `LAYA_MODELS`, then restart; additional checkpoints need additional memory.

If port 8080 is occupied, change the port in `LAYA_BASE_URL` in the example `.env`
and run `restart`. This example intentionally permits only loopback URLs, so a
test cannot accidentally use the hosted TypeSafe endpoint or its credentials.

## What is tested

The app defines `smoke.classifyTicket` with `defineCapability` and invokes it through
the public execution pipeline. It checks role denial, invalid input, service
password enforcement, and three decision types (choice, score, probability) through
each adapter. Adapters are injected into the capability at the infrastructure
boundary; the capability calls `ctx.ai.decide()` and verifies scoped cost records.
No database is required.

The TypeSafe adapter uses the same local key and Laya checkpoint name. It tests the
shared wire protocol; it does not test actual Jev quality, TypeSafe account access
or hosted billing. Both results report unknown dollar cost for the local model.
The app prints decisions and usage without asserting a universal confidence cutoff.

A one-off run stops the server if it created or started it, freeing model memory.
A server that was already running is preserved. `start` and `restart` explicitly
keep the server running; `smoke` reuses it. Use `stop` when finished with that
persistent session. Passwords and model files are retained between starts. Read
[the provider guide](../../docs/ai/decision-providers.md) for the protocol and core integration.

Offline regression tests live in `packages/ai-decision-laya/src/__tests__/smoke-example.test.ts`
and run with `pnpm test`. They use injected fetch responses and do not start Docker
or download weights. Turbo includes the example's JavaScript files in that test
task's cache inputs, while the private `.env` stays excluded.

The capability now calls `ctx.ai.decide()` through core 0.7.3+ (0.8.0-beta.6+), and the smoke suite
checks that both inference calls produce tenant-scoped `decide` cost records.
Laya-backed calls retain unknown cost as `null`; the returned `costs` array exposes
the actual model and token usage without requiring a hosted TypeSafe account.

Framework tests are resource-bounded: `pnpm test` runs at most two package tasks
with two Vitest workers each; Laya uses one worker and serial test files. Its
Python tests use fake backends and never load the real model. Live inference
remains an explicit example command.
