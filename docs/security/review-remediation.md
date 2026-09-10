# Security review remediation

This records the resolution of `general-desc/security-review`, using its re-triage to distinguish defects from documented application responsibilities. The original review is retained unchanged.

## Implemented changes

| Finding | Resolution |
|---|---|
| C1 | MCP respects environment settings, validates credentials before acquiring resources, and never authenticates against a development placeholder. |
| C2 | Each execution context binds AI tenant and actor. Vector search and the retrieval pipeline independently enforce exact tenant namespaces; a missing tenant searches only unscoped documents. Flow AI calls use the stored caller identity. |
| C3 | Successful generation, streaming, fallback, extraction, and classification record provider/catalog costs. Unknown prior spend blocks configured dollar caps. Request attempts supply token estimates. Free providers can report zero; unpriced local providers work without dollar caps. Streams/embeddings without accounting data stay unknown. |
| C4 | Scaffold names and provider/compliance identifiers are validated before rendering/writing, including translation templates and monorepo creation. |
| H1, transport portion | MCP HTTP transport authenticates before SDK dispatch; explicit invalid credentials cannot fall back to an environment token. Public discovery remains separately configurable. |
| H3 | Configuration no longer supplies a shared development JWT key. JWT adapters reject short/padded and known placeholder keys in every environment. Development without credentials is anonymous. |
| H4 | Chat instructions occupy the system role; retrieved content, summaries, and staged tool output use untrusted-data envelopes. Template substitution is single-pass and context items are bounded. |
| H5 | Voice has plugin/message/pending-input limits and sequential delivery; the duplicate audio listener is removed. Missing session budgets warn, and invalid numeric budgets/usage fail validation. |
| M2 | MCP capability and task failures use safe error envelopes instead of raw exceptions/metadata. Detailed diagnostics stay server-side. |
| M3 | Core and partner-API denial envelopes no longer disclose required roles/scopes. |
| M4 | Missing, malformed, or inconsistent flow snapshots fail before step execution. Worker privileges are never the fallback. New snapshots omit session identifiers and authentication timestamps. |
| M5, error-handler portion | Safe Fastify error handling is unconditional; observability hooks are optional and isolated. |
| M6, JWKS portion | Concurrent JWKS refreshes share one request; unknown-key floods share a refresh cooldown, and fetches have timeouts. |
| M7 | SAML subject confirmation binds recipient and request ID, validity windows are finite/strict, and assertion IDs are consumed once. Unsolicited/bearer mode requires explicit opt-in. |
| M8 | JWT expiration is required, nbf/iat and maximum lifetime are checked, and signing rejects reserved additional claims. Issuer/audience checks remain configurable; configure them for multiple token purposes and isolate signing keys across applications. |
| M9 | Extract/classify apply configured input security; explainability records redacted inputs. Nested classified objects no longer recurse into an already-redacted value. |
| M10 | Accounting rejects invalid numeric usage and budget values, preserves unknown versus zero cost, retains small positive costs, rejects invalid Bedrock rates, and correctly retains/counts Anthropic input/cache usage. |
| M11 | Audit writes retry with stable IDs and database deduplication. Permanent failures propagate instead of returning ordinary capability success. Outcomes are validated and framework outcomes cannot be overwritten by extra metadata. Missing audit wiring fails explicitly. Opt-outs, post-commit limitations, and integrity assumptions are documented. |
| M12 | Task input/access is checked before task creation or dispatch. Worker completion recreates tenant-bound repositories. Tenantless task storage is separated from handler data access, with owner/tenant checks on task operations. |
| M13, export/runtime portion | Query API-key schemes are flagged by manifest validation and rejected by OpenAPI export because the runtime does not read them. |
| L1, parser portion | Duplicate cookie names are discarded rather than resolved using an ambiguous first/last winner. |
| L2 | Generated paths are contained in their output directory; existing symlinks are rejected. Protected scaffold creation uses exclusive file creation. Translation/MCP filename segments are validated. |
| L3, hardening | Explicit voice token secrets are length-checked, and handshake token lifetimes are bounded to 1–300 seconds. |
| L6, envelope hardening | Redis envelopes are schema-validated before subscriber dispatch; malformed envelopes are discarded with a diagnostic. |
| L7, hardening | Default LiveKit rooms include tenant identity. Explicit shared rooms remain app-owned policy. Reference synthesis participates in the configured AI budget/ledger, including failed attempts; deployments without a ledger remain supported. |
| L8, timeout portion | Billing/usage API calls have a bounded timeout so synchronization cannot hang indefinitely. |

## Findings that do not require a security patch

**L4 is not reproduced as a vulnerable dependency.** The lockfile has xmldom 0.8.13 and 0.9.10, both patched versions for the cited classes of issues. Core directly parses SAML using 0.9.10; xml-crypto's separate 0.8.13 is the patched LTS line. The upstream advisories list the fixed versions: [recursive serialization DoS](https://github.com/xmldom/xmldom/security/advisories/GHSA-2v35-w6hq-6mfw), [CDATA serialization](https://github.com/xmldom/xmldom/security/advisories/GHSA-wh4c-j3r5-mjhp), and [processing-instruction serialization](https://github.com/xmldom/xmldom/security/advisories/GHSA-x6wf-f3px-wcqx). No unsupported major override was introduced.

The review's reclassified features are retained: explicit cross-tenant capability policies (H2), client-authoritative ephemeral chat history (M1), app/edge rate limiting (M6), optional metrics/public health (M5), environment-selected cookie flags (L1), operator-owned prompt discovery (L5), explicit shared voice rooms (L7), and advisory partner-API governance (M13). The chat bootstrap path checks exact Origin before its CSRF-token bootstrap exception, so the claimed same-site-subdomain bypass does not follow from that branch. The dev banner cited by L8 does not print a DB password.

## Compatibility and operating boundaries

- Configure an explicit JWT secret for authenticated development; old placeholder-signed and non-expiring tokens are rejected. HTTP MCP requires explicit credentials. CLI agent-map file loading was already absent; the docs now distinguish environment-based CLI JWT authentication from application-owned opaque-token wiring.
- Restart legacy flows from a verified caller context after reviewing prior effects; do not invent worker/system snapshots to revive them.
- SAML callbacks now supply an outstanding request ID. Keep the adapter long-lived and consume the login transaction. Multi-process/restart-safe assertion consumption needs an atomic shared replay store or SAML broker; the synchronous callback contract and explicit unsolicited opt-in are documented.
- Unknown cost is not proof of free usage. Explicit zero costs are supported, including in a configured budget. Without dollar caps, unpriced/local providers remain usable. Budgets remain process-local pre-checks, not cross-worker atomic reservations; token estimates are approximate.
- Field-classification redaction is not arbitrary free-text PII detection. Untrusted-data envelopes help prompt hygiene; capability authorization remains the enforcement point.
- Audit retry/error handling is not a cryptographic integrity guarantee or a rollback of already-committed/external effects. Explicit audit opt-outs and isolated post-commit callback behavior remain documented. Use a transactional/durable audit sink and restricted append-only permissions when stronger guarantees are required.
- Split voice input into messages within the documented limits. Handshake token expiry is separate from established-session duration. Explicit shared rooms still need application authorization.
- Generated writes assume an operator-controlled project tree; portable Node APIs cannot prevent every concurrent hostile parent-directory replacement.

## Validation

All four required checks passed on the final source changes: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`. The standard test run completed successfully across all 18 packages, including 2,144 core tests. Opt-in live-provider/database tests retain their existing skip requirements. Turborepo still prints the pre-existing workspace dependency-cycle warning; Biome lint and format checks are clean.
