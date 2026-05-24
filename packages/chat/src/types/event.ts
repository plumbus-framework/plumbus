import type { ChatSourceRef } from './context.js';
import type { ChatUsage } from './budget.js';

export type ChatEvent =
  | { type: 'turn.started'; turnId: string; ordinal: number }
  | { type: 'source.added'; source: ChatSourceRef }
  | { type: 'notice'; code: string; message: string; retryAfterSeconds?: number }
  | { type: 'message.delta'; text: string }
  | {
      type: 'confirmation_required';
      actionId: string;
      capabilityName: string;
      confirmationMessage: string;
      expiresAt: string;
    }
  | { type: 'turn.completed'; turnId: string; usage: ChatUsage; cost: number }
  | { type: 'turn.failed'; code: string; message: string };
