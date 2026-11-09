import {
  AdminCreateUserCommand,
  type AdminCreateUserCommandOutput,
  AdminDeleteUserAttributesCommand,
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

/**
 * Every attribute of one pool user, by Cognito name: `sub`, `email`, `name`, `phone_number`,
 * `custom:*`, … exactly as Cognito returns them. An attribute the user does not have is absent.
 */
export type CognitoUserAttributes = Readonly<Record<string, string>>;

/**
 * Attribute changes for `updateUserAttributes`, by Cognito name. A string sets the attribute; `null`
 * or an empty string removes it from the user.
 */
export type CognitoUserAttributeChanges = Readonly<Record<string, string | null>>;

export interface CognitoPoolDirectoryOptions extends CognitoConnectionOptions {
  userPoolId: string;
  /**
   * The attributes `updateUserAttributes` may set or remove — opt-in. Omitted or empty (the
   * default), every attribute write is refused with a `TypeError` before any request. Each name
   * must be a standard profile attribute (`name`, `given_name`, `family_name`, `middle_name`,
   * `nickname`, `phone_number`, `address`, `birthdate`, `gender`, `locale`, `picture`, `profile`,
   * `website`, `zoneinfo`) or a `custom:*` name; a sign-in name (`email`, `sub`,
   * `preferred_username`, `email_verified`, `phone_number_verified`) or anything else fails
   * `createCognitoPoolDirectory` with a `TypeError`. Example:
   * `['name', 'phone_number', 'custom:contact_hours']`.
   */
  writableAttributes?: readonly string[];
}

/**
 * The user records of one pool, without signing anyone in: look up, list, invite, resend,
 * enable, disable, delete, change the address, and read or change profile attributes (`name`,
 * `phone_number`, `custom:*`, …). Enough to administer a hosted-login pool — for example the
 * platform's operators — from the application. Needs the `Admin*User*` IAM actions on the pool
 * (`AdminDeleteUserAttributes` too, for removing attributes).
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
  /**
   * Every attribute of one user — standard and `custom:*` — or `null` when there is no such user.
   */
  getUserAttributes(username: string): Promise<CognitoUserAttributes | null>;
  /** Every user's attributes by username, page by page (60 per request). */
  listUserAttributes(): Promise<ReadonlyMap<string, CognitoUserAttributes>>;
  /**
   * Sets and removes profile attributes of one user: a string sets, `null` or `''` removes.
   *
   * Opt-in: only names listed in the directory's `writableAttributes` option are accepted; without
   * that option every call is refused with a `TypeError` before any request. Listable names are the standard profile attributes (`name`, `given_name`, `family_name`,
   * `middle_name`, `nickname`, `phone_number`, `address`, `birthdate`, `gender`, `locale`,
   * `picture`, `profile`, `website`, `zoneinfo`) and `custom:*` attributes the pool defines. The
   * sign-in names are not writable here: `email` goes through `updateEmail`, and `sub`,
   * `preferred_username`, `email_verified` and `phone_number_verified` are refused with a
   * `TypeError` before any request. `phone_number` must be E.164 (`+972521234567`); Cognito marks a
   * changed number unverified.
   *
   * Sets go in one `AdminUpdateUserAttributes` request and removals in one
   * `AdminDeleteUserAttributes` request (sets first), so a failure between the two can leave the
   * sets applied. Needs both IAM actions on the pool. An unknown user answers `found: false`.
   */
  updateUserAttributes(
    username: string,
    changes: CognitoUserAttributeChanges,
  ): Promise<{ found: boolean }>;
}

/** Standard OIDC profile attributes an administrator may set through `updateUserAttributes`. */
const WRITABLE_STANDARD_ATTRIBUTES: ReadonlySet<string> = new Set([
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'phone_number',
  'address',
  'birthdate',
  'gender',
  'locale',
  'picture',
  'profile',
  'website',
  'zoneinfo',
]);

/** Cognito's custom attribute name: `custom:` and 1-20 letters, digits, marks or punctuation. */
const CUSTOM_ATTRIBUTE_PATTERN = /^custom:[\p{L}\p{M}\p{S}\p{N}\p{P}]{1,20}$/u;
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
/** Cognito's limit on one attribute value. */
const MAX_ATTRIBUTE_VALUE_LENGTH = 2048;

