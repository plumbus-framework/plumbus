# Deployment

Plumbus applications deploy as up to three services — a **backend** (Fastify API server), a **frontend** (Next.js), and optionally an **admin dashboard** (Next.js) — backed by PostgreSQL and Redis.

## Service Topology

```
+-----------+     +-----------+     +-----------+
| frontend  |     |   admin   |     |  backend  |
| Next.js   |     | Next.js   |     | Fastify   |
| :3001     |---->| :3002     |---->| :3000     |
+-----------+     +-----------+     +-----+-----+
                                          |
                                    +-----+-----+
                                    |           |
                                +---v---+  +----v--+
                                |  PG   |  | Redis |
                                | :5432 |  | :6379 |
                                +-------+  +-------+
```

- **Frontend** and **admin** proxy API calls to the backend server-side. Browsers never connect directly to the backend.
- **Backend** connects to PostgreSQL (data) and Redis (job queue, event dispatch).

---

## Docker Rules — MUST follow all of these

These rules are critical. Violating any one causes build failures or bloated images.

### Rule 1: Generate `.plumbus/` inside Docker

- **DO**: Run `plumbus generate` in a Docker build stage.
- **DO NOT**: Copy `.plumbus/` from the host. It may not exist in CI/fresh clones.

### Rule 2: Always copy `.npmrc` into Docker images

- **DO**: `COPY .npmrc ./` before `pnpm install`.
- **DO NOT**: Skip `.npmrc`. It has `public-hoist-pattern` entries required for `next build` to find `next`, `react`, `tailwindcss`.
- **Symptom if violated**: `Cannot find module 'next'` during build.

### Rule 3: Never copy `pnpm-workspace.yaml` with local dev overrides

- **DO**: Copy the clean `pnpm-workspace.yaml` (lists only `frontend` and `frontend-admin`).
- **DO NOT**: Copy a workspace yaml that contains `link:../Plumbus/...` dev overrides.
- **TIP**: If your project uses `dev:link`/`dev:unlink` scripts to swap workspace configs, make sure the clean version is active before building Docker images.

### Rule 4: Use `FROM deps AS build` (preserve pnpm symlinks in build stage)

- **DO**: `FROM deps AS build` — inherits the filesystem with intact symlinks.
- **DO NOT**: `FROM base AS build` with `COPY --from=deps /app/node_modules ./node_modules`. Docker COPY breaks pnpm symlinks.

### Rule 5: Use `pnpm deploy` to isolate frontend dependencies

- **DO**: Run `pnpm --filter {./frontend} deploy --legacy /app/deployed` to create a self-contained directory with flat `node_modules` containing ONLY the frontend's dependencies.
- **DO NOT**: Build Next.js from the workspace root with all monorepo dependencies visible. pnpm's symlinked store breaks Next.js file tracing, and hoisted layout includes every workspace package.
- **Why**: `pnpm deploy` creates isolated flat `node_modules` with just the target package's deps. Next.js standalone traces only what the frontend actually needs (~30-40 MB vs ~600+ MB).

### Rule 6: Never copy full `node_modules` into frontend runner stages

- **DO**: Copy ONLY `.next/standalone` and `.next/static` into the runner.
- **DO NOT**: `COPY --from=deps /app/node_modules ./node_modules` in the runner stage.
- **Why**: Standalone output already includes all traced modules (~60-80 MB). Copying full `node_modules` adds ~700 MB for no reason.
- **Target image size**: Frontend/admin images should be ~150-200 MB total, not 800 MB+.

### Rule 7: Strip frontend-only packages from backend prod deps

- **DO**: Create a separate `proddeps` stage that removes `@plumbus/ui` from `package.json` before `npm install --omit=dev`.
- **DO NOT**: Copy the full `node_modules` (including `@plumbus/ui`) into the backend runner.
- **Why**: `@plumbus/ui` pulls in `next`, `react`, `react-dom`, `tailwindcss`, `lucide-react` (~300 MB). The backend only needs `@plumbus/core` at runtime.
- **Target image size**: Backend should be ~500-700 MB, not 1.5 GB+.

### Rule 8: Use `ENV PATH` instead of `npx` for frontend builds

