import {
  CreateUserPoolClientCommand,
  type CreateUserPoolClientCommandOutput,
  CreateUserPoolCommand,
  type CreateUserPoolCommandOutput,
  DeleteUserPoolCommand,
  DescribeUserPoolClientCommand,
  type DescribeUserPoolClientCommandOutput,
  DescribeUserPoolCommand,
  type DescribeUserPoolCommandOutput,
  GetUserPoolMfaConfigCommand,
  type GetUserPoolMfaConfigCommandOutput,
  ListUserPoolClientsCommand,
  type ListUserPoolClientsCommandOutput,
  ListUserPoolsCommand,
  type ListUserPoolsCommandOutput,
  UpdateUserPoolClientCommand,
  UpdateUserPoolCommand,
  type UpdateUserPoolCommandInput,
  type UserPoolClientType,
  type UserPoolType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  assertUserPoolId,
  type CognitoConnectionOptions,
  cognitoUserPoolIssuer,
  openCognitoConnection,
} from './connection.js';
import { CognitoServerError, CognitoServerErrorReason } from './errors.js';

/** What an attested user pool is: who owns it, and which trigger gates its sign-ins. */
export interface AttestedUserPoolSpec {
  /** Deterministic pool name; the pool is found by it. */
  name: string;
  /** Ownership tags. At least one; a same-named pool without all of them is never adopted. */
  tags: Readonly<Record<string, string>>;
  /** ARN of the Lambda running `createAttestedSignInTrigger`, attached as all three triggers. */
  triggerArn: string;
  /** App client name. Default: the pool name. */
  clientName?: string;
  /**
   * When a same-named app client already exists with weaker security settings than the ones
   * this package creates (other auth flows, no token revocation, user-existence errors, longer
   * token lifetimes), rewrite it to those settings. Default `true` (since 0.4). Rewriting
   * replaces every client setting, including any callback URLs or OAuth settings added by
   * hand; pass `false` to only report the drift (warning + `clientDrift`) instead. A client
   * secret cannot be removed by an update; that drift is always only reported.
   */
  reconcileClient?: boolean;
}

export interface EnsuredAttestedUserPool {
  userPoolId: string;
  clientId: string;
  issuer: string;
  /** True when this call created the pool. */
  created: boolean;
  /**
   * Present only when an existing app client's security settings differ from the attested ones:
   * one entry per setting. Unless `reconcileClient: false`, the fixable ones were rewritten.
   */
  clientDrift?: string[];
}

/** Options for {@link createCognitoPoolAdministration}. */
export interface CognitoPoolAdministrationOptions extends CognitoConnectionOptions {
  /** Receives drift warnings. Default: `console.warn`. */
  logger?: { warn(message: string): void };
}

/** A pool's MFA policy as Cognito reports it. */
export interface CognitoMfaPolicy {
  mfa: 'ON' | 'OFF' | 'OPTIONAL';
  softwareToken: boolean;
  sms: boolean;
  email: boolean;
}

export interface CognitoPoolAdministration {
  /**
   * Finds the pool by name and ownership tags, or creates it; reconciles its security settings
   * and triggers if they drifted; and ensures its secretless custom-auth app client. Idempotent,
   * but not safe to run concurrently for one name: pool names are not unique in Cognito, so two
   * simultaneous calls can create two pools (every later call then fails with `pool-conflict`).
   * Call it from one provisioning step or job, never from start-up code every replica runs.
   */
  ensureAttestedUserPool(spec: AttestedUserPoolSpec): Promise<EnsuredAttestedUserPool>;
  /**
   * Turns deletion protection off and deletes the pool, only if it carries every expected tag.
   * Idempotent: an absent pool answers `{ deleted: false }`.
   */
  deleteUserPool(input: {
    userPoolId: string;
    tags: Readonly<Record<string, string>>;
  }): Promise<{ deleted: boolean }>;
  readMfaPolicy(userPoolId: string): Promise<CognitoMfaPolicy>;
  issuerFor(userPoolId: string): string;
}

const TOKEN_MINUTES = {
  AccessToken: 'minutes',
  IdToken: 'minutes',
  RefreshToken: 'minutes',
} as const;

