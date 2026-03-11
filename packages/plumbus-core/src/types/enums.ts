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
} as const;

export type FlowStepType = (typeof FlowStepType)[keyof typeof FlowStepType];

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
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

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
