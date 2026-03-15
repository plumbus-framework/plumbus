import { createPublicKey, createVerify } from 'node:crypto';
import type { AuthContext } from '../types/security.js';
import type { AuthAdapter } from './adapter.js';

// ── SAML Adapter ──
// Validates SAML 2.0 assertions for authentication.
// Handles both Bearer token mode (base64-encoded assertion in Authorization header)
// and direct assertion processing via processSamlResponse().

export interface SamlAdapterConfig {
  /** IdP certificate (PEM format) for signature validation */
  idpCertificate: string;
  /** Expected SAML issuer (IdP entity ID) */
  issuer: string;
  /** Expected audience (SP entity ID / ACS URL) */
  audience: string;
  /** Attribute mapping for SAML claim extraction */
  attributeMapping?: Partial<SamlAttributeMapping>;
}

export interface SamlAttributeMapping {
  userId: string;
  email: string;
  roles: string;
  tenantId: string;
  displayName: string;
}

export interface SamlAuthResult extends AuthContext {
  /** Raw SAML attributes from the assertion */
  attributes: Record<string, string[]>;
  /** SAML NameID */
  nameId: string;
}

const defaultAttributeMapping: SamlAttributeMapping = {
  userId: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  roles: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
  tenantId: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/tenantid',
  displayName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
};

/**
 * SAML 2.0 auth adapter. Two modes of operation:
 *
 * 1. `authenticate(header)` — extracts a Bearer token containing a
 *    base64-encoded SAML assertion (used for API calls after SSO login).
 *
 * 2. `processSamlResponse(samlResponse)` — directly validates a SAML
 *    Response from the IdP (used in SSO callback handlers).
 */
