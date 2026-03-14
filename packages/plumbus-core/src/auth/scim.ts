// ── SCIM 2.0 Service ──
// Implements the core SCIM 2.0 user provisioning protocol.
// Apps provide a repository adapter; the framework handles SCIM schema mapping,
// filtering, and response formatting.

export interface ScimServiceConfig {
  /** Bearer token for authenticating SCIM requests from the IdP */
  bearerToken: string;
  /** Base URL for SCIM resource locations (e.g., https://app.example.com/scim/v2) */
  baseUrl: string;
}

export interface ScimUser {
  /** Internal user ID (set by the application, not the IdP) */
  id?: string;
  /** IdP-assigned external identifier */
  externalId: string;
  /** Username (typically email) */
  userName: string;
  /** Display name */
  displayName: string;
  /** Email addresses */
  emails: ScimEmail[];
  /** Active status */
  active: boolean;
  /** Group memberships (optional) */
  groups?: string[];
}

export interface ScimEmail {
  value: string;
  primary?: boolean;
  type?: string;
}

export interface ScimListResponse {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ScimUserResource[];
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId: string;
  userName: string;
  displayName: string;
  emails: ScimEmail[];
  active: boolean;
  groups?: { value: string; display?: string }[];
  meta: {
    resourceType: string;
    location: string;
    created?: string;
    lastModified?: string;
  };
}

export interface ScimError {
  schemas: string[];
  status: string;
  detail: string;
}

/**
 * Repository interface that apps implement to connect SCIM to their data layer.
 */
export interface ScimUserRepository {
  create(user: Omit<ScimUser, 'id'>): Promise<ScimUser & { id: string }>;
  findById(id: string): Promise<ScimUser | null>;
  findByExternalId(externalId: string): Promise<ScimUser | null>;
  findByUserName(userName: string): Promise<ScimUser | null>;
  update(id: string, updates: Partial<Omit<ScimUser, 'id'>>): Promise<ScimUser>;
  deactivate(id: string): Promise<void>;
  list(startIndex: number, count: number): Promise<{ users: ScimUser[]; total: number }>;
}

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * Create a SCIM 2.0 service that handles user provisioning operations.
 * The service validates the bearer token, processes SCIM requests, and
 * delegates to the provided repository.
 */
