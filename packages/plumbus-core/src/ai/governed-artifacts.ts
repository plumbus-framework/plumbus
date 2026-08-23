import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digestApprovalInput } from '../approvals/digest.js';

export type GovernedArtifactKind = 'prompt' | 'policy';

export interface GovernedArtifact {
  kind: GovernedArtifactKind;
  id: string;
  body: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface PublishedGovernedArtifact extends GovernedArtifact {
  digest: string;
  publishedAt: string;
}

export interface GovernedArtifactStore {
  publish(artifact: GovernedArtifact): PublishedGovernedArtifact;
  get(digest: string): PublishedGovernedArtifact | undefined;
}

export interface FilesystemGovernedArtifactStoreConfig {
  /** Host-owned directory. Created if missing. */
  directory: string;
}

export class GovernedArtifactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernedArtifactConflictError';
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function canonicalArtifact(artifact: GovernedArtifact): unknown {
  return {
    kind: artifact.kind,
    id: artifact.id,
    body: artifact.body,
    metadata: artifact.metadata ?? {},
  };
}

/** SHA-256 of the canonical artifact. The address is the content. */
export function digestGovernedArtifact(artifact: GovernedArtifact): string {
  return digestApprovalInput(canonicalArtifact(artifact));
}

function artifactKey(kind: GovernedArtifactKind, id: string): string {
  return `${kind}:${id}`;
}

function immutableConflict(key: string): never {
  throw new GovernedArtifactConflictError(
    `Artifact "${key}" is immutable; publish a new id instead of changing the body`,
  );
}

function preparePublish(artifact: GovernedArtifact): {
  normalized: GovernedArtifact;
  digest: string;
  key: string;
} {
  const kind = artifact.kind;
  const id = artifact.id.trim();
  const body = artifact.body;
  if (kind !== 'prompt' && kind !== 'policy') {
    throw new GovernedArtifactConflictError('Artifact kind must be prompt or policy');
  }
  if (!id) {
    throw new GovernedArtifactConflictError('Artifact id is required');
  }
  if (typeof body !== 'string' || body.trim() === '') {
    throw new GovernedArtifactConflictError('Artifact body is required');
  }

  const normalized: GovernedArtifact = {
    kind,
    id,
    body,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  };
  return {
    normalized,
    digest: digestGovernedArtifact(normalized),
    key: artifactKey(kind, id),
  };
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

function keyObjectName(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function isPublishedArtifact(value: unknown): value is PublishedGovernedArtifact {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'prompt' && record.kind !== 'policy') return false;
  if (typeof record.id !== 'string' || typeof record.body !== 'string') return false;
  if (typeof record.digest !== 'string' || typeof record.publishedAt !== 'string') return false;
  if (record.metadata !== undefined) {
    if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
      return false;
    }
  }
  return true;
}

function assertStoredDigest(published: PublishedGovernedArtifact, expectedDigest: string): void {
  if (published.digest !== expectedDigest) {
    throw new GovernedArtifactConflictError('Stored artifact digest does not match its address');
  }
  const computed = digestGovernedArtifact({
    kind: published.kind,
    id: published.id,
    body: published.body,
    ...(published.metadata ? { metadata: published.metadata } : {}),
  });
  if (computed !== expectedDigest) {
    throw new GovernedArtifactConflictError('Stored artifact bytes do not match their digest');
  }
}

function readJsonFile(filePath: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    if (err instanceof SyntaxError) {
      throw new GovernedArtifactConflictError('Stored artifact is not valid JSON');
    }
    throw err;
  }
}

function writeJsonExclusive(filePath: string, value: unknown): 'created' | 'exists' {
  try {
    writeFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf-8', flag: 'wx' });
    return 'created';
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return 'exists';
    throw err;
  }
}

/**
 * In-memory digest-addressed store. Republishing the same bytes is idempotent.
 * A later publish of the same kind+id with different bytes is refused.
 */