export function createSamlAdapter(
  config: SamlAdapterConfig,
): AuthAdapter & { processSamlResponse(samlResponseB64: string): SamlAuthResult | null } {
  const mapping = { ...defaultAttributeMapping, ...config.attributeMapping };

  function parseAssertion(xml: string): SamlAuthResult | null {
    // Extract Issuer
    const issuerMatch = xml.match(/<(?:saml2?:)?Issuer[^>]*>([^<]+)<\//);
    if (!issuerMatch?.[1] || issuerMatch[1] !== config.issuer) {
      return null;
    }

    // Validate signature
    if (!validateSignature(xml, config.idpCertificate)) {
      return null;
    }

    // Check Conditions (audience + time)
    if (!validateConditions(xml, config.audience)) {
      return null;
    }

    // Extract NameID
    const nameIdMatch = xml.match(/<(?:saml2?:)?NameID[^>]*>([^<]+)<\//);
    const nameId = nameIdMatch?.[1] ?? '';

    // Extract attributes
    const attributes = extractAttributes(xml);

    // Map to AuthContext
    const userIdValues = attributes[mapping.userId] ?? [];
    const userId = userIdValues[0] ?? nameId;

    const roleValues = attributes[mapping.roles] ?? [];
    const tenantValues = attributes[mapping.tenantId] ?? [];

    return {
      userId,
      roles: roleValues,
      scopes: [],
      tenantId: tenantValues[0],
      provider: 'saml',
      authenticatedAt: new Date(),
      nameId,
      attributes,
    };
  }

  return {
    async authenticate(authorizationHeader: string | undefined): Promise<AuthContext | null> {
      if (!authorizationHeader) return null;

      if (!authorizationHeader.startsWith('Bearer ')) return null;
      const encoded = authorizationHeader.slice(7);

      let xml: string;
      try {
        xml = Buffer.from(encoded, 'base64').toString('utf-8');
      } catch {
        return null;
      }

      if (!xml.includes('saml') && !xml.includes('Assertion')) {
        return null;
      }

      return parseAssertion(xml);
    },

    processSamlResponse(samlResponseB64: string): SamlAuthResult | null {
      let xml: string;
      try {
        xml = Buffer.from(samlResponseB64, 'base64').toString('utf-8');
      } catch {
        return null;
      }

      return parseAssertion(xml);
    },
  };
}

// ── XML Signature Validation ──

function validateSignature(xml: string, certPem: string): boolean {
  // Extract SignatureValue
  const sigValueMatch = xml.match(/<(?:ds:)?SignatureValue[^>]*>\s*([A-Za-z0-9+/=\s]+?)\s*<\//);
  if (!sigValueMatch?.[1]) return false;

  const signatureB64 = sigValueMatch[1].replace(/\s/g, '');

  // Extract SignedInfo element for verification
  const signedInfoMatch = xml.match(/<(?:ds:)?SignedInfo[\s\S]*?<\/(?:ds:)?SignedInfo>/);
  if (!signedInfoMatch?.[0]) return false;

  // Canonicalize SignedInfo (exclusive C14N — normalize namespace, whitespace)
  const signedInfo = canonicalizeSignedInfo(signedInfoMatch[0], xml);

  // Extract signature algorithm (specifically from SignatureMethod, not CanonicalizationMethod)
  const algMatch = signedInfo.match(/SignatureMethod\s+Algorithm="([^"]+)"/);
  const sigAlg = algMatch?.[1] ?? '';

  let nodeAlg: string;
  if (sigAlg.includes('rsa-sha256') || sigAlg.includes('RSA-SHA256')) {
    nodeAlg = 'RSA-SHA256';
  } else if (sigAlg.includes('rsa-sha1') || sigAlg.includes('RSA-SHA1')) {
    nodeAlg = 'RSA-SHA1';
  } else {
    return false; // Unsupported algorithm
  }

  try {
    const cert = normalizeCertificate(certPem);
    const publicKey = createPublicKey(cert);
    const verifier = createVerify(nodeAlg);
    verifier.update(signedInfo);
    return verifier.verify(publicKey, signatureB64, 'base64');
  } catch {
    return false;
  }
}

/**
 * Minimal exclusive C14N for SignedInfo.
 * Resolves the default SAML namespace prefix propagation needed for
 * enveloped signature verification.
 */
function canonicalizeSignedInfo(signedInfo: string, fullXml: string): string {
  let result = signedInfo;

  // If SignedInfo uses namespace prefixes defined in ancestor elements,
  // we need to include those namespace declarations
  if (!result.includes('xmlns:ds') && fullXml.includes('xmlns:ds')) {
    const dsNsMatch = fullXml.match(/xmlns:ds="([^"]+)"/);
    if (dsNsMatch) {
      result = result.replace(/<(?:ds:)?SignedInfo/, `<ds:SignedInfo xmlns:ds="${dsNsMatch[1]}"`);
    }
  }

  // Normalize self-closing tags
  result = result.replace(/<([^/][^>]*)\s*\/>/g, '<$1></$1>');

  return result;
}

function normalizeCertificate(cert: string): string {
  // If it already has PEM headers, return as-is
  if (cert.includes('-----BEGIN')) return cert;

  // Strip whitespace and wrap in PEM
  const clean = cert.replace(/\s/g, '');
  const lines = clean.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

// ── Conditions Validation ──

function validateConditions(xml: string, audience: string): boolean {
  const conditionsMatch = xml.match(/<(?:saml2?:)?Conditions([^>]*)>/);
  if (!conditionsMatch) return true; // No conditions = valid

  const attrs = conditionsMatch[1] ?? '';

  // Check NotBefore
  const notBeforeMatch = attrs.match(/NotBefore="([^"]+)"/);
  if (notBeforeMatch?.[1]) {
    const notBefore = new Date(notBeforeMatch[1]).getTime();
    // Allow 5 minutes clock skew
    if (Date.now() < notBefore - 5 * 60 * 1000) return false;
  }

  // Check NotOnOrAfter
  const notOnOrAfterMatch = attrs.match(/NotOnOrAfter="([^"]+)"/);
  if (notOnOrAfterMatch?.[1]) {
    const notOnOrAfter = new Date(notOnOrAfterMatch[1]).getTime();
    // Allow 5 minutes clock skew
    if (Date.now() >= notOnOrAfter + 5 * 60 * 1000) return false;
  }

  // Check AudienceRestriction
  const audienceMatch = xml.match(
    /<(?:saml2?:)?AudienceRestriction>[\s\S]*?<(?:saml2?:)?Audience>([^<]+)<\//,
  );
  if (audienceMatch?.[1] && audienceMatch[1] !== audience) {
    return false;
  }

  return true;
}

// ── Attribute Extraction ──

function extractAttributes(xml: string): Record<string, string[]> {
  const attributes: Record<string, string[]> = {};

  // Match all Attribute elements
  const attrRegex =
    /<(?:saml2?:)?Attribute\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:saml2?:)?Attribute>/g;
  let match: RegExpExecArray | null;

  while (true) {
    match = attrRegex.exec(xml);
    if (!match) break;
    const name = match[1];
    const body = match[2];
    if (!name || !body) continue;

    const values: string[] = [];
    const valueRegex = /<(?:saml2?:)?AttributeValue[^>]*>([^<]*)<\//g;
    let valueMatch: RegExpExecArray | null;
    while (true) {
      valueMatch = valueRegex.exec(body);
      if (!valueMatch) break;
      if (valueMatch[1] !== undefined) {
        values.push(valueMatch[1]);
      }
    }

    attributes[name] = values;
  }

  return attributes;
}