export function createScimService(config: ScimServiceConfig, repository: ScimUserRepository) {
  function authenticateRequest(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader) return false;
    if (!authorizationHeader.startsWith('Bearer ')) return false;
    return authorizationHeader.slice(7) === config.bearerToken;
  }

  function toScimResource(user: ScimUser): ScimUserResource {
    return {
      schemas: [SCIM_USER_SCHEMA],
      id: user.id ?? '',
      externalId: user.externalId,
      userName: user.userName,
      displayName: user.displayName,
      emails: user.emails,
      active: user.active,
      groups: user.groups?.map((g) => ({ value: g })),
      meta: {
        resourceType: 'User',
        location: `${config.baseUrl}/Users/${user.id ?? ''}`,
      },
    };
  }

  function scimError(status: number, detail: string): { status: number; body: ScimError } {
    return {
      status,
      body: {
        schemas: [SCIM_ERROR_SCHEMA],
        status: String(status),
        detail,
      },
    };
  }

  return {
    /**
     * Validate the SCIM bearer token.
     * Returns true if the request is authorized.
     */
    authenticateRequest,

    /**
     * POST /Users — Create a new user.
     */
    async createUser(
      authHeader: string | undefined,
      body: Record<string, unknown>,
    ): Promise<{ status: number; body: ScimUserResource | ScimError }> {
      if (!authenticateRequest(authHeader)) {
        return scimError(401, 'Unauthorized');
      }

      const externalId = String(body.externalId ?? '');
      const userName = String(body.userName ?? '');
      const displayName = String(body.displayName ?? '');
      const active = body.active !== false;

      if (!userName) {
        return scimError(400, 'userName is required');
      }

      // Check for duplicate
      const existing = await repository.findByExternalId(externalId);
      if (existing) {
        return scimError(409, 'User already exists');
      }

      const emails = parseEmails(body.emails);

      const user = await repository.create({
        externalId,
        userName,
        displayName: displayName || userName,
        emails,
        active,
      });

      return { status: 201, body: toScimResource(user) };
    },

    /**
     * GET /Users/:id — Get a user by ID.
     */
    async getUser(
      authHeader: string | undefined,
      id: string,
    ): Promise<{ status: number; body: ScimUserResource | ScimError }> {
      if (!authenticateRequest(authHeader)) {
        return scimError(401, 'Unauthorized');
      }

      const user = await repository.findById(id);
      if (!user) {
        return scimError(404, 'User not found');
      }

      return { status: 200, body: toScimResource(user) };
    },

    /**
     * PUT /Users/:id — Replace a user.
     */
    async replaceUser(
      authHeader: string | undefined,
      id: string,
      body: Record<string, unknown>,
    ): Promise<{ status: number; body: ScimUserResource | ScimError }> {
      if (!authenticateRequest(authHeader)) {
        return scimError(401, 'Unauthorized');
      }

      const existing = await repository.findById(id);
      if (!existing) {
        return scimError(404, 'User not found');
      }

      const updated = await repository.update(id, {
        externalId: String(body.externalId ?? existing.externalId),
        userName: String(body.userName ?? existing.userName),
        displayName: String(body.displayName ?? existing.displayName),
        emails: parseEmails(body.emails) ?? existing.emails,
        active: body.active !== undefined ? body.active !== false : existing.active,
      });

      return { status: 200, body: toScimResource(updated) };
    },

    /**
     * PATCH /Users/:id — Update specific user fields.
     * Supports the standard SCIM PATCH 'replace' operation.
     */
    async patchUser(
      authHeader: string | undefined,
      id: string,
      body: Record<string, unknown>,
    ): Promise<{ status: number; body: ScimUserResource | ScimError }> {
      if (!authenticateRequest(authHeader)) {
        return scimError(401, 'Unauthorized');
      }

      const existing = await repository.findById(id);
      if (!existing) {
        return scimError(404, 'User not found');
      }

      const operations = body.Operations as
        | Array<{ op: string; path?: string; value?: unknown }>
        | undefined;
      if (!operations || !Array.isArray(operations)) {
        return scimError(400, 'Operations array is required');
      }

      const updates: Partial<Omit<ScimUser, 'id'>> = {};

      for (const op of operations) {
        if (op.op !== 'replace') continue;

        if (
          op.path === 'active' ||
          (!op.path && typeof op.value === 'object' && op.value !== null && 'active' in op.value)
        ) {
          const active =
            op.path === 'active' ? op.value : (op.value as Record<string, unknown>).active;
          updates.active = active !== false;

          // Deactivation
          if (updates.active === false) {
            await repository.deactivate(id);
            const deactivated = await repository.findById(id);
            return {
              status: 200,
              body: toScimResource(deactivated ?? { ...existing, active: false }),
            };
          }
        }

        if (op.path === 'displayName') {
          updates.displayName = String(op.value);
        }

        if (op.path === 'userName') {
          updates.userName = String(op.value);
        }
      }

      const updated = await repository.update(id, updates);
      return { status: 200, body: toScimResource(updated) };
    },

    /**
     * DELETE /Users/:id — Deactivate a user.
     */
    async deleteUser(
      authHeader: string | undefined,
      id: string,
    ): Promise<{ status: number; body?: ScimError }> {
      if (!authenticateRequest(authHeader)) {
        return scimError(401, 'Unauthorized');
      }

      const existing = await repository.findById(id);
      if (!existing) {
        return scimError(404, 'User not found');
      }

      await repository.deactivate(id);
      return { status: 204 };
    },

    /**
     * GET /Users — List/search users.
     */
    async listUsers(
      authHeader: string | undefined,
      params: { startIndex?: number; count?: number },
    ): Promise<{ status: number; body: ScimListResponse | ScimError }> {
      if (!authenticateRequest(authHeader)) {
        return scimError(401, 'Unauthorized') as { status: number; body: ScimError };
      }

      const startIndex = params.startIndex ?? 1;
      const count = Math.min(params.count ?? 100, 200);

      const { users, total } = await repository.list(startIndex, count);

      return {
        status: 200,
        body: {
          schemas: [SCIM_LIST_SCHEMA],
          totalResults: total,
          startIndex,
          itemsPerPage: users.length,
          Resources: users.map(toScimResource),
        },
      };
    },
  };
}

function parseEmails(raw: unknown): ScimEmail[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      value: String(e.value ?? ''),
      primary: e.primary === true,
      type: e.type ? String(e.type) : undefined,
    }));
}

export type ScimService = ReturnType<typeof createScimService>;
