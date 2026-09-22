// packages/chat/src/types/tool.ts

export interface ToolExecutionRecord {
  toolCallId: string;
  name: string;
  kind: 'capability' | 'flow';
  mode: 'auto' | 'confirm';
  status:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'in_progress'
    | 'confirm_pending'
    | 'indeterminate'
    | 'not_executed';
  executionId?: string;
  errorCode?: string;
  /**
   * Omitted when persistence.messageContent === 'client'; omitted from browser events by
   * default; bounded to 2 KiB when stored; derived AFTER input validation and redaction.
   */
  argsPreview?: unknown;
}

/** Successful physical AI call made inside an auto capability tool. */
export interface ChatNestedAiCall {
  /** Bound capability name, before provider tool-name normalization. */
  toolName: string;
  /** Registered prompt name supplied by the capability. */
  prompt: string;
  usage: { tokensIn: number; tokensOut: number };
  cost: number;
  model: string;
  provider: string;
  /** Whether this call was added to the logical Chat turn's usage and budget. */
  includedInTurnUsage: boolean;
}
