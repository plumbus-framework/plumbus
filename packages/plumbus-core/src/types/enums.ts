// ── Field Classification ──
export const FieldClassification = {
  Public: 'public',
  Internal: 'internal',
  Personal: 'personal',
  Sensitive: 'sensitive',
  HighlySensitive: 'highly_sensitive',
} as const;

export type FieldClassification = (typeof FieldClassification)[keyof typeof FieldClassification];

// ── Capability Kind ──
export const CapabilityKind = {
  Query: 'query',
  Action: 'action',
  Job: 'job',
  EventHandler: 'eventHandler',
} as const;

export type CapabilityKind = (typeof CapabilityKind)[keyof typeof CapabilityKind];

// ── Flow Step Type ──
export const FlowStepType = {
  Capability: 'capability',
  Conditional: 'conditional',
  Wait: 'wait',
  Delay: 'delay',
  Parallel: 'parallel',
  EventEmit: 'eventEmit',
  /** Route on an approval decision outcome. */
  ApprovalOutcome: 'approval-outcome',
} as const;

export type FlowStepType = (typeof FlowStepType)[keyof typeof FlowStepType];

// ── Flow Wake Skip Reason ──
/** Why `ctx.flows.wake(executionId)` left an execution as it was (`FlowWakeResult.reason`). */
export const FlowWakeSkipReason = {
  /** Completed, failed or cancelled. */
  Finished: 'finished',
  /** Not in a wait: created, running, or a start still waiting for its transaction to commit. */
  NotWaiting: 'not-waiting',
  /** Waiting, but not on a timer: an event or approval wait, which only `resume` ends. */
  NotTimedWait: 'not-timed-wait',
  /**
   * Waiting out a retry backoff: the engine's own pause before it runs a failed step again.
   * Wake leaves it alone, so waking cannot spend a failing step's remaining attempts at once.
   */
  RetryBackoff: 'retry-backoff',
  /** The timed wait is already due; a worker claims the execution on its next poll. */
  AlreadyDue: 'already-due',
  /** The wait ended or changed between reading the execution and waking it. */
  WaitChanged: 'wait-changed',
} as const;

export type FlowWakeSkipReason = (typeof FlowWakeSkipReason)[keyof typeof FlowWakeSkipReason];

// ── Backoff Strategy ──
export const BackoffStrategy = {
  Exponential: 'exponential',
  Fixed: 'fixed',
} as const;

export type BackoffStrategy = (typeof BackoffStrategy)[keyof typeof BackoffStrategy];

// ── Relation Type ──
export const RelationType = {
  OneToOne: 'one-to-one',
  OneToMany: 'one-to-many',
  ManyToOne: 'many-to-one',
  ManyToMany: 'many-to-many',
} as const;

export type RelationType = (typeof RelationType)[keyof typeof RelationType];

// ── Error Code ──
export const ErrorCode = {
  Validation: 'validation',
  NotFound: 'notFound',
  Forbidden: 'forbidden',
  Conflict: 'conflict',
  Internal: 'internal',
  LeaseLost: 'leaseLost',
  Cancelled: 'cancelled',
  DependencyViolation: 'dependencyViolation',
  Unauthorized: 'unauthorized',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Auth Role (well-known role names) ──
export const AuthRole = {
  /** Flow engine and trusted internal runners; capability must list in access.roles to allow. */
  System: 'system',
} as const;

export type AuthRole = (typeof AuthRole)[keyof typeof AuthRole];

// ── Governance Severity ──
export const GovernanceSeverity = {
  Info: 'info',
  Warning: 'warning',
  High: 'high',
} as const;

export type GovernanceSeverity = (typeof GovernanceSeverity)[keyof typeof GovernanceSeverity];

// ── Policy Profile ──
export const PolicyProfile = {
  PciDss: 'pci_dss',
  Gdpr: 'gdpr',
  Soc2: 'soc2',
  Hipaa: 'hipaa',
  InternalSecurityBaseline: 'internal_security_baseline',
} as const;

export type PolicyProfile = (typeof PolicyProfile)[keyof typeof PolicyProfile];

// ── Rule Evaluation Status ──
export const RuleStatus = {
  Pass: 'pass',
  Partial: 'partial',
  Fail: 'fail',
  Override: 'override',
} as const;

export type RuleStatus = (typeof RuleStatus)[keyof typeof RuleStatus];
