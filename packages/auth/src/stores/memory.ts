import type {
  ConsumedLoginTransaction,
  LoginTransactionStore,
  ProtectedLoginTransaction,
  ProtectedSessionRecord,
  SessionStore,
} from './types.js';

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, ProtectedSessionRecord>();

  function key(applicationId: string, sessionIdHash: string): string {
    return `${applicationId}:${sessionIdHash}`;
  }

  return {
    async create(record) {
      sessions.set(key(record.applicationId, record.sessionIdHash), { ...record });
    },
    async getByIdHash(q) {
      return sessions.get(key(q.applicationId, q.sessionIdHash)) ?? null;
    },
    async deleteByIdHash(q) {
      return sessions.delete(key(q.applicationId, q.sessionIdHash));
    },
    async deleteForUser(q) {
      let deleted = 0;
      for (const [mapKey, record] of sessions.entries()) {
        if (record.applicationId === q.applicationId && record.userLookup === q.userLookup) {
          sessions.delete(mapKey);
          deleted += 1;
        }
      }
      return deleted;
    },
    async countForUser(q) {
      let count = 0;
      for (const record of sessions.values()) {
        if (record.applicationId === q.applicationId && record.userLookup === q.userLookup) {
          count += 1;
        }
      }
      return count;
    },
    async evictOldestForUser(q) {
      const rows = [...sessions.values()]
        .filter(
          (record) =>
            record.applicationId === q.applicationId && record.userLookup === q.userLookup,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const toDelete = rows.slice(0, Math.max(0, rows.length - q.keep));
      for (const record of toDelete) {
        sessions.delete(key(record.applicationId, record.sessionIdHash));
      }
      return toDelete.length;
    },
    async deleteExpired(now) {
      let deleted = 0;
      for (const [mapKey, record] of sessions.entries()) {
        if (now >= record.expiresAt) {
          sessions.delete(mapKey);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

export function createMemoryLoginTransactionStore(): LoginTransactionStore {
  const transactions = new Map<string, ProtectedLoginTransaction>();

  function key(applicationId: string, stateHash: string): string {
    return `${applicationId}:${stateHash}`;
  }

  return {
    async create(record) {
      transactions.set(key(record.applicationId, record.stateHash), { ...record });
    },
    async consume(q) {
      const mapKey = key(q.applicationId, q.stateHash);
      const record = transactions.get(mapKey);
      if (!record) return null;
      if (record.providerId !== q.providerId) return null;
      if (record.browserBindingHash !== q.browserBindingHash) return null;
      if (q.now >= record.expiresAt) {
        transactions.delete(mapKey);
        return null;
      }
      transactions.delete(mapKey);
      return record as ConsumedLoginTransaction;
    },
    async countForBinding(q) {
      let count = 0;
      for (const record of transactions.values()) {
        if (
          record.applicationId === q.applicationId &&
          record.browserBindingHash === q.browserBindingHash
        ) {
          count += 1;
        }
      }
      return count;
    },
    async evictOldestForBinding(q) {
      const rows = [...transactions.values()]
        .filter(
          (record) =>
            record.applicationId === q.applicationId &&
            record.browserBindingHash === q.browserBindingHash,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const toDelete = rows.slice(0, Math.max(0, rows.length - q.keep));
      for (const record of toDelete) {
        transactions.delete(key(record.applicationId, record.stateHash));
      }
      return toDelete.length;
    },
    async deleteExpired(now) {
      let deleted = 0;
      for (const [mapKey, record] of transactions.entries()) {
        if (now >= record.expiresAt) {
          transactions.delete(mapKey);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}
