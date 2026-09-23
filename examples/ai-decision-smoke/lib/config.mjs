import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createErrorService, z } from './deps.mjs';

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const envFile = fileURLToPath(new URL('../.env', import.meta.url));

/** Create once; preserve any existing password and never read the repository's .env. */
export async function ensureEnvironment(path = envFile) {
  const content = [
    `LAYA_API_KEY=${randomBytes(32).toString('hex')}`,
    'LAYA_BASE_URL=http://127.0.0.1:8080/v1',
    'LAYA_MODEL=english',
    'LAYA_MODELS=english',
    'LAYA_DEVICE=cpu',
    'OMP_NUM_THREADS=2',
    'MKL_NUM_THREADS=2',
    '',
  ].join('\n');
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!z.object({ code: z.literal('EEXIST') }).safeParse(error).success) throw error;
  }
  return loadConfig(path);
}

export async function loadConfig(path = envFile) {
  const raw = parseEnv(await readFile(path, 'utf8'));
  const parsed = z
    .object({
      LAYA_API_KEY: z.string().regex(/^[\x21-\x7e]+$/),
      LAYA_BASE_URL: z.string().url(),
      LAYA_MODEL: z.enum(['english', 'multilingual', 'typed-decisions']),
      LAYA_MODELS: z.string().min(1),
      LAYA_DEVICE: z.literal('cpu'),
    })
    .safeParse(raw);
  if (!parsed.success)
    throw createErrorService().validation(
      'Invalid smoke .env configuration. See examples/ai-decision-smoke/.env.example; keys must not contain whitespace.',
    );
  const url = new URL(parsed.data.LAYA_BASE_URL);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    !['/v1', '/v1/'].includes(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw createErrorService().validation(
      'This local smoke requires LAYA_BASE_URL=http://127.0.0.1:PORT/v1. It never sends requests to the hosted TypeSafe API.',
    );
  }
  const models = parsed.data.LAYA_MODELS.split(',').map((name) => name.trim());
  if (
    !z
      .array(z.enum(['english', 'multilingual', 'typed-decisions']))
      .min(1)
      .safeParse(models).success ||
    !models.includes(parsed.data.LAYA_MODEL)
  ) {
    throw createErrorService().validation(
      'LAYA_MODEL must be included in the LAYA_MODELS preload list.',
    );
  }
  return {
    apiKey: parsed.data.LAYA_API_KEY,
    baseUrl: url.href.replace(/\/$/, ''),
    origin: url.origin,
    port: Number(url.port),
    model: parsed.data.LAYA_MODEL,
    envFile: path,
  };
}
