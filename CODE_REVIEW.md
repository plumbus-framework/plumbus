# Plumbus Code Review

Consolidated security and code-quality findings across `packages/plumbus-core/src/` and `packages/ui/src/` (158 source files).

## Critical — fix before next release

### C1. Arbitrary code execution via `new Function(...)` in flow conditions
[start.ts:261-269](packages/plumbus-core/src/cli/commands/start.ts#L261-L269) and [dev.ts:307-315](packages/plumbus-core/src/cli/commands/dev.ts#L307-L315)

```ts
const fn = new Function('state', `return Boolean(${expression})`);
return fn(stateObj);
```

The flow engine evaluates step conditions by string-concatenating an `expression` straight into `new Function`. Anything that can land a string into a flow's condition field — DB compromise, untrusted flow loader, supply chain — runs arbitrary JS inside the worker (full DB + AI provider creds + `process` access). The `catch { return false }` only hides syntax errors, not side effects.

**Fix:** swap for a sandboxed expression evaluator (`expr-eval`, `jexl`, or write a tiny recursive descent for the documented subset). Never concatenate into `Function`/`eval`.

### C2. Authorization bypass via `auth.internal` flag
[execution/authorization.ts:43-46](packages/plumbus-core/src/execution/authorization.ts#L43-L46)

```ts
if (auth.internal) {
  return { allowed: true };
}
```

A single boolean on the auth context skips every role, scope, and tenant-scope check below it. Set anywhere upstream (flow engine setter, persisted flow state, a future bug that reflects user input into `auth`), it's god-mode. The check also runs **after** `tenantScoped && !auth.tenantId` returns deny — so an internal call without `tenantId` is fine, but the inversion means it's easy to misread which check wins.

**Fix:** replace the flag with an explicit `system` role, then make policies opt into accepting that role. Never let a single boolean stand between an actor and full data access.

### C3. Shallow `Object.freeze` on every `define*()` output
[defineCapability.ts:77](packages/plumbus-core/src/define/defineCapability.ts#L77), [defineFlow.ts](packages/plumbus-core/src/define/defineFlow.ts), [defineEntity.ts](packages/plumbus-core/src/define/defineEntity.ts), [defineEvent.ts](packages/plumbus-core/src/define/defineEvent.ts), [definePrompt.ts](packages/plumbus-core/src/define/definePrompt.ts), [defineTranslation.ts](packages/plumbus-core/src/define/defineTranslation.ts)

`Object.freeze({ ...config })` freezes one level. `capability.effects.data.push('users:write')` succeeds at runtime, as does mutating nested `access.roles`, `audit.includeInput`, prompt examples, etc. CLAUDE.md explicitly promises *deeply frozen* — this is a contract violation that breaks the entire "contract-driven, immutable definitions" claim.

**Fix:** add a `deepFreeze()` helper to `src/types/` and use it in all six define functions. One implementation, six edits.

### C4. Unfiltered error `metadata` echoed to HTTP responses
[errors/http.ts:36-45](packages/plumbus-core/src/errors/http.ts#L36-L45)

```ts
body: { error: { code, message, metadata: error.metadata } }
```

Any `PlumbusError` thrown deep in the stack gets its full `metadata` object serialized straight to the API client. A capability handler that puts a connection string, SQL fragment, internal IP, or DB row in metadata leaks it. No whitelist, no `NODE_ENV === 'production'` gate.

**Fix:** define a `safeMetadata` whitelist (e.g., `httpStatus`, `retryAfter`, `field`) and only forward whitelisted keys. Log the full metadata server-side with a correlation id.

---

## High

### H1. CLI auto-loads `.env` from CWD before anything else
[bin/plumbus.js:5-7](packages/plumbus-core/bin/plumbus.js#L5-L7)

```js
if (existsSync(".env")) process.loadEnvFile(".env");
```

Run `plumbus` from a directory with a hostile `.env` — even by `cd`-ing into a checkout you don't trust — and it sets `DATABASE_URL`, `AUTH_SECRET`, `AI_*_API_KEY` before any sanity check. There's no "are we inside a Plumbus project?" gate.

**Fix:** require a `plumbus.config.{ts,json}` marker file in CWD before loading `.env`, or only load when an explicit `--env-file` is passed.

### H2. Open-ended AI provider registration from env vars
[config/loader.ts:120,130-146](packages/plumbus-core/src/config/loader.ts#L120-L146)

```ts
const match = /^AI_([A-Z][A-Z0-9_]*)_API_KEY$/.exec(key);
if (match?.[1] != null) providerNames.add(match[1].toLowerCase());
```

Any env-var matching `AI_<X>_API_KEY` registers a provider named `<x>`. Pair with a `AI_<X>_BASE_URL` and the framework will start sending prompts (and tenant data) to an attacker-chosen endpoint. Reachable through any path that controls env: misconfigured CI, container image baking, or H1 above.

**Fix:** keep a hardcoded allowlist of supported provider names (`openai`, `anthropic`, …) and only register those. Reject `baseUrl` values that aren't HTTPS or that resolve to private/link-local ranges if you want to be paranoid.

### H3. Path traversal in `plumbus translation import`
[cli/commands/translation.ts:222-258](packages/plumbus-core/src/cli/commands/translation.ts#L222-L258)

`--file <path>` and `--dir <path>` flow into `resolvePath()` (which is just `path.resolve(cwd, ...)`) and then `fs.readFileSync` / `fs.readdirSync`. No containment check. `plumbus translation import --file ../../../../etc/passwd` reads it, then `parseXliff()` blows up — but the read happened, and the error message echoes the content. Lower bar than H1 because the attacker needs to influence CLI args, but in CI/cron contexts that's plausible.

**Fix:** compute `path.relative(projectRoot, resolved)` and reject if it starts with `..`. Same fix applies to any other CLI command that takes user-supplied paths.

### H4. `validationPassed` is a hardcoded `const true`
[ai/ai-service.ts:379](packages/plumbus-core/src/ai/ai-service.ts#L379)

```ts
const validationPassed = true;
```

Declared as `const`, never reassigned, and ends up in cost/audit records as `validation.passed: true` even when validated generation actually failed and the function fell into the error path. This is straight-up wrong telemetry for the AI cost ledger — exactly the kind of "looks fine" signal you don't want during an incident.

**Fix:** drop the variable and derive `passed` from whether `result` was set / whether retries hit the cap. Then write tests.

### H5. Silently swallowed errors in hook callbacks
[route-generator.ts:114-127](packages/plumbus-core/src/api/route-generator.ts#L114-L127), [server/bootstrap.ts:349](packages/plumbus-core/src/server/bootstrap.ts#L349), [start.ts:332,345](packages/plumbus-core/src/cli/commands/start.ts), [dev.ts:378,391](packages/plumbus-core/src/cli/commands/dev.ts#L378)

A scattering of `.catch(() => {})` after `onCapabilityError`, `onAICostRecorded`, `onFlowError`. The whole point of these hooks is observability — when *they* fail, nobody finds out. Compounds H4: bad telemetry plus invisible telemetry-pipeline failures.

**Fix:** `.catch((err) => logger.warn('hook_error', { hook, error: String(err) }))`. Even a `console.warn` is better than `{}`.

### H6. `bypassTenantScope` derived from a single weak predicate
[api/route-generator.ts:75-76](packages/plumbus-core/src/api/route-generator.ts#L75-L76) and [cli/commands/start.ts:286-292](packages/plumbus-core/src/cli/commands/start.ts#L286-L292)

`const bypassTenantScope = capability.access?.tenantScoped === false;` — a forgotten access policy (`access?` is optional) gives `undefined === false` → `false`, which is *safe by accident*, but the inverse worker path uses `bypassTenantScope: !effectiveAuth.tenantId` which means **any** system-flow run without a tenantId bypasses all tenant scoping in the data layer. No log, no warning, no audit entry.

**Fix:** rename the option to something that fails closed (`requireTenantContext: true` default) and emit an audit event every time scope is bypassed.

---

## Medium

### M1. Raw `throw new Error` throughout define functions and CLI
[defineCapability.ts:55-75](packages/plumbus-core/src/define/defineCapability.ts#L55-L75), [definePrompt.ts:49-58](packages/plumbus-core/src/define/definePrompt.ts), [defineTranslation.ts](packages/plumbus-core/src/define/defineTranslation.ts), [defineFlow.ts](packages/plumbus-core/src/define/defineFlow.ts), [defineEntity.ts](packages/plumbus-core/src/define/defineEntity.ts), [defineEvent.ts](packages/plumbus-core/src/define/defineEvent.ts), [migrate.ts](packages/plumbus-core/src/cli/commands/migrate.ts), [generate.ts](packages/plumbus-core/src/cli/commands/generate.ts), [seed.ts](packages/plumbus-core/src/cli/commands/seed.ts)

CLAUDE.md says "never raw `throw new Error`", but the six core define functions (the framework's public surface!) all use it for validation. Consumers can't catch them by error code; the test harness can't assert on them; tooling can't map them to exit codes.

**Fix:** use `PlumbusError(ErrorCode.Validation, ...)` from [src/errors/](packages/plumbus-core/src/errors/) everywhere.

### M2. Unsigned migration metadata read with `JSON.parse` + cast to `any`
[cli/commands/migrate.ts:149,153,257](packages/plumbus-core/src/cli/commands/migrate.ts#L149)

`prevSnapshot: any = JSON.parse(fs.readFileSync(...))`. Anything that writes to `drizzle/meta/_journal.json` between runs can pivot the migration pipeline. Lower priority than C1 because it requires filesystem write, but worth a Zod schema gate so a corrupted file errors clearly instead of producing weird migrations.

**Fix:** define `SnapshotSchema = z.object({ id: z.string(), prevId: z.string().nullable(), ... })` and `.parse()` after reading.

### M3. Heavy `as any` casts on the database / Drizzle boundary
[start.ts:274,288,320,334](packages/plumbus-core/src/cli/commands/start.ts), [dev.ts:209,253,283,320](packages/plumbus-core/src/cli/commands/dev.ts), [route-generator.ts:76,251-262](packages/plumbus-core/src/api/route-generator.ts), [seed.ts:28,80,90,96](packages/plumbus-core/src/cli/commands/seed.ts), [migrate.ts:669,816](packages/plumbus-core/src/cli/commands/migrate.ts)

Postgres-js + Drizzle generics are noisy, so `db as any` is the convenience escape hatch. Result: the most security-critical edge (DB access) has the weakest type contract. The Zod schema introspection in `route-generator.ts:255-262` (`(field as any)._def?.typeName`) silently breaks on Zod minor versions.

**Fix:** define one `interface DatabaseConnection { db: PostgresJsDatabase; sql: PostgresClient }` in [src/data/types.ts](packages/plumbus-core/src/data/types.ts) and thread it instead of `any`. For Zod, write a tiny helper `getZodTypeName(s: z.ZodTypeAny): string | undefined`.

### M4. Test coverage gaps on AI / RAG and major CLI commands
No `__tests__/` for: [ai/rag/chunking.ts](packages/plumbus-core/src/ai/rag/chunking.ts), [ai/rag/pipeline.ts](packages/plumbus-core/src/ai/rag/pipeline.ts), [ai/rag/schema.ts](packages/plumbus-core/src/ai/rag/schema.ts), [ai/refusal.ts](packages/plumbus-core/src/ai/refusal.ts), [cli/commands/dev.ts](packages/plumbus-core/src/cli/commands/dev.ts), [cli/commands/doctor.ts](packages/plumbus-core/src/cli/commands/doctor.ts), [cli/commands/agent.ts](packages/plumbus-core/src/cli/commands/agent.ts), [cli/commands/certify.ts](packages/plumbus-core/src/cli/commands/certify.ts), [cli/commands/e2e.ts](packages/plumbus-core/src/cli/commands/e2e.ts).

CLAUDE.md is explicit: every change needs tests. The `dev` command in particular wires the flow engine to `new Function` — it's the most critical untested file in the repo.

### M5. SSE error payloads echo raw `Error.message`
[api/route-generator.ts:202-206](packages/plumbus-core/src/api/route-generator.ts#L202)

`reply.raw.write(\`data: ${JSON.stringify({ type: 'error', error: message })}\n\n\`)` — `message` comes from arbitrary thrown errors, including AI-generated text. JSON-encoding stops JSON-level injection, but the message itself may leak stack-trace internals or DB error strings to clients. Same root cause as C4.

### M6. `playwright`, `vitest`, `@vitest/browser` shipped as runtime `dependencies`
[plumbus-core/package.json:65,68](packages/plumbus-core/package.json#L65)

Installing `@plumbus/core` pulls Playwright (~150MB of browsers) into consumer apps that may never run e2e tests. The matching `@plumbus/ui` package correctly puts them in `devDependencies` — that inconsistency means the framework can't decide.

**Fix:** either move to `peerDependencies` (let consumers opt in) or `optionalDependencies` and lazy-import in the test harness.

### M7. CLAUDE.md doc drift
[CLAUDE.md](CLAUDE.md) Consumer Dependency Policy table marks `playwright` and `drizzle-kit` as "provided via dependencies". M6 contradicts that intention — either fix the package.json or fix the doc. Pick one.

---

## Low / hygiene

- **Test fixtures with literal secrets** ([adapter.test.ts:5](packages/plumbus-core/src/auth/__tests__/adapter.test.ts#L5), [scim.test.ts:53](packages/plumbus-core/src/auth/__tests__/scim.test.ts#L53)) — fine for tests, but make sure the `files:` allowlist in [package.json](packages/plumbus-core/package.json) only ships `dist/` (it does — verified). Worth a comment that these strings are placeholder, not example.
- **JWT minimum-secret-length not validated** ([auth/adapter.ts:128-162](packages/plumbus-core/src/auth/adapter.ts#L128-L162)) — verify `secret.length >= 32` at adapter construction; cheap belt-and-suspenders.
- **No `engines` field** on either published package — recommended `"engines": { "node": ">=20.6" }` since `bin/plumbus.js` uses `process.loadEnvFile`.
- **Loose AI provider name regex** ([config/loader.ts:120](packages/plumbus-core/src/config/loader.ts#L120)) — moot if H2 is fixed via allowlist.

---

## Suggested order of operations

1. **C1** (`new Function`) and **C2** (`auth.internal`) — these are the only "remote-code-execution-class" issues. One PR each.
2. **C3** (deepFreeze) + **M1** (structured errors in `define*()`) — same files, do together.
3. **C4** / **M5** / **H4** / **H5** (error and telemetry hygiene) — one PR, mostly mechanical.
4. **H1** / **H2** / **H3** (CLI hardening) — single CLI-safety pass.
5. **H6** + **M2** + **M3** (data-layer typing and tenant scoping) — larger refactor; queue last.