- **DO**: `ENV PATH="/app/deployed/node_modules/.bin:$PATH"` then `RUN next build`.
- **DO NOT**: `RUN npx next build`.
- **Why**: With `pnpm deploy`, binaries are in the deployed directory's `node_modules/.bin/`. Adding it to PATH ensures `next` resolves correctly.

### Rule 9: Never run migrations in the entrypoint

- **DO**: Run `npx plumbus migrate apply` as a separate CI/CD step or one-off job.
- **DO NOT**: Put migration commands in `entrypoint.sh` or Docker init containers.
- **Why**: In multi-replica deployments, concurrent migrations corrupt data.

### Rule 10: Use dynamic environment detection in `app.config.ts`

- **DO**: `environment: (process.env.NODE_ENV === 'production' ? 'production' : 'development')`
- **DO NOT**: Hardcode `environment: 'development'`. This causes `plumbus start` to skip production safeguards in Docker.

### Rule 11: Regenerate client types before building frontends

- **DO**: Run `plumbus ui generate` before `next build` if capability schemas changed.
- **DO NOT**: Build frontends with stale `frontend/lib/client.ts`.

### Rule 12: Set `output: "standalone"` in all `next.config.mjs` files

- **DO**: Add `output: "standalone"` to `next.config.mjs` for every Next.js app (frontend, admin).
- **DO NOT**: Deploy without standalone output. The app would need full `node_modules` at runtime.

### Rule 13: Add `outputFileTracingExcludes` in `next.config.mjs`

- **DO**: Exclude build/dev tools that are transitive deps of `@plumbus/ui` but not needed at runtime:
  ```js
  outputFileTracingExcludes: {
    "**": [
      "./node_modules/typescript/**",
      "./node_modules/@swc/core*/**",
    ],
  },
  ```
- **Why**: Even with `pnpm deploy`, some transitive deps (typescript, @swc/core) are present via `@plumbus/ui` but unnecessary at runtime. Excluding them saves ~50 MB.

### Rule 14: Clean up test/build tools from backend `node_modules`

- **DO**: After `npm install --omit=dev` in the backend `proddeps` stage, delete transitive deps only needed for testing/building:
  ```dockerfile
  RUN npm install --omit=dev && \
      rm -rf node_modules/@vitest node_modules/vitest \
             node_modules/playwright-core node_modules/playwright \
             node_modules/@esbuild node_modules/esbuild \
             node_modules/typescript
  ```
- **Why**: `@plumbus/core` includes vitest, playwright, esbuild, and typescript as dependencies. The backend doesn't need them at runtime.

---

## Backend Deployment

### Production Command

Use `plumbus start` for production:

| Behavior | `plumbus dev` | `plumbus start` |
|----------|---------------|------------------|
| Environment | `development` | `production` |
| Default host | `localhost` | `0.0.0.0` |
| Log level | `debug` | `info` |
| DB SSL | off | on |
| `AUTH_SECRET` | optional (uses default) | **required** (throws on startup) |
| Cookies | `secure: false` | `secure: true` |

```bash
npx plumbus start --port 3000
```

### Runtime File Requirements

These directories **must be present** in the production image:

| Directory | Purpose |
|-----------|---------|
| `app/` | Capabilities, entities, flows, events, prompts (scanned at startup) |
| `config/` | `app.config.ts`, `ai.config.ts` |
| `.plumbus/` | Generated manifests and type definitions |
| `drizzle/` | Database migration SQL files |
| `node_modules/` | Runtime dependencies including `@plumbus/core` |
| `dist/` | Compiled TypeScript output |

### Entrypoint Pattern

```sh
# entrypoint.sh — only starts the server. No migrations here.
#!/bin/sh
set -e
exec npx plumbus start --port 3000
```

Migrations run separately:

```sh
# Run BEFORE deploying new containers (CI/CD step or one-off job):
npx plumbus migrate apply
```

### Health Endpoints

| Endpoint | Purpose | Healthy response |
|----------|---------|------------------|
| `GET /health` | Liveness — server is running | `{ "status": "ok" }` |
| `GET /ready` | Readiness — database connected | `{ "status": "ready" }` |

