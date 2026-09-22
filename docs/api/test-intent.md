# Test Intent

Partners integrate against your API without triggering real side effects by sending explicit **test intent** headers. The runtime validates auth, scopes, and input — then either stops (`validate-only`) or returns a schema-checked fixture (`safe-reply`) — without calling the capability handler.

Test intent is for **partner-facing integration testing**, not a substitute for your own unit tests (`runCapability`) or route tests (`registerApiRoutes` + Fastify inject).

**Previous:** [openapi.md](./openapi.md) · **Next:** [structure-policy.md](./structure-policy.md)

---

## When to enable test intent

Enable test intent when:

- Partners need to verify auth, scope, and request shape against your staging environment.
- You want fixture-based responses that match production output schemas without database writes.
- Sandbox environments should never execute mutating handlers for partner test traffic.

Do **not** enable test intent when:

- The capability is public (`access.public: true`) — this combination is forbidden at validate time and rejected at runtime.
- You need to test handler business logic — use `runCapability()` in Vitest instead.
- Production traffic might accidentally send test headers — keep test enabled only on staging or gate by environment.

---

## Request headers

```http
POST /api/v1/refunds/ref-123/approve
Authorization: Bearer <partner-token>
X-Plumbus-Intent: test
X-Plumbus-Test-Mode: safe-reply
```

| Header | Values | Purpose |
|---|---|---|
| `X-Plumbus-Intent` | `test` | Activates test-intent handling |
| `X-Plumbus-Test-Mode` | `validate-only` or `safe-reply` | Selects mode; falls back to `defaultMode` |

### Query parameter (dev/test only)

When `allowQueryIntent: true` is passed to `registerApiRoutes`, `?intent=test` also activates test intent. Avoid in production — headers are explicit and auditable.

```typescript
registerApiRoutes(app, routeConfig, capabilities, {
  allowQueryIntent: process.env.NODE_ENV !== 'production',
});
```

---

## Modes

### `validate-only`

Runs the full auth → scope → access → tenant guard → Zod parse pipeline. If all checks pass, returns:

```json
{
  "ok": true,
  "intent": "test",
  "mode": "validate-only",
  "data": { "valid": true },
  "test": { "sideEffects": "disabled", "contractVersion": "v1" },
  "meta": { "requestId": "…", "apiVersion": "v1" }
}
```

No handler execution. No database writes. Useful for partners verifying credentials and request shape.

### `safe-reply`

After the same validation pipeline, reads a JSON fixture file, validates it against the capability `output` Zod schema, and returns the fixture data:

```json
{
  "ok": true,
  "intent": "test",
  "mode": "safe-reply",
  "data": { "id": "ref-123", "status": "approved" },
  "test": {
    "sideEffects": "disabled",
    "source": "fixture",
    "scenario": "safe-reply",
    "contractVersion": "v1"
  },
  "meta": { "requestId": "…", "apiVersion": "v1" }
}
```

Mode resolution order:

1. `X-Plumbus-Test-Mode` header if it matches an entry in `test.modes`
2. `test.defaultMode` if configured and allowed
3. First entry in `test.modes`

---

## Configuration

On the capability inline block or manifest entry (manifest overrides inline):

```typescript
api: {
  operationId: 'approveRefund',
  method: 'POST',
  path: '/refunds/{refundId}/approve',
  test: {
    enabled: true,
    modes: ['validate-only', 'safe-reply'],
    defaultMode: 'safe-reply',
    safeReply: { fixture: 'fixtures/refunds/approve-success.json' },
  },
},
```

```yaml
# api.yaml override example
expose:
  - capability: billing.approveRefund
    operationId: approveRefund
    method: POST
    path: /refunds/{refundId}/approve
    test:
      enabled: true
      modes: [validate-only, safe-reply]
      defaultMode: safe-reply
      safeReply:
        fixture: fixtures/refunds/approve-success.json
```

`plumbus api validate` and `plumbus api test-fixtures validate` check the **resolved** exposure (manifest `test` overrides inline `api.test`).

---

## Fixture file rules

Fixtures are JSON files validated against the capability `output` schema.

### Path containment

Fixture paths must be:

- **Relative** to the application root (no absolute paths)
- **Contained** within `appRoot` — `../` escapes are rejected

```typescript
// registerApiRoutes opts
{ appRoot: process.cwd() }
```

| Path | Result |
|---|---|
| `fixtures/refunds/ok.json` | Allowed |
| `/etc/passwd` | Rejected (absolute) |
| `../../outside.json` | Rejected (escape) |

Validation runs at `plumbus api test-fixtures validate` time and again at runtime when serving `safe-reply`.

### Partner-facing errors

Fixture file paths are **never** echoed in partner error responses. Read failures return generic messages (`Test fixture not found`, `Failed to read test fixture`). Schema mismatches return `500 internal_error` with a generic message — fix fixtures in CI, not in production.

### Example fixture

`fixtures/refunds/approve-success.json`:

```json
{
  "id": "ref-123",
  "status": "approved",
  "approvedAt": "2026-06-09T12:00:00.000Z"
}
```

Must parse and pass `cap.output.safeParse()`.

---

## Runtime rules

The test-intent branch runs **after** auth, tenant guard, scope check, access evaluation, and input parsing — but **before** idempotency and handler execution.

| Rule | Behavior |
|---|---|
| Authentication required | Anonymous requests (`!ctx.auth.userId`) → `401 unauthenticated` |
| Scopes and access | Normal checks apply after authentication |
| Public + test enabled | `400 test_intent_not_supported` at runtime; `policy.public-test-forbidden` at validate time |
| Test not enabled on endpoint | `400 test_intent_not_supported` |
| No resolvable mode | `400 test_intent_not_supported` with `No test mode configured` |
| Audit | `api.{operationId}.test` audit event with mode and requestId |

---

## Validation commands

```bash
# Full contract including test config on resolved exposures
plumbus api validate

# Fixture files only — schema + path containment (uses default ./api.yaml)
plumbus api test-fixtures validate
plumbus api test-fixtures validate --json
```

### Fixture finding codes

| Code | Cause | Remediation |
|---|---|---|
| `test.fixture-path-escape` | Fixture path resolves outside `appRoot` | Use a relative path under the app root |
| `test.fixture-schema-mismatch` | Fixture JSON does not match capability output schema | Fix the fixture or update the output schema |
| `test.fixture-read-failed` | Fixture file missing or unreadable | Create the file or fix the path in manifest/capability `test.safeReply.fixture` |

---

## Partner vs internal testing

| Approach | Use for |
|---|---|
| Test intent (`X-Plumbus-Intent: test`) | Partner sandbox integration against your staging API |
| `runCapability()` + `createTestContext()` | Unit tests for handler business logic |
| Fastify `inject()` + `registerApiRoutes` | HTTP envelope, scope, and idempotency integration tests |
| `plumbus api test-fixtures validate` | CI gate that fixtures match schemas before deploy |

Partners should use test intent on staging. Your team should not rely on it for correctness — keep Vitest coverage on handlers and access policies.

---

## Related topics

- [exposure-model.md](./exposure-model.md) — where `test` fits in the `api` block
- [manifest.md](./manifest.md) — manifest overrides for test config
- [structure-policy.md](./structure-policy.md) — `policy.public-test-forbidden`
- [governance.md](./governance.md) — advisory rules for public mutations
