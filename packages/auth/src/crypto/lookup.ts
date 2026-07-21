import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmacLookup(subkey: Buffer, value: string): string {
  return createHmac('sha256', subkey).update(value, 'utf8').digest('base64url');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
