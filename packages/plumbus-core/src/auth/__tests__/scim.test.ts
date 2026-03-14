import { describe, expect, it, vi } from 'vitest';
import { createScimService, type ScimUser, type ScimUserRepository } from '../scim.js';

function createMockRepo(initial: ScimUser[] = []): ScimUserRepository {
  const store = new Map<string, ScimUser>();
  let nextId = 1;
  for (const u of initial) {
    const id = u.id ?? String(nextId++);
    store.set(id, { ...u, id });
  }

  return {
    create: vi.fn(async (user) => {
      const id = String(nextId++);
      const record = { ...user, id };
      store.set(id, record);
      return record;
    }),
    findById: vi.fn(async (id) => store.get(id) ?? null),
    findByExternalId: vi.fn(async (externalId) => {
      for (const u of store.values()) {
        if (u.externalId === externalId) return u;
      }
      return null;
    }),
    findByUserName: vi.fn(async (userName) => {
      for (const u of store.values()) {
        if (u.userName === userName) return u;
      }
      return null;
    }),
    update: vi.fn(async (id, updates) => {
      const existing = store.get(id);
      if (!existing) throw new Error('not found');
      const updated = { ...existing, ...updates };
      store.set(id, updated);
      return updated;
    }),
    deactivate: vi.fn(async (id) => {
      const existing = store.get(id);
      if (existing) {
        store.set(id, { ...existing, active: false });
      }
    }),
    list: vi.fn(async (startIndex, count) => {
      const all = [...store.values()];
      const start = startIndex - 1; // SCIM is 1-indexed
      return { users: all.slice(start, start + count), total: all.length };
    }),
  };
}

const AUTH = 'Bearer scim-secret-token';
const BASE_URL = 'https://app.example.com/scim/v2';

function createService(initial: ScimUser[] = []) {
  const repo = createMockRepo(initial);
  const service = createScimService({ bearerToken: 'scim-secret-token', baseUrl: BASE_URL }, repo);
  return { service, repo };
}

