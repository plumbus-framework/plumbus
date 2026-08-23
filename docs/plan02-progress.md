# Plan 02 progress — 2026-08-21 (session 19)

**Repo:** `/home/marik/Projects/Plumbus` (branch `plumbus-next`)  
**Git:** source and docs only. No `add` / `commit`.  
**Earlier stages:** not reopened. Extra process-kill chaos stays skipped on this host.

## What this session added

Host-declared credential catalog. The host names types and field shapes; the catalog stores opaque bindings (name + ref + public labels); the host resolver supplies values at `reveal`. Secret fields are not on `fields`, not in JSON/`inspect`, and not in catalog errors. No built-in types, no IAM minting.

- `createMemoryCredentialCatalog({ types, resolve? })`
- `createPlumbusRuntime({ credentials })` pass-through
- `createServer({ credentials })` optional field; `loadServerExtensions` copies `export const credentials` from `app/server.ts`
- Docs: `docs/sdk-reference/credential-catalog.md`

Compiled-flow disk reload (2026-08-23). `loadCompiledFlowRegistryFromDirectory` digest-checks `plumbus compile-flows` JSON. `createServer` / `createWorkerPool` load `{cwd}/.plumbus/compiled-flows` when that tree has JSON.

## Still missing in this repo

- Process-kill chaos (skipped on this host).
- Broader toolchain beyond generate fidelity (corpus SDK pipeline, UI generate shell). Per-tenant migrate is in: `applyDataPlaneMigrations` + `plumbus migrate apply --database` (see `docs/sdk-reference/tenant-data-planes.md`).
- Filesystem governed artifact store exists but is not auto-wired on `createServer` (no single artifacts hook; pass it to `createPlumbusRuntime({ artifacts })`).
