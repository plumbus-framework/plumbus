import { createHash } from 'node:crypto';

export function stableHash(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 8);
}