Use `/ready` for container health checks and load balancer probes.

---

## Frontend Deployment

### Standalone Output

Add to `next.config.mjs`:

```js
const nextConfig = {
  output: "standalone",
  // ... existing config
};
```

### Build and Run

```bash
# Build (inlines NEXT_PUBLIC_* at compile time)
npx next build

# Run standalone server
PORT=3001 HOSTNAME=0.0.0.0 node .next/standalone/frontend/server.js
```

### Static Assets

After a standalone build, copy static files alongside the server:

```
.next/standalone/           # Server code
<app-dir>/.next/static/     # Static assets (must be alongside server)
```

### Environment Variables

- `NEXT_PUBLIC_*` — inlined at **build time**. Set before `next build`, not at runtime.
- `API_BASE_URL` — set at **runtime**. Internal Docker network address (e.g., `http://backend:3000`).
- `AUTH_SECRET` — required for cookie signing.

---

## Environment Variables Reference

### Backend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | `development` | Set to `production` for production |
| `DB_HOST` | Yes | `localhost` | PostgreSQL host |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_NAME` | No | App name | Database name |
| `DB_USER` | Yes | `postgres` | Database user |
| `DB_PASSWORD` | Yes | — | Database password |
| `QUEUE_HOST` | Yes | `localhost` | Redis host |
| `QUEUE_PORT` | No | `6379` | Redis port |
| `AUTH_SECRET` | **Prod** | — | JWT signing secret (required in production) |
| `AI_DEFAULT_PROVIDER` | No | `openai` | AI provider name |
| `AI_OPENAI_API_KEY` | If using OpenAI | — | OpenAI API key |
| `AI_OPENAI_MODEL` | No | `gpt-4o-mini` | Default OpenAI model |
| `AI_DEFAULT_MODEL` | No | `gpt-4o` | Fallback model |
| `TRUST_PROXY` | No | — | Set to `true` behind a reverse proxy so `request.ip` reflects `X-Forwarded-For` |

### Frontend / Admin

| Variable | Build/Runtime | Description |
|----------|---------------|-------------|
| `NEXT_PUBLIC_API_BASE_URL` | Build | Public API URL (empty string if using server-side proxy) |
| `API_BASE_URL` | Runtime | Backend URL for server-side proxy (e.g., `http://backend:3000`) |
| `AUTH_SECRET` | Runtime | Cookie signing secret |
| `AUTH_COOKIE_SECURE` | Runtime | Set to `"true"` for TLS, `"false"` for HTTP-only deployments |

---

## Docker

### Expected Image Sizes

| Image | Target Size | Too Large If |
|-------|-------------|--------------|
| Frontend | ~150-200 MB | > 400 MB |
| Admin | ~150-200 MB | > 400 MB |
| Backend | ~500-700 MB | > 1 GB |

If images exceed these sizes, you are likely not using `pnpm deploy` (Rule 5) or not stripping backend deps (Rule 7, Rule 14).

### Backend Dockerfile

