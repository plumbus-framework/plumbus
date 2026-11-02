/**
 * Abort reason, and `turn.interrupted` reason, for a turn that was cancelled
 * while the brain was still writing because the user kept speaking
 * (`interruptions.whileWriting: 'restart'`). The aborted transcript is
 * re-sent as the prefix of the next turn, so a brain that persisted it can
 * discard that record when it sees this reason.
 */
export const VOICE_TURN_SUPERSEDED_REASON = 'superseded';

/** True when `signal` was aborted because a newer combined turn replaces this one. */
export function isVoiceTurnSuperseded(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === VOICE_TURN_SUPERSEDED_REASON;
}
