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
      inputSchemaHash?: string;
      projection?: unknown;
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
  | { type: 'turn.failed'; code: string; message: string }
  | { type: 'tool.started'; toolCallId: string; name: string; kind: 'capability' | 'flow' }
  | {
      type: 'tool.completed';
      toolCallId: string;
      name: string;
      kind: 'capability' | 'flow';
      /** Validated, <=8 KiB. Raw capability/flow results MUST NOT be placed here. */
      projection?: unknown;
    }
  | {
      type: 'tool.failed';
      toolCallId: string;
      name: string;
      kind: 'capability' | 'flow';
      code: string;
      message: string;
    }
  | {
      type: 'confirmation.resolved';
      actionId: string;
      decision: 'confirm' | 'reject';
      pendingStatus: 'confirmed' | 'rejected' | 'failed' | 'indeterminate' | 'expired';
      executionStatus: 'not_requested' | 'succeeded' | 'failed' | 'indeterminate';
    };
