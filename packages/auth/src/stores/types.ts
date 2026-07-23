export interface ProtectedSessionRecord {
  applicationId: string;
  sessionRef: string;
  sessionIdHash: string;
  userLookup: string;
  principalEnvelope: string;
  csrfHash: string;
  schemaVersion: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface SessionStore {
  create(record: ProtectedSessionRecord): Promise<void>;
  /** Postgres implementation runs insert + cap eviction in one transaction. */
  createWithSessionCap?(record: ProtectedSessionRecord, keep: number): Promise<number>;
  getByIdHash(q: {
    applicationId: string;
    sessionIdHash: string;
  }): Promise<ProtectedSessionRecord | null>;
  deleteByIdHash(q: { applicationId: string; sessionIdHash: string }): Promise<boolean>;
  deleteForUser(q: { applicationId: string; userLookup: string }): Promise<number>;
  countForUser(q: { applicationId: string; userLookup: string }): Promise<number>;
  evictOldestForUser(q: {
    applicationId: string;
    userLookup: string;
    keep: number;
  }): Promise<number>;
  deleteExpired(now: Date): Promise<number>;
}

export interface ProtectedLoginTransaction {
  applicationId: string;
  stateHash: string;
  browserBindingHash: string;
  providerId: string;
  payloadEnvelope: string;
  schemaVersion: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface ConsumedLoginTransaction extends ProtectedLoginTransaction {}

export interface LoginTransactionStore {
  create(record: ProtectedLoginTransaction): Promise<void>;
  consume(q: {
    applicationId: string;
    stateHash: string;
    browserBindingHash: string;
    providerId: string;
    now: Date;
  }): Promise<ConsumedLoginTransaction | null>;
  countForBinding(q: { applicationId: string; browserBindingHash: string }): Promise<number>;
  evictOldestForBinding(q: {
    applicationId: string;
    browserBindingHash: string;
    keep: number;
  }): Promise<number>;
  deleteExpired(now: Date): Promise<number>;
}
