import { describe, expect, it } from 'vitest';
import { signAttestation } from '../attestation/index.js';
import {
  type CognitoAuthChallengeEvent,
  CognitoTriggerSource,
  createAttestedSignInTrigger,
} from '../triggers/index.js';

const KEYS = [{ id: 'k1', secret: 's'.repeat(32) }];
const POOL = 'eu-west-1_Pool1';

function event(
  triggerSource: string,
  request: CognitoAuthChallengeEvent['request'] = {},
): CognitoAuthChallengeEvent {
  return { triggerSource, userPoolId: POOL, userName: 'account-1', request, response: {} };
}

describe('attested sign-in trigger', () => {
  const trigger = createAttestedSignInTrigger({ keys: KEYS });

  it('define: first asks for one custom challenge', async () => {
    const out = await trigger(event(CognitoTriggerSource.define, { session: [] }));
    expect(out.response).toMatchObject({
      challengeName: 'CUSTOM_CHALLENGE',
      issueTokens: false,
      failAuthentication: false,
    });
  });

  it('define: issues tokens only after one passed attested challenge', async () => {
    const passed = await trigger(
      event(CognitoTriggerSource.define, {
        session: [
          {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: true,
            challengeMetadata: 'PLUMBUS_ATTESTED_V1',
          },
        ],
      }),
    );
    expect(passed.response).toMatchObject({ issueTokens: true, failAuthentication: false });
  });

  it('define: fails unknown users, wrong answers, retries and foreign steps', async () => {
    const sessions: CognitoAuthChallengeEvent['request'][] = [
      { userNotFound: true, session: [] },
      {
        session: [
          {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: false,
            challengeMetadata: 'PLUMBUS_ATTESTED_V1',
          },
        ],
      },
      {
        session: [
          {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: false,
            challengeMetadata: 'PLUMBUS_ATTESTED_V1',
          },
          {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: true,
            challengeMetadata: 'PLUMBUS_ATTESTED_V1',
          },
        ],
      },
      { session: [{ challengeName: 'PASSWORD_VERIFIER', challengeResult: true }] },
      { session: [{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true }] },
    ];
    for (const request of sessions) {
      const out = await trigger(event(CognitoTriggerSource.define, request));
      expect(out.response).toMatchObject({ issueTokens: false, failAuthentication: true });
    }
  });

  it('create: a fresh nonce, public and private, with attested metadata', async () => {
    const first = await trigger(
      event(CognitoTriggerSource.create, { challengeName: 'CUSTOM_CHALLENGE' }),
    );
    const second = await trigger(
      event(CognitoTriggerSource.create, { challengeName: 'CUSTOM_CHALLENGE' }),
    );
    const nonce = (first.response.publicChallengeParameters as { nonce: string }).nonce;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.response.privateChallengeParameters).toEqual({ nonce });
    expect(first.response.challengeMetadata).toBe('PLUMBUS_ATTESTED_V1');
    expect((second.response.publicChallengeParameters as { nonce: string }).nonce).not.toBe(nonce);
    await expect(
      trigger(event(CognitoTriggerSource.create, { challengeName: 'SMS_MFA' })),
    ).rejects.toThrow(/CUSTOM_CHALLENGE/);
  });

  it('verify: accepts only the attestation for this pool, user and nonce', async () => {
    const good = signAttestation(KEYS, { userPoolId: POOL, username: 'account-1', nonce: 'n1' });
    const accepted = await trigger(
      event(CognitoTriggerSource.verify, {
        privateChallengeParameters: { nonce: 'n1' },
        challengeAnswer: good,
      }),
    );
    expect(accepted.response.answerCorrect).toBe(true);
    const otherNonce = await trigger(
      event(CognitoTriggerSource.verify, {
        privateChallengeParameters: { nonce: 'n2' },
        challengeAnswer: good,
      }),
    );
    expect(otherNonce.response.answerCorrect).toBe(false);
    const missing = await trigger(event(CognitoTriggerSource.verify, { challengeAnswer: good }));
    expect(missing.response.answerCorrect).toBe(false);
  });

  it('loads keys per call from a loader and rejects unknown trigger sources', async () => {
    let loads = 0;
    const loading = createAttestedSignInTrigger({
      keys: async () => {
        loads += 1;
        return KEYS;
      },
    });
    const answer = signAttestation(KEYS, { userPoolId: POOL, username: 'account-1', nonce: 'n' });
    const out = await loading(
      event(CognitoTriggerSource.verify, {
        privateChallengeParameters: { nonce: 'n' },
        challengeAnswer: answer,
      }),
    );
    expect(out.response.answerCorrect).toBe(true);
    expect(loads).toBe(1);
    await expect(loading(event('PreSignUp_SignUp'))).rejects.toThrow(/unsupported/);
    expect(() => createAttestedSignInTrigger({ keys: [] })).toThrow(/at least one/);
    const broken = createAttestedSignInTrigger({ keys: async () => [] });
    await expect(
      broken(event(CognitoTriggerSource.verify, { challengeAnswer: answer })),
    ).rejects.toThrow(/at least one/);
  });
});
