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
