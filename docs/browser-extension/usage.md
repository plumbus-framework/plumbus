# Browser extension usage

## Prerequisites (app-owned)

Plumbus core registers `/health`, `/ready`, and capability routes only. Your API host must also provide:

1. **Auth routes** — at minimum `POST /api/auth/login` → `{ token, user? }`. Optional `POST /api/auth/refresh` and `POST /api/auth/logout` (same contract as `@plumbus/ui` Next.js apps).
2. **CORS** — allow the extension origin (`chrome-extension://…` or `moz-extension://…`). Use an allowlist in production.
3. **Access policies** — capabilities invoked from the extension must admit authenticated JWT callers (deny-by-default).

Full auth/CORS examples: [`packages/browser-extension/instructions/browser-extension.md`](../../packages/browser-extension/instructions/browser-extension.md).

## Scaffold

From your Plumbus app root:

```bash
plumbus browser-extension scaffold ./extension \
  --app-name my-app \
  --api-base-url https://api.example.com
```

| Option | Default | Description |
|--------|---------|-------------|
| `output-dir` (positional) | `extension` | Output directory (must not be repo root unless `--force`) |
| `--app-name <name>` | nearest `package.json` name | Extension display name |
| `--api-base-url <url>` | — | **Required.** Absolute `http:`/`https:` API base |
| `--browser <target>` | `both` | `chrome`, `firefox`, or `both` — controls emitted scripts |
| `--force` | `false` | Overwrite hand-editable shell files; also permits scaffolding into repo root |
| `--json` | `false` | Machine-readable result on stdout |

### Generated artifacts

- `extension/` — WXT project (popup, background, content script, auth store, typed client)
- `.plumbus/generated/browser-extension/src/client/api.ts` — cached copy of the generated typed client (same content as `extension/src/client/api.ts`)

Re-run scaffold after capability changes. `src/client/api.ts` is **always** regenerated; other shell files are skipped unless `--force`.

## Build and load

```bash
cd extension
pnpm install
pnpm dev:chrome    # or pnpm dev:firefox
```

Load the unpacked build from `.output/` (WXT prints the path).

## Architecture

```
popup login ──fetch──▶ ${apiBaseUrl}/api/auth/login
     │  token                      │
     └────────────────────────────▶ browser.storage.local
                                           ▲
popup / content ─invoke(key,input)─▶ background service worker
                                           │  Authorization: Bearer …
                                           │  explicit capability registry
                                           ▼
                               ${apiBaseUrl}/api/<domain>/<capability>
```

Content scripts call `invoke()` only — they never read the token directly.

## Programmatic API

For custom tooling (mirroring the CLI):

```ts
import {
  generateBrowserExtensionScaffold,
  selectSampleCapability,
  hostPermission,
  apiOrigin,
  assertValidAppName,
  assertValidClientExportName,
} from '@plumbus/browser-extension';
```

See the [package README public API table](../../packages/browser-extension/README.md#public-api).

## Related

- [README.md](./README.md) — index
- [CLI reference](../cli/commands.md#plumbus-browser-extension-scaffold)
