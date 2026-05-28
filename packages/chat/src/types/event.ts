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
      /** Hash of the capability's input schema at the time the action was
       * proposed. Clients must echo this back to `chatConfirmAction` so the
       * server can detect schema drift between propose and confirm. Optional
       * for wire-compat with pre-0.1.4 servers that did not emit it. */
      schemaHash?: string;
    }
  | {
      type: 'turn.completed';
      turnId: string;
      usage: ChatUsage;
      cost: number;
      inScope?: boolean;
      refusalReason?: 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request' | null;
      sources?: ChatSourceRef[];
    }
  | { type: 'turn.failed'; code: string; message: string };