export function createMemoryGovernedArtifactStore(): GovernedArtifactStore {
  const byDigest = new Map<string, PublishedGovernedArtifact>();
  const digestByKey = new Map<string, string>();

  return {
    publish(artifact) {
      const { normalized, digest, key } = preparePublish(artifact);
      const existing = byDigest.get(digest);
      if (existing) {
        return existing;
      }

      const priorDigest = digestByKey.get(key);
      if (priorDigest && priorDigest !== digest) {
        immutableConflict(key);
      }

      const published: PublishedGovernedArtifact = {
        ...normalized,
        digest,
        publishedAt: new Date().toISOString(),
      };
      byDigest.set(digest, published);
      digestByKey.set(key, digest);
      return published;
    },

    get(digest) {
      const trimmed = digest.trim();
      if (!trimmed) return undefined;
      return byDigest.get(trimmed);
    },
  };
}

/**
 * Digest-addressed store on a host-owned directory. Same immutability rules as
 * the in-memory store. A new process pointed at the same directory sees prior
 * publishes. Error messages never include artifact bodies.
 */
export function createFilesystemGovernedArtifactStore(
  config: FilesystemGovernedArtifactStoreConfig,
): GovernedArtifactStore {
  const directory = config.directory.trim();
  if (!directory) {
    throw new Error('Filesystem governed artifact store requires a directory');
  }

  const root = resolve(directory);
  const artifactsDir = join(root, 'artifacts');
  const keysDir = join(root, 'keys');
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(keysDir, { recursive: true });

  function artifactPath(digest: string): string {
    return join(artifactsDir, `${digest}.json`);
  }

  function keyPath(key: string): string {
    return join(keysDir, `${keyObjectName(key)}.json`);
  }

  function readPublished(digest: string): PublishedGovernedArtifact | undefined {
    if (!DIGEST_PATTERN.test(digest)) return undefined;
    const parsed = readJsonFile(artifactPath(digest));
    if (parsed === undefined) return undefined;
    if (!isPublishedArtifact(parsed)) {
      throw new GovernedArtifactConflictError('Stored artifact is missing required fields');
    }
    assertStoredDigest(parsed, digest);
    return parsed;
  }

  function readKeyDigest(key: string): string | undefined {
    const parsed = readJsonFile(keyPath(key));
    if (parsed === undefined) return undefined;
    if (!parsed || typeof parsed !== 'object') {
      throw new GovernedArtifactConflictError('Stored artifact key is invalid');
    }
    const record = parsed as { key?: unknown; digest?: unknown };
    if (record.key !== key || typeof record.digest !== 'string') {
      throw new GovernedArtifactConflictError('Stored artifact key does not match its address');
    }
    if (!DIGEST_PATTERN.test(record.digest)) {
      throw new GovernedArtifactConflictError('Stored artifact key digest is invalid');
    }
    return record.digest;
  }

  return {
    publish(artifact) {
      const { normalized, digest, key } = preparePublish(artifact);
      const existing = readPublished(digest);
      if (existing) {
        return existing;
      }

      const priorDigest = readKeyDigest(key);
      if (priorDigest && priorDigest !== digest) {
        immutableConflict(key);
      }

      const published: PublishedGovernedArtifact = {
        ...normalized,
        digest,
        publishedAt: new Date().toISOString(),
      };

      const digestWrite = writeJsonExclusive(artifactPath(digest), published);
      if (digestWrite === 'exists') {
        const raced = readPublished(digest);
        if (raced) return raced;
        throw new GovernedArtifactConflictError(
          'Stored artifact digest does not match its address',
        );
      }

      const keyWrite = writeJsonExclusive(keyPath(key), { key, digest });
      if (keyWrite === 'exists') {
        const racedDigest = readKeyDigest(key);
        if (racedDigest && racedDigest !== digest) {
          immutableConflict(key);
        }
      }

      return published;
    },

    get(digest) {
      const trimmed = digest.trim();
      if (!trimmed) return undefined;
      return readPublished(trimmed);
    },
  };
}
