import { sha256 } from '@noble/hashes/sha256';
import { z } from 'zod';

export const requestAdmissionChallengeSchema = z.object({
  token: z.string().min(1).max(2048),
  difficulty: z.number().int().min(12).max(22),
  expiresAt: z.number().int().positive(),
});
export const requestAdmissionProofSchema = z.object({
  token: z.string().min(1).max(2048),
  solution: z.string().regex(/^(0|[1-9][0-9]{0,9})$/),
});
export type RequestAdmissionChallenge = z.infer<typeof requestAdmissionChallengeSchema>;
export type RequestAdmissionProof = z.infer<typeof requestAdmissionProofSchema>;

/** A work stamp, not an authentication credential or evidence of a human. */
export function satisfiesAdmissionWork(
  token: string,
  solution: string,
  difficulty: number,
): boolean {
  const hash = sha256(new TextEncoder().encode(`${token}:${solution}`));
  return hasLeadingZeroBits(hash, difficulty);
}

function hasLeadingZeroBits(hash: Uint8Array, difficulty: number): boolean {
  for (let bit = 0; bit < difficulty; bit++) {
    if (((hash[Math.floor(bit / 8)] ?? 255) & (1 << (7 - (bit % 8)))) !== 0) return false;
  }
  return true;
}

/** Reuse the invariant hash prefix instead of hashing the entire ticket for every candidate. */
export function createAdmissionWorkChecker(token: string, difficulty: number) {
  const encoder = new TextEncoder();
  const prefix = sha256.create().update(encoder.encode(`${token}:`));
  return (solution: string): boolean =>
    hasLeadingZeroBits(prefix.clone().update(encoder.encode(solution)).digest(), difficulty);
}