describe('SCIM Service', () => {
  describe('authentication', () => {
    it('rejects requests without auth header', async () => {
      const { service } = createService();
      const result = await service.createUser(undefined, { userName: 'test@example.com' });
      expect(result.status).toBe(401);
    });

    it('rejects requests with wrong token', async () => {
      const { service } = createService();
      const result = await service.createUser('Bearer wrong-token', {
        userName: 'test@example.com',
      });
      expect(result.status).toBe(401);
    });

    it('rejects non-Bearer auth', async () => {
      const { service } = createService();
      const result = await service.createUser('Basic dXNlcjpwYXNz', {
        userName: 'test@example.com',
      });
      expect(result.status).toBe(401);
    });
  });

  describe('createUser', () => {
    it('creates a user and returns 201 with SCIM resource', async () => {
      const { service } = createService();
      const result = await service.createUser(AUTH, {
        externalId: 'ext-1',
        userName: 'alice@example.com',
        displayName: 'Alice',
        emails: [{ value: 'alice@example.com', primary: true }],
      });

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        externalId: 'ext-1',
        userName: 'alice@example.com',
        displayName: 'Alice',
        active: true,
        meta: { resourceType: 'User' },
      });
    });

    it('rejects duplicate externalId', async () => {
      const { service } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.createUser(AUTH, {
        externalId: 'ext-1',
        userName: 'bob@example.com',
      });
      expect(result.status).toBe(409);
    });

    it('rejects missing userName', async () => {
      const { service } = createService();
      const result = await service.createUser(AUTH, { externalId: 'ext-1' });
      expect(result.status).toBe(400);
    });

    it('defaults displayName to userName when not provided', async () => {
      const { service } = createService();
      const result = await service.createUser(AUTH, {
        externalId: 'ext-2',
        userName: 'bob@example.com',
      });
      expect(result.status).toBe(201);
      if ('displayName' in result.body) {
        expect(result.body.displayName).toBe('bob@example.com');
      }
    });
  });

  describe('getUser', () => {
    it('returns user by ID', async () => {
      const { service } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.getUser(AUTH, '1');
      expect(result.status).toBe(200);
      if ('userName' in result.body) {
        expect(result.body.userName).toBe('alice@example.com');
      }
    });

    it('returns 404 for missing user', async () => {
      const { service } = createService();
      const result = await service.getUser(AUTH, 'nonexistent');
      expect(result.status).toBe(404);
    });
  });

  describe('replaceUser', () => {
    it('updates all fields and returns 200', async () => {
      const { service } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.replaceUser(AUTH, '1', {
        externalId: 'ext-1',
        userName: 'alice-new@example.com',
        displayName: 'Alice New',
        emails: [{ value: 'alice-new@example.com', primary: true }],
        active: true,
      });
      expect(result.status).toBe(200);
      if ('userName' in result.body) {
        expect(result.body.userName).toBe('alice-new@example.com');
        expect(result.body.displayName).toBe('Alice New');
      }
    });

    it('returns 404 for missing user', async () => {
      const { service } = createService();
      const result = await service.replaceUser(AUTH, 'nonexistent', { userName: 'test' });
      expect(result.status).toBe(404);
    });
  });

  describe('patchUser', () => {
    it('deactivates user via SCIM PATCH replace', async () => {
      const { service } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.patchUser(AUTH, '1', {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      });
      expect(result.status).toBe(200);
      if ('active' in result.body) {
        expect(result.body.active).toBe(false);
      }
    });

    it('updates displayName via PATCH', async () => {
      const { service } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.patchUser(AUTH, '1', {
        Operations: [{ op: 'replace', path: 'displayName', value: 'Alice Updated' }],
      });
      expect(result.status).toBe(200);
      if ('displayName' in result.body) {
        expect(result.body.displayName).toBe('Alice Updated');
      }
    });

    it('rejects missing Operations array', async () => {
      const { service } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.patchUser(AUTH, '1', {});
      expect(result.status).toBe(400);
    });

    it('returns 404 for missing user', async () => {
      const { service } = createService();
      const result = await service.patchUser(AUTH, 'nonexistent', {
        Operations: [{ op: 'replace', path: 'active', value: false }],
      });
      expect(result.status).toBe(404);
    });
  });

  describe('deleteUser', () => {
    it('deactivates user and returns 204', async () => {
      const { service, repo } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.deleteUser(AUTH, '1');
      expect(result.status).toBe(204);
      expect(result.body).toBeUndefined();
      expect(repo.deactivate).toHaveBeenCalledWith('1');
    });

    it('returns 404 for missing user', async () => {
      const { service } = createService();
      const result = await service.deleteUser(AUTH, 'nonexistent');
      expect(result.status).toBe(404);
    });
  });

  describe('listUsers', () => {
    it('returns paginated user list', async () => {
      const { service } = createService([
        {
          externalId: 'ext-1',
          userName: 'alice@example.com',
          displayName: 'Alice',
          emails: [],
          active: true,
        },
        {
          externalId: 'ext-2',
          userName: 'bob@example.com',
          displayName: 'Bob',
          emails: [],
          active: true,
        },
      ]);
      const result = await service.listUsers(AUTH, { startIndex: 1, count: 10 });
      expect(result.status).toBe(200);
      if ('totalResults' in result.body) {
        expect(result.body.totalResults).toBe(2);
        expect(result.body.Resources).toHaveLength(2);
        expect(result.body.startIndex).toBe(1);
      }
    });

    it('caps count at 200', async () => {
      const { service, repo } = createService();
      await service.listUsers(AUTH, { count: 500 });
      expect(repo.list).toHaveBeenCalledWith(1, 200);
    });

    it('defaults startIndex to 1 and count to 100', async () => {
      const { service, repo } = createService();
      await service.listUsers(AUTH, {});
      expect(repo.list).toHaveBeenCalledWith(1, 100);
    });
  });
});
