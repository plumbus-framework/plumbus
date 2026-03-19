# Deployment

Plumbus applications deploy as up to three services — a **backend** (Fastify API server), a **frontend** (Next.js), and optionally an **admin dashboard** (Next.js) — backed by PostgreSQL and Redis. This document covers production configuration, containerization, and operational readiness.

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

- **Frontend** and **admin** proxy API calls to the backend via server-side route handlers (`app/api/[...path]/route.ts`). Browsers never connect directly to the backend.
- **Backend** connects to PostgreSQL (data) and Redis (job queue, event dispatch).

## Backend Deployment

### Production Command

Use `plumbus start` for production. It forces production environment, binds to `0.0.0.0`, and requires `AUTH_SECRET`:

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

The backend uses dynamic resource discovery at startup — it scans the source tree for capabilities, entities, flows, events, and prompts. The following directories **must be present** in the production image:

| Directory | Purpose |
|-----------|---------|
| `app/` | Capabilities, entities, flows, events, prompts (scanned at startup) |
| `config/` | `app.config.ts`, `ai.config.ts` |
| `.plumbus/` | Generated manifests and type definitions |
| `drizzle/` | Database migration SQL files |
| `node_modules/` | Runtime dependencies including `@plumbus/core` |
| `dist/` | Compiled TypeScript output |

### Entrypoint Pattern

**CRITICAL**: Do **not** run migrations automatically in the container entrypoint. In multi-replica deployments (Kubernetes, ECS), concurrent migration runs can corrupt data or cause extended downtime. Run migrations as a separate, deliberate step before deploying new containers.

```sh
# Run migrations BEFORE deploying new containers (CI/CD step or one-off job):
npx plumbus migrate apply

# Then deploy. Container entrypoint only starts the server:
#!/bin/sh
set -e
exec npx plumbus start --port 3000
```

### Health Endpoints

| Endpoint | Purpose | Healthy response |
|----------|---------|------------------|
| `GET /health` | Liveness — server is running | `{ "status": "ok" }` |
| `GET /ready` | Readiness — database connected | `{ "status": "ready" }` |

Use `/ready` for container health checks and load balancer probes.

## Frontend Deployment

### Standalone Output

**CRITICAL**: Add `output: "standalone"` to `next.config.mjs` for containerized or self-hosted deployment. Without this, the build requires the full `node_modules` at runtime.

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
node .next/standalone/<app-dir>/server.js
```

Set `PORT` and `HOSTNAME` environment variables to control the listening address:

```bash
PORT=3001 HOSTNAME=0.0.0.0 node .next/standalone/frontend/server.js
```

### Static Assets

After a standalone build, static files live in `.next/static/`. Copy them to the correct path in your deployment:

```
.next/standalone/           # Server code
<app-dir>/.next/static/     # Static assets (must be alongside server)
```

### Environment Variables

- `NEXT_PUBLIC_*` variables are inlined at **build time**. Set them before `next build`, not at runtime.
- `API_BASE_URL` (server-only) controls the backend URL for server-side proxy routes. Set this at runtime to the internal Docker network address (e.g., `http://backend:3000`).
- `AUTH_SECRET` is required for cookie signing.

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

### Frontend / Admin

| Variable | Build/Runtime | Description |
|----------|---------------|-------------|
| `NEXT_PUBLIC_API_BASE_URL` | Build | Public API URL (empty string if using server-side proxy) |
| `API_BASE_URL` | Runtime | Backend URL for server-side proxy (e.g., `http://backend:3000`) |
| `AUTH_SECRET` | Runtime | Cookie signing secret |

## Docker

### Backend Dockerfile (multi-stage)

