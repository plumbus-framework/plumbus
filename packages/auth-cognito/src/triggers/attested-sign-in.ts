import {
  ATTESTATION_CHALLENGE_METADATA,
  type AttestationKey,
  createAttestationNonce,
  validateAttestationKeys,
  verifyAttestation,
} from '../attestation/index.js';

/** One completed step of a custom-auth session, as Cognito hands it to the define trigger. */
export interface CognitoChallengeResult {
  challengeName: string;
  challengeResult: boolean;
  challengeMetadata?: string;
}

/**
 * The fields of Cognito's custom-auth trigger events this package reads and writes.
 *
 * Structural, so the handler accepts the real Lambda event without an `aws-lambda` types
 * dependency. Unknown fields pass through untouched.
 */
export interface CognitoAuthChallengeEvent {
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: {
    userNotFound?: boolean;
    session?: CognitoChallengeResult[];
    challengeName?: string;
    privateChallengeParameters?: Record<string, string>;
    challengeAnswer?: string;
    [key: string]: unknown;
  };
  response: Record<string, unknown>;
  [key: string]: unknown;
}

/** Keys as a list, or a loader (for example from a secret store) called on every invocation. */
export type AttestationKeySource =
  | readonly AttestationKey[]
  | (() => Promise<readonly AttestationKey[]> | readonly AttestationKey[]);

export interface AttestedSignInTriggerOptions {
  keys: AttestationKeySource;
}

export const CognitoTriggerSource = {
  define: 'DefineAuthChallenge_Authentication',
  create: 'CreateAuthChallenge_Authentication',
  verify: 'VerifyAuthChallengeResponse_Authentication',
} as const;

const CUSTOM_CHALLENGE = 'CUSTOM_CHALLENGE';

/**
 * Define: exactly one custom challenge, then tokens only if it passed. Anything else — an unknown
 * user, a second attempt, a password or SRP step mixed in — fails the whole authentication.
 */
export function defineAttestedChallenge(
  event: CognitoAuthChallengeEvent,
): CognitoAuthChallengeEvent {
  const session = event.request.session ?? [];
  const first = session[0];
  if (event.request.userNotFound) {
    event.response = { ...event.response, issueTokens: false, failAuthentication: true };
  } else if (session.length === 0) {
    event.response = {
      ...event.response,
      challengeName: CUSTOM_CHALLENGE,
      issueTokens: false,
      failAuthentication: false,
    };
  } else if (
    session.length === 1 &&
    first?.challengeName === CUSTOM_CHALLENGE &&
    first.challengeResult === true &&
    first.challengeMetadata === ATTESTATION_CHALLENGE_METADATA
  ) {
    event.response = { ...event.response, issueTokens: true, failAuthentication: false };
  } else {
    event.response = { ...event.response, issueTokens: false, failAuthentication: true };
  }
  return event;
}

/** Create: a fresh nonce, public (the server signs it) and private (the verify step checks it). */
export function createAttestedChallenge(
  event: CognitoAuthChallengeEvent,
): CognitoAuthChallengeEvent {
  if (event.request.challengeName !== CUSTOM_CHALLENGE) {
    throw new Error('attested sign-in only issues CUSTOM_CHALLENGE');
  }
  const nonce = createAttestationNonce();
  event.response = {
    ...event.response,
    publicChallengeParameters: { nonce },
    privateChallengeParameters: { nonce },
    challengeMetadata: ATTESTATION_CHALLENGE_METADATA,
  };
  return event;
}

/** Verify: the answer is the server's attestation over this pool, this user and this nonce. */
export function verifyAttestedChallenge(
  event: CognitoAuthChallengeEvent,
  keys: readonly AttestationKey[],
): CognitoAuthChallengeEvent {
  const nonce = event.request.privateChallengeParameters?.nonce ?? '';
  const answerCorrect = verifyAttestation(
    keys,
    { userPoolId: event.userPoolId, username: event.userName, nonce },
    event.request.challengeAnswer,
  );
  event.response = { ...event.response, answerCorrect };
  return event;
}

/**
 * One Lambda handler for all three custom-auth triggers of an attested user pool.
 *
 * Attach the same function as the pool's DefineAuthChallenge, CreateAuthChallenge and
 * VerifyAuthChallengeResponse trigger; it dispatches on `triggerSource`. Keys are validated on
 * every call that needs them, so a misconfigured keyring refuses sign-in rather than admitting.
 */
export function createAttestedSignInTrigger(
  options: AttestedSignInTriggerOptions,
): (event: CognitoAuthChallengeEvent) => Promise<CognitoAuthChallengeEvent> {
  const loadKeys = async (): Promise<readonly AttestationKey[]> =>
    validateAttestationKeys(
      typeof options.keys === 'function' ? await options.keys() : options.keys,
    );
  if (typeof options.keys !== 'function') validateAttestationKeys(options.keys);

  return async (event) => {
    switch (event.triggerSource) {
      case CognitoTriggerSource.define:
        return defineAttestedChallenge(event);
      case CognitoTriggerSource.create:
        return createAttestedChallenge(event);
      case CognitoTriggerSource.verify:
        return verifyAttestedChallenge(event, await loadKeys());
      default:
        throw new Error(`unsupported Cognito trigger source: ${event.triggerSource}`);
    }
  };
}