/** The settings every attested pool has, in the shape `UpdateUserPool` accepts. */
function attestedPoolSettings(spec: AttestedUserPoolSpec) {
  return {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only' as const, Priority: 1 }] },
    DeletionProtection: 'ACTIVE' as const,
    MfaConfiguration: 'OFF' as const,
    LambdaConfig: {
      DefineAuthChallenge: spec.triggerArn,
      CreateAuthChallenge: spec.triggerArn,
      VerifyAuthChallengeResponse: spec.triggerArn,
    },
    Policies: {
      PasswordPolicy: {
        MinimumLength: 64,
        RequireUppercase: true,
        RequireLowercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
      },
    },
    UserPoolTags: { ...spec.tags },
  };
}

function ownedBy(pool: UserPoolType | undefined, tags: Readonly<Record<string, string>>): boolean {
  const actual = pool?.UserPoolTags ?? {};
  return Object.entries(tags).every(([key, value]) => actual[key] === value);
}

function drifted(pool: UserPoolType, spec: AttestedUserPoolSpec): boolean {
  const lambda = pool.LambdaConfig ?? {};
  const recovery = pool.AccountRecoverySetting?.RecoveryMechanisms ?? [];
  return (
    lambda.DefineAuthChallenge !== spec.triggerArn ||
    lambda.CreateAuthChallenge !== spec.triggerArn ||
    lambda.VerifyAuthChallengeResponse !== spec.triggerArn ||
    pool.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true ||
    recovery.length !== 1 ||
    recovery[0]?.Name !== 'admin_only'
  );
}

/** The app client settings every attested pool's client has (create and reconcile). */
function attestedClientSettings(clientName: string) {
  return {
    ClientName: clientName,
    ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH' as const, 'ALLOW_REFRESH_TOKEN_AUTH' as const],
    EnableTokenRevocation: true,
    PreventUserExistenceErrors: 'ENABLED' as const,
    AccessTokenValidity: 5,
    IdTokenValidity: 5,
    RefreshTokenValidity: 60,
    TokenValidityUnits: { ...TOKEN_MINUTES },
    ReadAttributes: ['email', 'email_verified'],
    WriteAttributes: [],
  };
}

const UNIT_MINUTES: Record<string, number> = { seconds: 1 / 60, minutes: 1, hours: 60, days: 1440 };

/** Cognito's defaults when a client omits a validity or its unit. */
function validityMinutes(
  value: number | undefined,
  unit: string | undefined,
  defaultValue: number,
  defaultUnit: string,
): number {
  return (value ?? defaultValue) * (UNIT_MINUTES[unit ?? defaultUnit] ?? 1);
}

/** Lists the ways an existing client is weaker than the attested settings. */
export function attestedClientDrift(client: UserPoolClientType): string[] {
  const drift: string[] = [];
  if (client.ClientSecret)
    drift.push('client has a secret (cannot be removed; recreate the client)');
  const flows = [...(client.ExplicitAuthFlows ?? [])].sort();
  if (flows.join(',') !== 'ALLOW_CUSTOM_AUTH,ALLOW_REFRESH_TOKEN_AUTH') {
    drift.push(`auth flows are ${flows.join(', ') || 'none'}`);
  }
  if (client.EnableTokenRevocation !== true) drift.push('token revocation is off');
  if (client.PreventUserExistenceErrors !== 'ENABLED')
    drift.push('user-existence errors are not prevented');
  const units = client.TokenValidityUnits ?? {};
  if (validityMinutes(client.AccessTokenValidity, units.AccessToken, 60, 'minutes') > 5) {
    drift.push('access tokens live longer than 5 minutes');
  }
  if (validityMinutes(client.IdTokenValidity, units.IdToken, 60, 'minutes') > 5) {
    drift.push('ID tokens live longer than 5 minutes');
  }
  if (validityMinutes(client.RefreshTokenValidity, units.RefreshToken, 30, 'days') > 60) {
    drift.push('refresh tokens live longer than 60 minutes');
  }
  return drift;
}

function assertSpec(spec: AttestedUserPoolSpec): void {
  if (!spec.name || spec.name.length > 128)
    throw new TypeError('pool name must be 1-128 characters');
  if (Object.keys(spec.tags).length === 0)
    throw new TypeError('at least one ownership tag is required');
  if (!spec.triggerArn.startsWith('arn:')) throw new TypeError('triggerArn must be a Lambda ARN');
}

