import {
  CreateUserPoolClientCommand,
  type CreateUserPoolClientCommandOutput,
  CreateUserPoolCommand,
  type CreateUserPoolCommandOutput,
  DeleteUserPoolCommand,
  DescribeUserPoolCommand,
  type DescribeUserPoolCommandOutput,
  GetUserPoolMfaConfigCommand,
  type GetUserPoolMfaConfigCommandOutput,
  ListUserPoolClientsCommand,
  type ListUserPoolClientsCommandOutput,
  ListUserPoolsCommand,
  type ListUserPoolsCommandOutput,
  type UpdateUserPoolCommandInput,
  UpdateUserPoolCommand,
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
}

export interface EnsuredAttestedUserPool {
  userPoolId: string;
  clientId: string;
  issuer: string;
  /** True when this call created the pool. */
  created: boolean;
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
   * and triggers if they drifted; and ensures its secretless custom-auth app client. Idempotent.
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

function assertSpec(spec: AttestedUserPoolSpec): void {
  if (!spec.name || spec.name.length > 128)
    throw new TypeError('pool name must be 1-128 characters');
  if (Object.keys(spec.tags).length === 0)
    throw new TypeError('at least one ownership tag is required');
  if (!spec.triggerArn.startsWith('arn:')) throw new TypeError('triggerArn must be a Lambda ARN');
}

/** Creates, reconciles and deletes attested user pools. Needs pool-administration IAM rights. */
export function createCognitoPoolAdministration(
  options: CognitoConnectionOptions,
): CognitoPoolAdministration {
  const { send } = openCognitoConnection(options);
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

  async function ensureClient(userPoolId: string, clientName: string): Promise<string> {
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
      if (found?.ClientId) return found.ClientId;
      next = page.NextToken;
    } while (next);
    const created = await send<CreateUserPoolClientCommandOutput>(
      new CreateUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientName: clientName,
        GenerateSecret: false,
        ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
        EnableTokenRevocation: true,
        PreventUserExistenceErrors: 'ENABLED',
        AccessTokenValidity: 5,
        IdTokenValidity: 5,
        RefreshTokenValidity: 60,
        TokenValidityUnits: { ...TOKEN_MINUTES },
        ReadAttributes: ['email', 'email_verified'],
        WriteAttributes: [],
      }),
    );
    const clientId = created.UserPoolClient?.ClientId;
    if (!clientId) {
      throw new CognitoServerError(
        CognitoServerErrorReason.requestRefused,
        'Cognito created an app client without an id',
      );
    }
    return clientId;
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
    const clientId = await ensureClient(userPoolId, spec.clientName ?? spec.name);
    return { userPoolId, clientId, issuer: issuerFor(userPoolId), created };
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