function assertWritableAttribute(
  name: string,
  value: string | null,
  writable: ReadonlySet<string>,
): void {
  if (!isSafeWritableAttribute(name)) {
    throw new TypeError(
      `attribute ${JSON.stringify(name)} is not writable here: use a standard profile attribute or custom:*`,
    );
  }
  if (!writable.has(name)) {
    throw new TypeError(
      `attribute ${JSON.stringify(name)} is not in this directory's writableAttributes`,
    );
  }
  if (value === null) return;
  if (typeof value !== 'string') {
    throw new TypeError(`attribute ${name} must be a string or null`);
  }
  if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
    throw new TypeError(
      `attribute ${name} must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`,
    );
  }
  if (name === 'phone_number' && value !== '' && !E164_PATTERN.test(value)) {
    throw new TypeError('phone_number must be E.164, e.g. +972521234567');
  }
}

/** Whether `name` is in the safe set an app may list in `writableAttributes`. */
function isSafeWritableAttribute(name: string): boolean {
  return WRITABLE_STANDARD_ATTRIBUTES.has(name) || CUSTOM_ATTRIBUTE_PATTERN.test(name);
}

/** The validated, frozen `writableAttributes` allowlist; throws on a name outside the safe set. */
function resolveWritableAttributes(names: readonly string[] | undefined): ReadonlySet<string> {
  if (names === undefined) return new Set();
  if (!Array.isArray(names)) {
    throw new TypeError('writableAttributes must be a list of attribute names');
  }
  for (const name of names) {
    if (typeof name !== 'string' || !isSafeWritableAttribute(name)) {
      throw new TypeError(
        `writableAttributes: ${JSON.stringify(name)} is not writable: list standard profile attributes or custom:* only (email goes through updateEmail)`,
      );
    }
  }
  return new Set(names);
}

function attributeRecord(
  attributes: readonly { Name?: string; Value?: string }[] | undefined,
): CognitoUserAttributes {
  const record: Record<string, string> = {};
  for (const entry of attributes ?? []) {
    if (entry.Name && entry.Value !== undefined) record[entry.Name] = entry.Value;
  }
  return Object.freeze(record);
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
  writableAttributes: ReadonlySet<string> = new Set(),
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

  async function getUserAttributes(username: string): Promise<CognitoUserAttributes | null> {
    assertUsername(username);
    try {
      const output = await send<AdminGetUserCommandOutput>(
        new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
      );
      return attributeRecord(output.UserAttributes);
    } catch (error) {
      if (isUserNotFound(error)) return null;
      throw error;
    }
  }

  async function listUserAttributes(): Promise<ReadonlyMap<string, CognitoUserAttributes>> {
    const users = new Map<string, CognitoUserAttributes>();
    let token: string | undefined;
    do {
      const page: ListUsersCommandOutput = await send<ListUsersCommandOutput>(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Limit: 60,
          ...(token ? { PaginationToken: token } : {}),
        }),
      );
      for (const entry of page.Users ?? []) {
        if (entry.Username) users.set(entry.Username, attributeRecord(entry.Attributes));
      }
      token = page.PaginationToken;
    } while (token);
    return users;
  }

  async function updateUserAttributes(
    username: string,
    changes: CognitoUserAttributeChanges,
  ): Promise<{ found: boolean }> {
    assertUsername(username);
    if (writableAttributes.size === 0) {
      throw new TypeError(
        'attribute writes are off for this directory: pass writableAttributes to createCognitoPoolDirectory',
      );
    }
    if (typeof changes !== 'object' || changes === null) {
      throw new TypeError('changes must be an object of attribute names');
    }
    const sets: { Name: string; Value: string }[] = [];
    const removals: string[] = [];
    for (const [name, value] of Object.entries(changes)) {
      assertWritableAttribute(name, value, writableAttributes);
      if (value === null || value === '') removals.push(name);
      else sets.push({ Name: name, Value: value });
    }
    try {
      if (sets.length === 0 && removals.length === 0) {
        return { found: (await getUser(username)) !== null };
      }
      if (sets.length > 0) {
        await send(
          new AdminUpdateUserAttributesCommand({
            UserPoolId: userPoolId,
            Username: username,
            UserAttributes: sets,
          }),
        );
      }
      if (removals.length > 0) {
        await send(
          new AdminDeleteUserAttributesCommand({
            UserPoolId: userPoolId,
            Username: username,
            UserAttributeNames: removals,
          }),
        );
      }
      return { found: true };
    } catch (error) {
      if (isUserNotFound(error)) return { found: false };
      throw error;
    }
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
    getUserAttributes,
    listUserAttributes,
    updateUserAttributes,
  });
}

/** The user records of one pool — see `CognitoPoolDirectory`. */
export function createCognitoPoolDirectory(
  options: CognitoPoolDirectoryOptions,
): CognitoPoolDirectory {
  assertUserPoolId(options.userPoolId);
  const writable = resolveWritableAttributes(options.writableAttributes);
  const { send } = openCognitoConnection(options);
  return cognitoPoolDirectoryOn(send, options.userPoolId, writable);
}