/** Creates, reconciles and deletes attested user pools. Needs pool-administration IAM rights. */
export function createCognitoPoolAdministration(
  options: CognitoPoolAdministrationOptions,
): CognitoPoolAdministration {
  const { send } = openCognitoConnection(options);
  const warn = (message: string) =>
    options.logger ? options.logger.warn(message) : console.warn(`[plumbus] ${message}`);
  const issuerFor = (userPoolId: string) =>
    cognitoUserPoolIssuer(userPoolId, { endpoint: options.endpoint });

  async function describe(userPoolId: string): Promise<UserPoolType | null> {
    try {
      const output = await send<DescribeUserPoolCommandOutput>(
        new DescribeUserPoolCommand({ UserPoolId: userPoolId }),
      );
      return output.UserPool ?? null;
    } catch (error) {
      if (
        error instanceof CognitoServerError &&
        error.reason === CognitoServerErrorReason.poolNotFound
      ) {
        return null;
      }
      throw error;
    }
  }

  async function poolIdsNamed(name: string): Promise<string[]> {
    const ids: string[] = [];
    let next: string | undefined;
    do {
      const page = await send<ListUserPoolsCommandOutput>(
        new ListUserPoolsCommand({ MaxResults: 60, ...(next ? { NextToken: next } : {}) }),
      );
      for (const pool of page.UserPools ?? []) {
        if (pool.Name === name && pool.Id) ids.push(pool.Id);
      }
      next = page.NextToken;
    } while (next);
    return ids;
  }

  async function findOwnedPool(spec: AttestedUserPoolSpec): Promise<UserPoolType | null> {
    const pools = await Promise.all((await poolIdsNamed(spec.name)).map(describe));
    const present = pools.filter((pool): pool is UserPoolType => pool !== null);
    if (present.length === 0) return null;
    const owned = present.filter((pool) => ownedBy(pool, spec.tags));
    if (owned.length !== 1 || present.length !== 1) {
      throw new CognitoServerError(
        CognitoServerErrorReason.poolConflict,
        `user pool name ${spec.name} is ambiguous or not owned by the caller`,
      );
    }
    return owned[0] ?? null;
  }

  /** Reports (and with `reconcile`, rewrites) an existing client's security drift. */
  async function checkClient(
    userPoolId: string,
    clientId: string,
    clientName: string,
    reconcile: boolean,
  ): Promise<string[]> {
    const output = await send<DescribeUserPoolClientCommandOutput>(
      new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
    );
    const drift = output.UserPoolClient ? attestedClientDrift(output.UserPoolClient) : [];
    if (drift.length === 0) return drift;
    const fixable = drift.some((entry) => !entry.startsWith('client has a secret'));
    if (reconcile && fixable) {
      await send(
        new UpdateUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientId: clientId,
          ...attestedClientSettings(clientName),
        }),
      );
      warn(
        `Cognito app client ${clientName} (${clientId}) in ${userPoolId} had weaker security settings and was reconciled: ${drift.join('; ')}.`,
      );
    } else {
      warn(
        `Cognito app client ${clientName} (${clientId}) in ${userPoolId} has weaker security settings than @plumbus/auth-cognito creates: ${drift.join('; ')}. ${reconcile ? 'A client secret cannot be removed by an update; recreate the client under a new name.' : 'It was not rewritten because reconcileClient: false was passed to ensureAttestedUserPool; remove that to rewrite it (this replaces every client setting), or fix it in Cognito.'}`,
      );
    }
    return drift;
  }

  async function ensureClient(
    userPoolId: string,
    clientName: string,
    reconcile: boolean,
  ): Promise<{ clientId: string; drift: string[] }> {
    let next: string | undefined;
    do {
      const page = await send<ListUserPoolClientsCommandOutput>(
        new ListUserPoolClientsCommand({
          UserPoolId: userPoolId,
          MaxResults: 60,
          ...(next ? { NextToken: next } : {}),
        }),
      );
      const found = page.UserPoolClients?.find((client) => client.ClientName === clientName);
      if (found?.ClientId) {
        const drift = await checkClient(userPoolId, found.ClientId, clientName, reconcile);
        return { clientId: found.ClientId, drift };
      }
      next = page.NextToken;
    } while (next);
    const created = await send<CreateUserPoolClientCommandOutput>(
      new CreateUserPoolClientCommand({
        UserPoolId: userPoolId,
        GenerateSecret: false,
        ...attestedClientSettings(clientName),
      }),
    );
    const clientId = created.UserPoolClient?.ClientId;
    if (!clientId) {
      throw new CognitoServerError(
        CognitoServerErrorReason.requestRefused,
        'Cognito created an app client without an id',
      );
    }
    return { clientId, drift: [] };
  }

  async function ensureAttestedUserPool(
    spec: AttestedUserPoolSpec,
  ): Promise<EnsuredAttestedUserPool> {
    assertSpec(spec);
    const settings = attestedPoolSettings(spec);
    let pool = await findOwnedPool(spec);
    let created = false;
    if (!pool) {
      const output = await send<CreateUserPoolCommandOutput>(
        new CreateUserPoolCommand({
          PoolName: spec.name,
          UsernameConfiguration: { CaseSensitive: false },
          ...settings,
        }),
      );
      pool = output.UserPool ?? null;
      created = true;
    } else if (drifted(pool, spec)) {
      const update: UpdateUserPoolCommandInput = { UserPoolId: pool.Id, ...settings };
      await send(new UpdateUserPoolCommand(update));
    }
    const userPoolId = pool?.Id;
    if (!userPoolId) {
      throw new CognitoServerError(
        CognitoServerErrorReason.requestRefused,
        'Cognito created a user pool without an id',
      );
    }
    const { clientId, drift } = await ensureClient(
      userPoolId,
      spec.clientName ?? spec.name,
      spec.reconcileClient !== false,
    );
    return {
      userPoolId,
      clientId,
      issuer: issuerFor(userPoolId),
      created,
      ...(drift.length > 0 ? { clientDrift: drift } : {}),
    };
  }

  async function deleteUserPool(input: {
    userPoolId: string;
    tags: Readonly<Record<string, string>>;
  }): Promise<{ deleted: boolean }> {
    assertUserPoolId(input.userPoolId);
    if (Object.keys(input.tags).length === 0) {
      throw new TypeError('at least one ownership tag is required');
    }
    const pool = await describe(input.userPoolId);
    if (!pool) return { deleted: false };
    if (!ownedBy(pool, input.tags)) {
      throw new CognitoServerError(
        CognitoServerErrorReason.poolConflict,
        `user pool ${input.userPoolId} is not owned by the caller`,
      );
    }
    if (pool.DeletionProtection === 'ACTIVE') {
      // UpdateUserPool resets every omitted setting, so restate the security-relevant ones: a
      // failed delete must not leave behind a pool that suddenly allows self sign-up.
      await send(
        new UpdateUserPoolCommand({
          UserPoolId: input.userPoolId,
          DeletionProtection: 'INACTIVE',
          ...(pool.AdminCreateUserConfig
            ? { AdminCreateUserConfig: pool.AdminCreateUserConfig }
            : {}),
          ...(pool.AccountRecoverySetting
            ? { AccountRecoverySetting: pool.AccountRecoverySetting }
            : {}),
          ...(pool.LambdaConfig ? { LambdaConfig: pool.LambdaConfig } : {}),
          ...(pool.Policies ? { Policies: pool.Policies } : {}),
          ...(pool.MfaConfiguration ? { MfaConfiguration: pool.MfaConfiguration } : {}),
          ...(pool.UserPoolTags ? { UserPoolTags: pool.UserPoolTags } : {}),
        }),
      );
    }
    try {
      await send(new DeleteUserPoolCommand({ UserPoolId: input.userPoolId }));
    } catch (error) {
      if (
        error instanceof CognitoServerError &&
        error.reason === CognitoServerErrorReason.poolNotFound
      ) {
        return { deleted: false };
      }
      throw error;
    }
    return { deleted: true };
  }

  async function readMfaPolicy(userPoolId: string): Promise<CognitoMfaPolicy> {
    assertUserPoolId(userPoolId);
    const output = await send<GetUserPoolMfaConfigCommandOutput>(
      new GetUserPoolMfaConfigCommand({ UserPoolId: userPoolId }),
    );
    const mfa = output.MfaConfiguration;
    return {
      mfa: mfa === 'ON' || mfa === 'OPTIONAL' ? mfa : 'OFF',
      softwareToken: output.SoftwareTokenMfaConfiguration?.Enabled === true,
      sms: output.SmsMfaConfiguration?.SmsConfiguration !== undefined,
      email: output.EmailMfaConfiguration !== undefined,
    };
  }

  return Object.freeze({ ensureAttestedUserPool, deleteUserPool, readMfaPolicy, issuerFor });
}