```dockerfile
# ---- Base ----
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
# Do NOT copy pnpm-workspace.yaml — it may contain local dev overrides
# (link:../Plumbus/...) that don't exist in Docker. Packages resolve from npm.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

# ---- Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY app/ ./app/
COPY config/ ./config/
COPY .plumbus/ ./.plumbus/
COPY drizzle/ ./drizzle/
RUN pnpm build

# ---- Runner ----
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 plumbus && \
    adduser --system --uid 1001 plumbus
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY app/ ./app/
COPY config/ ./config/
COPY .plumbus/ ./.plumbus/
COPY drizzle/ ./drizzle/
# Entrypoint starts the production server
USER plumbus
EXPOSE 3000
HEALTHCHECK CMD curl -f http://localhost:3000/ready || exit 1
ENTRYPOINT ["./entrypoint.sh"]
```

### Frontend Dockerfile (Next.js standalone)

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY frontend/package.json ./frontend/
# Generate a clean workspace config — don't copy the host's pnpm-workspace.yaml
RUN printf 'packages:\n  - "frontend"\n' > pnpm-workspace.yaml
RUN pnpm install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY frontend/ ./frontend/
WORKDIR /app/frontend
RUN npx next build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nextjs && \
    adduser --system --uid 1001 nextjs
COPY --from=build /app/frontend/.next/standalone ./
COPY --from=build /app/frontend/.next/static ./frontend/.next/static
USER nextjs
EXPOSE 3001
CMD ["node", "frontend/server.js"]
```

### Docker Compose Topology

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

### Key Docker Considerations

- **Do NOT copy `pnpm-workspace.yaml`** into Docker images. It may contain local dev overrides (`link:../Plumbus/...`) that don't exist in the build context. The backend Dockerfile doesn't need it at all. Frontend Dockerfiles generate a minimal workspace config inline (`printf 'packages: ["frontend"]' > pnpm-workspace.yaml`) to declare the sub-package.
- **Dependency resolution**: `@plumbus/core` and `@plumbus/ui` are declared as normal dependencies in `package.json`. Without the workspace overrides, `pnpm install` resolves them from the npm registry.
- **Volumes**: Mount persistent volumes for PostgreSQL data and the `uploads/` directory (user-generated media and exports).
- **Internal networking**: Frontends connect to backend via Docker service name (e.g., `http://backend:3000`). Set `API_BASE_URL` accordingly.
- **`NEXT_PUBLIC_API_BASE_URL`**: Set to empty string (`""`) if the frontend uses server-side proxy routes. The proxy route handler reads `API_BASE_URL` at runtime.
- **File layout**: Place all Docker files (Dockerfiles, compose, entrypoint, env template) in a `docker/` subdirectory. The `.dockerignore` stays at the project root (the build context). Set `context: ..` (parent) in compose `build:` sections so COPY paths resolve from the project root.

## Kubernetes / Helm

The Docker images are self-contained and orchestrator-agnostic. When deploying to Kubernetes:

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

### Migrations in Kubernetes — Critical

**NEVER** run migrations in the container entrypoint or as an init container that runs on every pod replica. In a rolling deployment with multiple pods starting concurrently, parallel migration runs against the same database can corrupt data or cause extended downtime.

Run migrations as a **separate Kubernetes Job** before rolling out new pods:

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

### Scaling Notes

- **Backend**: Stateless — safe to scale. All replicas must share the same `AUTH_SECRET`.
- **Frontends**: Stateless — scale freely behind a load balancer.
- **Uploads**: Replace the local `uploads/` directory with object storage (S3, GCS) or a `ReadWriteMany` PersistentVolumeClaim.
- **PostgreSQL / Redis**: Use managed services (RDS, ElastiCache, etc.) or official Helm charts — not the Docker Compose images.

## Production Checklist

- [ ] `plumbus start` used as production server command
- [ ] `AUTH_SECRET` set to a strong random value (32+ characters)
- [ ] Database SSL enabled (automatic with `plumbus start`)
- [ ] `plumbus migrate apply` run as a separate step before deployment (NOT in entrypoint)
- [ ] Health checks configured for `/ready` endpoint
- [ ] `output: "standalone"` in all `next.config.mjs` files
- [ ] Persistent volumes for PostgreSQL data and uploads
- [ ] AI provider API keys configured
- [ ] Redis available for job queue and event dispatch
