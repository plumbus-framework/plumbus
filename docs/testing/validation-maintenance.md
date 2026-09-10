# Framework validation maintenance

The framework-wide gate repair removes unchecked non-null assertions without weakening lint
rules or skipping behavior tests. Required approval timestamps have non-null overloads; nullable
resolved timestamps still return undefined. Durable record mapping explicitly refuses absent
required timestamps and missing outbox readback with structured internal errors.

Compiled-registry latest-version lookup checks the final entry directly. Compensation filtering
narrows the compensation capability name before invocation. Credential secret lookup checks
ownership and presence before returning a value, retaining the existing not-found refusal.

The crash-matrix simulator returns the acceptance result from its transaction rather than relying
on an outer possibly-unassigned variable, rejects a missing first step before writing state, and
collects optional wake times without assertions. Test fixtures assert required resources explicitly,
so absent approvals/claims/output paths fail the test instead of skipping the intended operation.

Existing formatting drift is corrected with Biome across core, UI and MCP. Formatting and
type-only import cleanup do not change generated string contents or application behavior.
Full lint, formatting, typechecking and package tests remain required; no rules are disabled.

See [execution lifecycle](../architecture/execution-lifecycle.md),
[request admission](../security/request-admission.md), and
[data layer](../sdk-reference/data-layer.md).
