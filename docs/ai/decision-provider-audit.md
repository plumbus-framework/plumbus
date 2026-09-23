# Decision provider adversarial audit

This audit covers **58 new scenarios**: 20 shared, 16 TypeSafe, and 22 Laya.
Tests were first run against the existing implementation. **34 scenarios failed
initially** (14 shared, 5 TypeSafe, 15 Laya); 24 already passed. These expose defects
or missing boundary checks, not necessarily 34 independent root causes. All
scenarios now have passing regression coverage.

At the end of this first audit, the packages had 103 TypeScript tests. One invoked 30
additional Python service tests. HTTP tests use real local sockets; Laya end-to-end
tests launch the actual Python HTTP handler with a fake inference backend. No
credentials, live inference, model downloads or GPUs are needed.

This document retains the first run's results.

## Research

- [TypeSafe API](https://docs.typesafe.ai/api): question/answer contracts,
  ordinal levels, usage and HTTP failures.
- [TypeSafe models](https://docs.typesafe.ai/models): response model identity,
  moving aliases, input-only pricing and context limits.
- [TypeSafe retry configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy):
  rate limits and overload handling. Our documented retry policy remains bounded
  and deliberately avoids retries after uncertain network delivery.
- [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): correctness,
  adversarial content and calibration require task evaluation with real models.
- [Laya sequence construction](https://github.com/NandhaKishorM/laya/blob/main/laya/common.py):
  instruction/option/state budgets and output rounding.
- [Laya issue #95](https://github.com/NandhaKishorM/laya/issues/95): reported concurrent
  model loading, now closed upstream. It motivated tests of our own lock/preload
  boundary; we do not claim the current upstream version still has that bug.
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html): framing, content metadata,
  authentication and Retry-After.
- [Python JSON interoperability](https://docs.python.org/3/library/json.html#standard-compliance-and-interoperability):
  duplicate names, non-finite values and Unicode require explicit boundary choices.

Checked 2026-09-22. The scenarios are local engineering hypotheses informed by
these sources, not reports of observed provider outages or model accuracy failures.
Tests enforce our chosen contracts, including strict rejection of duplicate JSON.

## @plumbus/ai-decision

Tests: [audit.test.ts](../../packages/ai-decision/src/__tests__/audit.test.ts). IDs appear in test names. **All rows pass after fixes.**

| ID | Potential issue / expected behavior | First run | Test level |
| --- | --- | --- | --- |
| S01 | Fake AbortSignal escapes request validation | Failed → fixed | Unit |
| S02 | A __proto__ JSON field silently disappears during schema parsing | Failed → fixed | Unit |
| S03 | Inherited toString is accepted as an unoffered choice label | Failed → fixed | Unit |
| S04 | Ordinal score contradicts its probability distribution | Failed → fixed | Unit |
| S05 | Malformed answer container discards valid billed usage | Failed → fixed | Unit |
| S06 | Whitespace-only response model is accepted | Failed → fixed | Unit |
| S07 | Individually safe token counts overflow when summed | Already passed | Unit |
| S08 | Invalid UTF-8 becomes replacement characters inside JSON | Failed → fixed | Transport |
| S09 | Injected fetch ignoring AbortSignal defeats the deadline | Failed → fixed | Transport |
| S10 | Response-body cleanup failure hides the original HTTP status | Failed → fixed | Transport |
| S11 | Negative Retry-After causes immediate retries | Failed → fixed | Transport |
| S12 | Repeated trailing slashes corrupt a reverse-proxy endpoint path | Failed → fixed | Transport |
| S13 | Class instances contribute inherited fields to JSON state | Failed → fixed | Unit |
| S14 | Null-prototype records must remain supported | Already passed | Unit |
| S15 | Sparse array holes must not silently become JSON nulls | Already passed | Unit |
| S16 | Cyclic low-level payload is mislabeled as a network failure | Failed → fixed | Transport |
| S17 | Invalid fetch injection is accepted at configuration time | Failed → fixed | Unit |
| S18 | Request limit must count UTF-8 bytes, not JS characters | Already passed | Transport |
| S19 | Compressed responses must obey the decompressed byte limit | Already passed | Real HTTP + gzip |
| S20 | Tied choices and zero confidence must remain valid | Already passed | Unit |

## @plumbus/ai-decision-typesafe

Tests: [audit.test.ts](../../packages/ai-decision-typesafe/src/__tests__/audit.test.ts). IDs appear in test names. **All rows pass after fixes.**

| ID | Potential issue / expected behavior | First run | Test level |
| --- | --- | --- | --- |
| T01 | Whitespace-corrupted API keys are silently changed | Failed → fixed | Configuration |
| T02 | Non-ASCII API key reaches HTTP instead of failing configuration | Failed → fixed | Configuration |
| T03 | Explicit null endpoint silently selects the production default | Failed → fixed | Configuration |
| T04 | Large finite pricing overflows intermediate multiplication | Failed → fixed | Unit |
| T05 | Unrepresentable final price loses known billed model/usage | Failed → fixed | Unit |
| T06 | Structured instructions and true/false criteria survive mapping | Already passed | Wire contract |
| T07 | 255 choice labels work; 256 fails before network I/O | Already passed | Boundary |
| T08 | Ten score levels work; eleven fails before network I/O | Already passed | Boundary |
| T09 | Caller mutation of rates cannot change an existing client | Already passed | Unit |
| T10 | Zero probability stays zero, with no invented confidence | Already passed | Unit |
| T11 | Model names cannot select inherited pricing properties | Already passed | Unit |
| T12 | Concurrent clients keep distinct bearer credentials | Already passed | Real HTTP |
| T13 | HTTP 529 recovery resends an identical request body | Already passed | Real HTTP |
| T14 | Redirects cannot forward the bearer key | Already passed | Two HTTP servers |
| T15 | HTTP 422 is not retried and cannot leak submitted text | Already passed | Real HTTP |
| T16 | Per-call deadline overrides a longer adapter deadline | Already passed | Real HTTP stream |

## @plumbus/ai-decision-laya

Tests: [test_audit.py](../../packages/ai-decision-laya/service/test_audit.py) and [audit-e2e.test.ts](../../packages/ai-decision-laya/src/__tests__/audit-e2e.test.ts). IDs appear in test names. **All rows pass after fixes.**

| ID | Potential issue / expected behavior | First run | Test level |
| --- | --- | --- | --- |
| L01 | JSON 1e999 becomes infinity and reaches inference | Failed → fixed | Real service HTTP |
| L02 | Duplicate JSON fields silently select the last value | Failed → fixed | Real service HTTP |
| L03 | Duplicate Content-Length creates framing ambiguity | Failed → fixed | Raw HTTP headers |
| L04 | Duplicate Authorization selects one credential | Failed → fixed | Raw HTTP headers |
| L05 | Truncated HTTP body is accepted when its prefix is valid JSON | Failed → fixed | Half-closed socket |
| L06 | Unsupported Content-Encoding is ignored | Failed → fixed | Real service HTTP |
| L07 | Non-JSON Content-Type is accepted | Failed → fixed | Real service HTTP |
| L08 | UTF-16 is accepted despite a UTF-8 JSON protocol | Failed → fixed | Real service HTTP |
| L09 | Inference ValueError is incorrectly returned as caller error 422 | Failed → fixed | Real service HTTP |
| L10 | Non-finite output is incorrectly reported as a request error | Failed → fixed | Real service HTTP |
| L11 | Service emits responses exceeding the adapter size limit | Failed → fixed | Real service HTTP |
| L12 | Unpaired Unicode surrogate reaches inference | Failed → fixed | Real service HTTP |
| L13 | Non-ASCII service key cannot be consistently represented as bearer auth | Failed → fixed | Configuration |
| L14 | Hebrew and emoji survive byte-counted framing | Already passed | Real service HTTP |
| L15 | Routing cannot load a checkpoint outside the preload list | Already passed | Backend unit |
| L16 | Inference failure releases the device lock | Already passed | Backend unit |
| L17 | Concurrent calls cannot load/run the same device twice | Already passed | Threaded backend |
| L18 | Exact token budget succeeds; one extra token fails | Already passed | Tokenizer fixture |
| L19 | Blank model/language selectors fail before inference | Failed → fixed | Unit |
| L20 | Invalid checkpoint selection becomes a safe client error | Failed → fixed | Backend unit |
| L21 | All primitives cross Node → HTTP → Python → Node | Already passed | End to end, fake model |
| L22 | Wrong service key fails once without inference | Already passed | End to end, fake model |

## Changes and interpretation

Shared validation now checks plain records before Zod cloning, verifies chosen
labels are own properties, checks ordinal expectations with rounding tolerance,
and retains valid billing metadata on malformed answers. HTTP handling uses fatal
UTF-8 decoding, structured serialization/configuration errors, owned deadlines
that race I/O and clear their timers, and best-effort cleanup.

TypeSafe rates are unchanged. Cost calculation divides tokens by a million before
scaling to avoid intermediate overflow. USD values remain floating-point estimates;
an existing exact-float test now verifies the price to 12 decimal places. Non-finite
final prices retain model/usage in the structured error.

The Laya service separates request parsing, routing rejection, inference failure
and output serialization. It enforces one framing length/credential, UTF-8 JSON
without duplicate keys/non-finite numbers/invalid surrogates, 64-level nesting,
supported content metadata and a 2 MiB response ceiling. Model/runtime failures
return 500; invalid routing selections remain client errors.

## Reproducing

From the repository root:

```bash
pnpm --filter '@plumbus/ai-decision*' build
pnpm --filter '@plumbus/ai-decision*' test
python3 -B -m unittest discover -s packages/ai-decision-laya/service -p 'test_*.py' -v
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

Python is required for Laya service tests. Test source files also compile during
package typechecking. The only model behavior in offline tests is deliberately
synthetic; no live confidence thresholds or guaranteed classifications are asserted.

## Remaining live checks

These tests cannot establish Jev account access, undocumented response variations,
actual tokenizer/context limits, Laya checkpoint compatibility, CUDA/CPU resource
requirements, multilingual accuracy, calibration or production throughput. Those
remain live checks once the [test environment](decision-providers.md#providing-a-live-test-environment)
is available. Core runtime integration and framework security policies are unchanged.
