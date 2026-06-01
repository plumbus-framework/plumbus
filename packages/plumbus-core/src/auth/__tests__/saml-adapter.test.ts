import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { createSamlAdapter } from '../saml-adapter.js';

const IDP_ENTITY_ID = 'https://idp.example.com';
const SP_ENTITY_ID = 'https://app.example.com';

// Generate a test RSA key pair for signing assertions
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

// Use SPKI public key format (real certs would be X.509, but crypto.createPublicKey accepts SPKI too)
const certForAdapter = certPem;

function futureISO(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function pastISO(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** Build a minimal SAML Response XML with attributes. */
function buildSamlResponse(opts: {
  issuer?: string;
  audience?: string;
  nameId?: string;
  attributes?: Record<string, string[]>;
  notBefore?: string;
  notOnOrAfter?: string;
  skipSignature?: boolean;
  includeConditions?: boolean;
}): string {
  const issuer = opts.issuer ?? IDP_ENTITY_ID;
  const audience = opts.audience ?? SP_ENTITY_ID;
  const nameId = opts.nameId ?? 'user@example.com';
  const notBefore = opts.notBefore ?? pastISO(1);
  const notOnOrAfter = opts.notOnOrAfter ?? futureISO(10);

  const assertionBody = buildAssertionBody({
    issuer,
    audience,
    nameId,
    attributes: opts.attributes,
    notBefore,
    notOnOrAfter,
    includeConditions: opts.includeConditions,
  });

  if (opts.skipSignature) {
    return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
<saml:Assertion>${assertionBody}</saml:Assertion>
</samlp:Response>`;
  }

  // Sign the assertion content
  return signSamlResponse(assertionBody);
}

/** Sign a SAML response with arbitrary key material (for KeyInfo-override tests). */
function signSamlResponseWithKey(
  assertionBody: string,
  opts: { privateKeyPem: string; publicCertPem: string; assertionId?: string },
): string {
  const id = opts.assertionId ?? `_${randomUUID().replace(/-/g, '')}`;
  const issueInstant = new Date().toISOString();
  const unsignedXml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issueInstant}">
${assertionBody}
</saml:Assertion>
</samlp:Response>`;

  const sig = new SignedXml({
    privateKey: opts.privateKeyPem,
    publicCert: opts.publicCertPem,
  });
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.addReference({
    xpath: `//*[@ID='${id}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    uri: `#${id}`,
  });
  sig.computeSignature(unsignedXml, {
    location: { reference: `//*[@ID='${id}']`, action: 'append' },
  });
  return sig.getSignedXml();
}

/** Sign a SAML response using xml-crypto (enveloped RSA-SHA256). */
function signSamlResponse(assertionBody: string, assertionId?: string): string {
  const id = assertionId ?? `_${randomUUID().replace(/-/g, '')}`;
  return signSamlResponseWithKey(assertionBody, {
    privateKeyPem,
    publicCertPem: certForAdapter,
    assertionId: id,
  });
}

function buildAssertionBody(opts: {
  issuer?: string;
  audience?: string;
  nameId?: string;
  attributes?: Record<string, string[]>;
  notBefore?: string;
  notOnOrAfter?: string;
  includeConditions?: boolean;
}): string {
  const issuer = opts.issuer ?? IDP_ENTITY_ID;
  const audience = opts.audience ?? SP_ENTITY_ID;
  const nameId = opts.nameId ?? 'user@example.com';
  const notBefore = opts.notBefore ?? pastISO(1);
  const notOnOrAfter = opts.notOnOrAfter ?? futureISO(10);
  const includeConditions = opts.includeConditions ?? true;

  let attributeStatements = '';
  if (opts.attributes) {
    const attrXml = Object.entries(opts.attributes)
      .map(([name, values]) => {
        const valXml = values
          .map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`)
          .join('');
        return `<saml:Attribute Name="${name}">${valXml}</saml:Attribute>`;
      })
      .join('');
    attributeStatements = `<saml:AttributeStatement>${attrXml}</saml:AttributeStatement>`;
  }

  const conditions = includeConditions
    ? `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>
</saml:Conditions>`
    : '';

  return `<saml:Issuer>${issuer}</saml:Issuer>
${conditions}
<saml:Subject><saml:NameID>${nameId}</saml:NameID></saml:Subject>
${attributeStatements}`;
}

function toBase64(xml: string): string {
  return Buffer.from(xml).toString('base64');
}

describe('createSamlAdapter', () => {
  const adapter = createSamlAdapter({
    idpCertificate: certForAdapter,
    issuer: IDP_ENTITY_ID,
    audience: SP_ENTITY_ID,
  });

  describe('processSamlResponse', () => {
    it('validates a signed SAML response and extracts identity', () => {
      const xml = buildSamlResponse({
        nameId: 'user-42@example.com',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': [
            'user-42@example.com',
          ],
          'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': ['admin', 'user'],
        },
      });

      const result = adapter.processSamlResponse(toBase64(xml));

      expect(result).not.toBeNull();
      expect(result?.nameId).toBe('user-42@example.com');
      expect(result?.roles).toEqual(['admin', 'user']);
      expect(result?.provider).toBe('saml');
    });

    it('rejects response with wrong issuer', () => {
      const xml = buildSamlResponse({ issuer: 'https://evil.example.com' });
      expect(adapter.processSamlResponse(toBase64(xml))).toBeNull();
    });

    it('rejects response with wrong audience', () => {
      const xml = buildSamlResponse({ audience: 'https://other-app.example.com' });
      expect(adapter.processSamlResponse(toBase64(xml))).toBeNull();
    });

    it('rejects unsigned responses', () => {
      const xml = buildSamlResponse({ skipSignature: true });
      expect(adapter.processSamlResponse(toBase64(xml))).toBeNull();
    });

    it('rejects expired conditions', () => {
      const xml = buildSamlResponse({
        notBefore: pastISO(30),
        notOnOrAfter: pastISO(20),
      });
      expect(adapter.processSamlResponse(toBase64(xml))).toBeNull();
    });

    it('extracts NameID as default userId', () => {
      const xml = buildSamlResponse({ nameId: 'default-user-id' });
      const result = adapter.processSamlResponse(toBase64(xml));
      expect(result?.userId).toBe('default-user-id');
      expect(result?.nameId).toBe('default-user-id');
    });

    it('prefers userId from attributes over NameID', () => {
      const xml = buildSamlResponse({
        nameId: 'nameid-value',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier': ['attr-user-id'],
        },
      });
      const result = adapter.processSamlResponse(toBase64(xml));
      expect(result?.userId).toBe('attr-user-id');
    });

    it('extracts tenantId from attributes', () => {
      const xml = buildSamlResponse({
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/tenantid': ['tenant-abc'],
        },
      });
      const result = adapter.processSamlResponse(toBase64(xml));
      expect(result?.tenantId).toBe('tenant-abc');
    });

    it('returns null for invalid base64', () => {
      expect(adapter.processSamlResponse('not-valid-base64!!!')).toBeNull();
    });
  });

  describe('authenticate (Bearer mode)', () => {
    it('returns null for missing header', async () => {
      expect(await adapter.authenticate(undefined)).toBeNull();
    });

    it('returns null for non-Bearer header', async () => {
      expect(await adapter.authenticate('Basic abc123')).toBeNull();
    });

    it('validates a Bearer token containing base64-encoded SAML assertion', async () => {
      const xml = buildSamlResponse({ nameId: 'bearer-user' });
      const encoded = toBase64(xml);
      const result = await adapter.authenticate(`Bearer ${encoded}`);
      expect(result?.userId).toBe('bearer-user');
      expect(result?.provider).toBe('saml');
    });

    it('returns null for Bearer token without SAML content', async () => {
      const encoded = Buffer.from('not xml').toString('base64');
      expect(await adapter.authenticate(`Bearer ${encoded}`)).toBeNull();
    });
  });

  describe('signature wrapping and tampering', () => {
    it('rejects a wrapped forged assertion alongside a valid signed assertion', () => {
      const valid = buildSamlResponse({ nameId: 'legitimate-user' });
      const forgedBody = buildAssertionBody({
        nameId: 'attacker',
        attributes: {
          'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': ['admin'],
        },
      });
      const wrapped = valid.replace(
        '<samlp:Response',
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
<saml:Assertion ID="_forged" Version="2.0">${forgedBody}</saml:Assertion>`,
      );
      expect(adapter.processSamlResponse(toBase64(wrapped))).toBeNull();
    });

    it('rejects responses with two assertions', () => {
      const valid = buildSamlResponse({ nameId: 'user-1' });
      const duplicate = valid.replace(
        '</samlp:Response>',
        `<saml:Assertion ID="_second" Version="2.0">${buildAssertionBody({ nameId: 'user-2' })}</saml:Assertion></samlp:Response>`,
      );
      expect(adapter.processSamlResponse(toBase64(duplicate))).toBeNull();
    });

    it('rejects tampered assertion content after signing', () => {
      const valid = buildSamlResponse({ nameId: 'user-1' });
      const tampered = valid.replace(
        '<saml:NameID>user-1</saml:NameID>',
        '<saml:NameID>attacker</saml:NameID>',
      );
      expect(adapter.processSamlResponse(toBase64(tampered))).toBeNull();
    });

    it('rejects assertions missing Conditions', () => {
      const xml = buildSamlResponse({ nameId: 'user-1', includeConditions: false });
      expect(adapter.processSamlResponse(toBase64(xml))).toBeNull();
    });

    it('rejects assertions signed with a non-IdP key (KeyInfo must not override pinned cert)', () => {
      const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const attackerCert = attacker.publicKey.export({ type: 'spki', format: 'pem' }) as string;
      const attackerPrivate = attacker.privateKey.export({
        type: 'pkcs1',
        format: 'pem',
      }) as string;
      const body = buildAssertionBody({
        nameId: 'attacker',
        attributes: {
          'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': ['admin'],
        },
      });
      const xml = signSamlResponseWithKey(body, {
        privateKeyPem: attackerPrivate,
        publicCertPem: attackerCert,
      });
      expect(adapter.processSamlResponse(toBase64(xml))).toBeNull();
    });
  });

  describe('custom attribute mapping', () => {
    it('maps attributes using custom configuration', () => {
      const customAdapter = createSamlAdapter({
        idpCertificate: certForAdapter,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        attributeMapping: {
          userId: 'custom_user_id',
          roles: 'custom_roles',
          tenantId: 'custom_org',
        },
      });

      const xml = buildSamlResponse({
        attributes: {
          custom_user_id: ['custom-42'],
          custom_roles: ['editor'],
          custom_org: ['org-99'],
        },
      });

      const result = customAdapter.processSamlResponse(toBase64(xml));
      expect(result?.userId).toBe('custom-42');
      expect(result?.roles).toEqual(['editor']);
      expect(result?.tenantId).toBe('org-99');
    });
  });
});
