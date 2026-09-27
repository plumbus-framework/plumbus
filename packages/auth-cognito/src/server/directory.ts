import {
  AdminCreateUserCommand,
  type AdminCreateUserCommandOutput,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  type AdminGetUserCommandOutput,
  AdminUpdateUserAttributesCommand,
  ListUsersCommand,
  type ListUsersCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  assertUserPoolId,
  type CognitoConnectionOptions,
  type CognitoSend,
  openCognitoConnection,
} from './connection.js';
import { CognitoServerError, CognitoServerErrorReason } from './errors.js';

/** A pool user as the server sees it. `subject` is the immutable `sub`. */
export interface CognitoPoolUser {
  username: string;
  subject: string;
  enabled: boolean;
  /** Cognito's status: `CONFIRMED`, `FORCE_CHANGE_PASSWORD` (invited, not signed in yet), … */
  status: string;
  email?: string;
  /** The `name` attribute, when the pool keeps one. */
  name?: string;
}

export interface CognitoPoolDirectoryOptions extends CognitoConnectionOptions {
  userPoolId: string;
}

/**
 * The user records of one pool, without signing anyone in: look up, list, invite, resend,
 * enable, disable, delete, change the address. Enough to administer a hosted-login pool — for example the
 * platform's operators — from the application. Needs the `Admin*User*` IAM actions on the pool.
 */
export interface CognitoPoolDirectory {
  readonly userPoolId: string;
  getUser(username: string): Promise<CognitoPoolUser | null>;
  /** Every user of the pool, page by page (60 per request). */
  listUsers(): Promise<CognitoPoolUser[]>;
  /**
   * Creates the user and lets Cognito email them a temporary password (the pool's invitation
   * message). They choose a password — and, on an MFA pool, set up their factor — at first
   * sign-in. An address that already has a user answers that user with `created: false`.
   *
   * `sendInvitation: false` creates the user without any mail (Cognito's `SUPPRESS`): nobody
   * knows the temporary password until `resendInvitation` mails one — for an admission someone
   * still has to approve.
   */
  inviteUser(input: {
    email: string;
    name?: string;
    sendInvitation?: boolean;
  }): Promise<CognitoPoolUser & { created: boolean }>;
  /**
   * Mails a new temporary password (the invitation message again). Only for a user still waiting
   * for their first sign-in; a user created with `sendInvitation: false` gets their first one.
   */
  resendInvitation(username: string): Promise<void>;
  setUserEnabled(username: string, enabled: boolean): Promise<{ found: boolean }>;
  deleteUser(username: string): Promise<{ found: boolean }>;
  /** Replaces the email attribute and marks it verified. */
  updateEmail(username: string, email: string): Promise<void>;
}

function attribute(
  attributes: readonly { Name?: string; Value?: string }[] | undefined,
  name: string,
): string | undefined {
  return attributes?.find((entry) => entry.Name === name)?.Value;
}

export function projectPoolUser(output: {
  Username?: string;
  UserAttributes?: { Name?: string; Value?: string }[];
  Attributes?: { Name?: string; Value?: string }[];
  Enabled?: boolean;
  UserStatus?: string;
}): CognitoPoolUser {
  const attributes = output.UserAttributes ?? output.Attributes;
  const subject = attribute(attributes, 'sub');
  if (!output.Username || !subject) {
    throw new CognitoServerError(
      CognitoServerErrorReason.requestRefused,
      'Cognito returned a user without a username or sub',
    );
  }
  const email = attribute(attributes, 'email');
  const name = attribute(attributes, 'name');
  return {
    username: output.Username,
    subject,
    enabled: output.Enabled !== false,
    status: output.UserStatus ?? 'UNKNOWN',
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

export function assertUsername(username: string): void {
  if (typeof username !== 'string' || username.length === 0 || username.length > 128) {
    throw new TypeError('username must be 1-128 characters');
  }
}

function assertEmail(email: string): void {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
    throw new TypeError('email must be an address');
  }
}

function isUserNotFound(error: unknown): boolean {
  return (
    error instanceof CognitoServerError && error.reason === CognitoServerErrorReason.userNotFound
  );
}

/** Builds the directory over an already-open connection (shared with `createCognitoPoolUsers`). */
export function cognitoPoolDirectoryOn(
  send: CognitoSend,
  userPoolId: string,
): CognitoPoolDirectory {
  async function getUser(username: string): Promise<CognitoPoolUser | null> {
    assertUsername(username);
    try {
      return projectPoolUser(
        await send<AdminGetUserCommandOutput>(
          new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
        ),
      );
    } catch (error) {
      if (isUserNotFound(error)) return null;
      throw error;
    }
  }

  async function listUsers(): Promise<CognitoPoolUser[]> {
    const users: CognitoPoolUser[] = [];
    let token: string | undefined;
    do {
      const page: ListUsersCommandOutput = await send<ListUsersCommandOutput>(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Limit: 60,
          ...(token ? { PaginationToken: token } : {}),
        }),
      );
      for (const entry of page.Users ?? []) users.push(projectPoolUser(entry));
      token = page.PaginationToken;
    } while (token);
    return users;
  }

  async function inviteUser(input: { email: string; name?: string; sendInvitation?: boolean }) {
    assertEmail(input.email);
    try {
      const created = await send<AdminCreateUserCommandOutput>(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: input.email,
          ...(input.sendInvitation === false
            ? { MessageAction: 'SUPPRESS' as const }
            : { DesiredDeliveryMediums: ['EMAIL' as const] }),
          UserAttributes: [
            { Name: 'email', Value: input.email },
            { Name: 'email_verified', Value: 'true' },
            ...(input.name ? [{ Name: 'name', Value: input.name }] : []),
          ],
        }),
      );
      if (!created.User) {
        throw new CognitoServerError(
          CognitoServerErrorReason.requestRefused,
          'Cognito created no user',
        );
      }
      return { ...projectPoolUser(created.User), created: true };
    } catch (error) {
      if ((error as CognitoServerError).cognitoError !== 'UsernameExistsException') throw error;
      const existing = await getUser(input.email);
      if (!existing) throw error;
      return { ...existing, created: false };
    }
  }

  async function resendInvitation(username: string): Promise<void> {
    assertUsername(username);
    await send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
  }

  async function setUserEnabled(username: string, enabled: boolean): Promise<{ found: boolean }> {
    assertUsername(username);
    try {
      await send(
        enabled
          ? new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username })
          : new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }),
      );
      return { found: true };
    } catch (error) {
      if (isUserNotFound(error)) return { found: false };
      throw error;
    }
  }

  async function deleteUser(username: string): Promise<{ found: boolean }> {
    assertUsername(username);
    try {
      await send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
      return { found: true };
    } catch (error) {
      if (isUserNotFound(error)) return { found: false };
      throw error;
    }
  }

  async function updateEmail(username: string, email: string): Promise<void> {
    assertUsername(username);
    if (!email) throw new TypeError('email is required');
    await send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    );
  }

  return Object.freeze({
    userPoolId,
    getUser,
    listUsers,
    inviteUser,
    resendInvitation,
    setUserEnabled,
    deleteUser,
    updateEmail,
  });
}

/** The user records of one pool — see `CognitoPoolDirectory`. */
export function createCognitoPoolDirectory(
  options: CognitoPoolDirectoryOptions,
): CognitoPoolDirectory {
  assertUserPoolId(options.userPoolId);
  const { send } = openCognitoConnection(options);
  return cognitoPoolDirectoryOn(send, options.userPoolId);
}