```dockerfile
# ==============================================================
# BACKEND DOCKERFILE — Reference template
# See "Docker Rules" section above for the rationale behind each step.
# ==============================================================

# ---- Base ----
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ---- Full dependencies (needed for plumbus generate and pnpm build) ----
FROM base AS deps
# DO NOT copy pnpm-workspace.yaml — it may have local dev overrides.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

# ---- Production dependencies only ----
# Strip @plumbus/ui and devDependencies — backend doesn't need them at runtime.
# This saves ~300 MB (next, react, tailwindcss, etc. are excluded).
# After install, remove test/build tools from @plumbus/core transitive deps.
FROM node:22-alpine AS proddeps
WORKDIR /app
COPY package.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN node -e "\
  const p = JSON.parse(require('fs').readFileSync('package.json','utf8'));\
  for (const k of ['@plumbus/ui'])\
    delete (p.dependencies||{})[k];\
  delete p.devDependencies;\
  require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2));" && \
  npm install --omit=dev && \
  rm -rf node_modules/@vitest node_modules/vitest \
         node_modules/playwright-core node_modules/playwright \
         node_modules/@esbuild node_modules/esbuild \
         node_modules/typescript

# ---- Generate .plumbus/ ----
# DO: Generate inside Docker. DO NOT: Copy from host.
FROM deps AS generate
COPY app/ ./app/
COPY config/ ./config/
COPY tsconfig.json ./
RUN npx plumbus generate

# ---- Build ----
# Uses "FROM deps" to preserve pnpm symlinks (Rule 4).
FROM deps AS build
COPY --from=generate /app/.plumbus/ ./.plumbus/
COPY package.json tsconfig.json ./
COPY app/ ./app/
COPY config/ ./config/
COPY drizzle/ ./drizzle/
RUN pnpm build

# ---- Runner ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 plumbus && \
    adduser --system --uid 1001 plumbus
# Production-only node_modules from proddeps (no @plumbus/ui, no devDeps).
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=generate /app/.plumbus/ ./.plumbus/
COPY package.json ./
COPY app/ ./app/
COPY config/ ./config/
COPY drizzle/ ./drizzle/
USER plumbus
EXPOSE 3000
HEALTHCHECK CMD wget -q -O /dev/null http://localhost:3000/ready || exit 1
ENTRYPOINT ["./entrypoint.sh"]
```

### Frontend Dockerfile

For the **admin dashboard**, replace `{./frontend}` with `{./frontend-admin}`, change port 3001 to 3002, and adjust the package filter accordingly.

```dockerfile
# ==============================================================
# FRONTEND DOCKERFILE — Reference template
# Uses pnpm deploy to isolate frontend deps from the monorepo.
# See "Docker Rules" section above for the rationale behind each step.
# ==============================================================

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ---- Install full workspace (needed for pnpm deploy to resolve deps) ----
FROM base AS deps
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
COPY frontend-admin/package.json ./frontend-admin/
RUN pnpm install

# ---- Deploy + Build ----
# pnpm deploy creates a self-contained directory with flat node_modules
# containing ONLY the frontend's dependencies — no backend/root workspace deps.
FROM deps AS build
COPY frontend/ ./frontend/
RUN pnpm --filter {./frontend} deploy --legacy /app/deployed
ENV PATH="/app/deployed/node_modules/.bin:$PATH"
WORKDIR /app/deployed
RUN next build

# ---- Runner ----
# Standalone output only — includes server.js + traced node_modules (~30-40 MB).
# DO NOT copy node_modules from deps — standalone has everything it needs.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nextjs && \
    adduser --system --uid 1001 nextjs
COPY --from=build /app/deployed/.next/standalone ./
COPY --from=build /app/deployed/.next/static ./deployed/.next/static
USER nextjs
EXPOSE 3001
CMD ["node", "deployed/server.js"]
```

### Docker Compose

```yaml
services:
  postgres:
    image: postgres:16-alpine
    volumes: [postgres_data:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
  backend:
    build: { dockerfile: Dockerfile.backend }
    depends_on: [postgres, redis]
    volumes: [uploads_data:/app/uploads]
  frontend:
    build: { dockerfile: Dockerfile.frontend }
    depends_on: [backend]
  admin:
    build: { dockerfile: Dockerfile.admin }
    depends_on: [backend]
```

### .dockerignore

Place at the project root. Must include at minimum:

```
node_modules
.next
dist
.turbo
.git
uploads
**/e2e
docs
```

### File Layout

Place all Docker files in a `docker/` subdirectory:

```
docker/
  Dockerfile.backend
  Dockerfile.frontend
  Dockerfile.admin
  docker-compose.yml
  entrypoint-backend.sh
  .env.example
.dockerignore          # at project root (the build context)
```

Set `context: ..` in compose `build:` sections so COPY paths resolve from the project root.

---

## HTTP Deployments Without TLS

`plumbus start` sets `secure: true` on auth cookies by default. If you deploy over plain HTTP (no TLS), browsers silently drop `Secure` cookies, causing infinite login redirect loops.

### Workaround

Set `AUTH_COOKIE_SECURE=false` in the environment. Frontend auth route handlers must read it:

```ts
// app/api/auth/login/route.ts
const isSecure = process.env.AUTH_COOKIE_SECURE === "true";

cookies().set("auth_token", token, {
  httpOnly: true,
  secure: isSecure,
  sameSite: isSecure ? "strict" : "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
});
```

**Security trade-off** — always use TLS in production and set `AUTH_COOKIE_SECURE=true`.

---

## Kubernetes / Helm

### Required Resources

| Resource | Purpose |
|----------|---------|
| `Deployment` (backend) + `Service` | Plumbus API server — stateless, scales horizontally |
| `Deployment` (frontend) + `Service` | Next.js user-facing app — stateless |
| `Deployment` (admin) + `Service` | Next.js admin dashboard — stateless |
| `Ingress` | Routes traffic: `/api` -> backend, `/` -> frontend, `/admin` -> admin |
| `Job` (migrations) | One-off pre-deploy step — runs `npx plumbus migrate apply` |
| `Secret` | `DB_PASSWORD`, `AUTH_SECRET`, AI provider keys |
| `ConfigMap` | Non-sensitive config: `DB_HOST`, `AI_DEFAULT_PROVIDER`, etc. |

### Migrations — Critical

**NEVER** run migrations in the entrypoint or in init containers that run per-replica. Run as a **separate Job** before rolling out new pods:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: app-migrate
spec:
  template:
    spec:
      containers:
      - name: migrate
        image: your-registry/app-backend:v1.0.0
        command: ["npx", "plumbus", "migrate", "apply"]
        envFrom:
        - secretRef:
            name: app-backend-secrets
      restartPolicy: Never
  backoffLimit: 1
```

### Health Probes

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3000 }
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /ready, port: 3000 }
  periodSeconds: 10
```

### Scaling

- **Backend**: Stateless — safe to scale. All replicas must share the same `AUTH_SECRET`.
- **Frontends**: Stateless — scale freely behind a load balancer.
- **Uploads**: Replace local `uploads/` with object storage (S3, GCS) or a `ReadWriteMany` PVC.
- **PostgreSQL / Redis**: Use managed services (RDS, ElastiCache) — not the Docker Compose images.

---

## Production Checklist

### Server

- [ ] `plumbus start` used as production command
- [ ] `AUTH_SECRET` set to strong random value (32+ chars)
- [ ] Database SSL enabled (automatic with `plumbus start`)
- [ ] Migrations run separately — NOT in entrypoint
- [ ] Health checks on `/ready`
- [ ] `config/app.config.ts` uses dynamic environment detection
- [ ] AI provider API keys configured
- [ ] Redis available for job queue

### Docker — Image Size

- [ ] `output: "standalone"` in all `next.config.mjs` files
- [ ] Frontend/admin runner copies ONLY `.next/standalone` + `.next/static`
- [ ] Frontend/admin runner does NOT contain `node_modules` from deps stage
- [ ] Backend runner uses production-only `node_modules` with `@plumbus/ui` stripped
- [ ] Image sizes: frontends ~150-200 MB, backend ~500-700 MB

### Docker — Build Correctness

- [ ] `.npmrc` copied into all Docker images
- [ ] `pnpm deploy --legacy` used to isolate frontend deps (not hoisted full-workspace install)
- [ ] `ENV PATH="/app/deployed/node_modules/.bin:$PATH"` set before `next build`
- [ ] `outputFileTracingExcludes` configured in `next.config.mjs` (typescript, @swc/core)
- [ ] Backend `proddeps` cleans up vitest/playwright/esbuild/typescript after npm install
- [ ] `.plumbus/` generated inside Docker (not copied from host)
- [ ] `plumbus ui generate` run before building frontends
- [ ] `.dockerignore` excludes `node_modules/`, `dist/`, `.git/`, `uploads/`, `**/e2e/`

### Volumes and Networking

- [ ] Persistent volumes for PostgreSQL data and uploads
- [ ] `API_BASE_URL` set to Docker service name (e.g., `http://backend:3000`)
- [ ] `NEXT_PUBLIC_API_BASE_URL` set to empty string `""` (for server-side proxy)
- [ ] `AUTH_COOKIE_SECURE` set to `"true"` (or `"false"` only for HTTP-only — security trade-off)
