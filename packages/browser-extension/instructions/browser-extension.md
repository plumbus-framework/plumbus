# Browser extension scaffold

Use `plumbus browser-extension scaffold` to generate a WXT-based Chrome/Firefox extension that calls your Plumbus API with bearer tokens.

## Prerequisites (app-owned — not provided by Plumbus core)

Plumbus core registers only `/health`, `/ready`, and capability routes. It does **not** provide `/api/auth/*` or CORS.

1. **Auth endpoints** — Point `--api-base-url` at the host that serves:
   - `POST /api/auth/login` → `{ "token": "...", "user": { ... } }` (only `token` is required)
   - `POST /api/auth/refresh` with `Authorization: Bearer <token>` (optional; if absent, 401 clears local auth)
   - `POST /api/auth/logout` (best-effort)

   Apps already serving these routes for `@plumbus/ui` Next.js frontends can reuse them unchanged.

2. **CORS** — The API host must allow the extension origin.

   Development (permissive, dev-only):

   ```ts
   await app.register(cors, {
     origin: (origin, cb) => {
       if (!origin) return cb(null, false);
       const isLocalWeb =
         origin === 'http://localhost:3000' ||
         origin === 'http://localhost:5173';
       const isDevExtension =
         origin.startsWith('chrome-extension://') ||
         origin.startsWith('moz-extension://');
       cb(null, isLocalWeb || isDevExtension);
     },
     allowedHeaders: ['Content-Type', 'Authorization'],
     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
   });
   ```

   Production — use an allowlist of published extension origins. **Do not** use permissive extension-origin CORS in production.

3. **Access policies** — Capabilities invoked from the extension need policies that admit authenticated JWT callers (deny-by-default applies).

4. **Token storage** — The scaffold stores the access token in `browser.storage.local`, which is **not encrypted** (readable via the browser profile/devtools). This is standard for bearer-token extensions.

## Build and run

```bash
cd extension
pnpm install
pnpm dev:chrome    # or pnpm dev:firefox
```

Load the unpacked build from `.output/` (WXT prints the path).

**Firefox note:** WXT builds Firefox with Manifest V2. The generated `wxt.config.ts` branches on `manifestVersion` so the API origin is granted via `permissions` on MV2 and `host_permissions` on MV3 — WXT does not translate between them.

## Architecture

- **Popup** — login `fetch` to `${apiBaseUrl}/api/auth/login`, writes token to storage.
- **Background** — routes capability calls; attaches `Authorization`; explicit capability registry; on `401`, calls `refreshAuth()` once (concurrent callers share the same in-flight refresh).
- **Content scripts** — call capabilities via `invoke()` only; never read the token directly.

Re-run `plumbus browser-extension scaffold` after capability changes to refresh `src/client/api.ts`.
