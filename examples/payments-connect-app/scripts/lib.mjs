// Shared harness for the payments test app: a throwaway Postgres container,
// the Plumbus CLI, the app process, JWTs, an API client, and the Stripe simulator.
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot, linkPackages, repoRoot } from './link.mjs';

export { appRoot, repoRoot };

const coreDir = path.join(repoRoot, 'packages/plumbus-core');
const cliPath = path.join(coreDir, 'bin/plumbus.js');
const requireFromPayments = createRequire(path.join(repoRoot, 'packages/payments/package.json'));
const requireFromCore = createRequire(path.join(coreDir, 'package.json'));

export async function loadFastify() {
  const { default: Fastify } = await import(pathToFileURL(requireFromPayments.resolve('fastify')).href);
  return Fastify;
}

export async function loadPostgres() {
  const { default: postgres } = await import(pathToFileURL(requireFromCore.resolve('postgres')).href);
  return postgres;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, { timeoutMs = 20_000, intervalMs = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ── Postgres ──

/**
 * A private Postgres for one run: a docker container (postgres:16-alpine) on a
 * random localhost port, removed on stop. Set E2E_DB_HOST/PORT/USER/PASSWORD to
 * use an existing server instead (a fresh database name is used either way).
 */
export async function startDatabase({ log }) {
  const database = `payments_app_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
  if (process.env.E2E_DB_HOST) {
    return {
      env: {
        DB_HOST: process.env.E2E_DB_HOST,
        DB_PORT: process.env.E2E_DB_PORT ?? '5432',
        DB_USER: process.env.E2E_DB_USER ?? 'postgres',
        DB_PASSWORD: process.env.E2E_DB_PASSWORD ?? '',
        DB_NAME: database,
      },
      stop: async () => {},
    };
  }
  const name = `plumbus-payments-app-${process.pid}-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', name,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', '127.0.0.1::5432',
    'postgres:16-alpine',
  ], { stdio: 'pipe' });
  const stop = async () => {
    try {
      execFileSync('docker', ['stop', '-t', '2', name], { stdio: 'pipe' });
    } catch {
      // already gone
    }
  };
  try {
    const mapping = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim();
    const port = mapping.split('\n')[0].split(':').pop();
    await waitFor(
      () => {
        execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { stdio: 'pipe' });
        return true;
      },
      { timeoutMs: 30_000, intervalMs: 300, what: 'Postgres to accept connections' },
    );
    log(`postgres container ${name} on 127.0.0.1:${port}`);
    return {
      env: { DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: 'postgres', DB_PASSWORD: password, DB_NAME: database },
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

// ── Plumbus CLI + app process ──

export function baseEnv(extra) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'development',
    PLUMBUS_ENV: 'development',
    ...extra,
  };
}

/**
 * Run `plumbus <args>` in the app directory; resolves stdout, rejects with output.
 * Async on purpose: the Stripe simulator runs in this process and must keep answering.
 */
export function plumbus(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`plumbus ${args.join(' ')} exited ${code}:\n${out}`)),
    );
  });
}

export async function startApp({ env, port, log }) {
  const output = [];
  const child = spawn(process.execPath, [cliPath, 'dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) output.push(line);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      async () => {
        if (exited) throw new Error(`app exited (${JSON.stringify(exited)})`);
        const response = await fetch(`${baseUrl}/health`);
        return response.ok;
      },
      { timeoutMs: 60_000, intervalMs: 300, what: 'the app to answer /health' },
    );
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\n--- app output ---\n${output.slice(-60).join('\n')}`);
  }
  log(`app listening on ${baseUrl} (pid ${child.pid})`);
  return {
    baseUrl,
    output,
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      const done = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        sleep(12_000).then(() => false),
      ]);
      if (!done) child.kill('SIGKILL');
    },
  };
}

// ── Auth + API ──

export function signJwt(secret, claims) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ iat: now, exp: now + 3600, ...claims });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** A signed-in caller of the app's generated capability routes. */
export function caller(baseUrl, secret, { userId, tenantId, roles }) {
  const token = signJwt(secret, { sub: userId, tenant_id: tenantId, roles });
  async function call(method, route, input) {
    const url = new URL(`${baseUrl}${route}`);
    if (method === 'GET' && input) {
      for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, data: body.data, error: body.error };
  }
  const expectOk = async (method, route, input) => {
    const result = await call(method, route, input);
    if (result.status !== 200) {
      throw new Error(`${method} ${route} → ${result.status} ${JSON.stringify(result.error)}`);
    }
    return result.data;
  };
  return {
    userId,
    tenantId,
    call,
    /** POST an action capability (`domain`, `capabilityName` in kebab case). */
    action: (domain, name, input) => expectOk('POST', `/api/${domain}/${name}`, input),
    query: (domain, name, input) => expectOk('GET', `/api/${domain}/${name}`, input),
  };
}

export function simClient(simUrl) {
  return async function sim(method, route, body) {
    const response = await fetch(`${simUrl}${route}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`sim ${method} ${route} → ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
}

export { linkPackages };
