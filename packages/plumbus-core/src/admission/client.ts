import { PlumbusError } from '../errors/index.js';
import type { RequestAdmissionChallenge, RequestAdmissionProof } from './shared.js';
import { createAdmissionWorkChecker, requestAdmissionChallengeSchema } from './shared.js';

/** Bundled browser solver. Bounded work, cooperative scheduling, no network or persistent storage. */
export async function solveRequestAdmission(
  challenge: RequestAdmissionChallenge,
  options: { signal?: AbortSignal; now?: () => number; maxDurationMs?: number } = {},
): Promise<RequestAdmissionProof> {
  const parsed = requestAdmissionChallengeSchema.safeParse(challenge);
  if (!parsed.success)
    throw new PlumbusError('validation', 'Invalid request verification challenge');
  const now = options.now ?? (() => performance.now());
  // The server validates ticket expiry. A skewed client clock must not refuse valid work.
  const end = now() + (options.maxDurationMs ?? 30_000);
  const accepts = createAdmissionWorkChecker(challenge.token, challenge.difficulty);
  let yieldAt = now() + 8;
  for (let solution = 0; solution <= 0xffffffff; solution++) {
    if (solution % 512 === 0) {
      if (options.signal?.aborted)
        throw new PlumbusError('conflict', 'Request verification cancelled');
      if (now() >= end)
        throw new PlumbusError('conflict', 'Request verification expired; retry the request');
      if (now() >= yieldAt) {
        const scheduler = (globalThis as { scheduler?: { yield: () => Promise<void> } }).scheduler;
        if (scheduler) await scheduler.yield();
        else await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yieldAt = now() + 8;
      }
    }
    if (accepts(String(solution))) {
      return { token: challenge.token, solution: String(solution) };
    }
  }
  throw new PlumbusError('conflict', 'Request verification could not be completed');
}
export type { RequestAdmissionChallenge, RequestAdmissionProof } from './shared.js';
