import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
} from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import * as xpath from 'xpath';
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

const ASSERTION_XPATH =
  "//*[local-name()='Assertion' and namespace-uri()='urn:oasis:names:tc:SAML:2.0:assertion']";
const SIGNATURE_XPATH =
  "//*[local-name()='Signature' and namespace-uri()='http://www.w3.org/2000/09/xmldsig#']";

/** Bridge @xmldom/xmldom nodes to xpath / xml-crypto DOM typings. */
function asDomNode(node: XmlDocument | XmlElement): Node {
  return node as unknown as Node;
}

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
    let verifiedAssertion: XmlDocument | null;
    try {
      verifiedAssertion = verifySignedAssertion(xml, config.idpCertificate);
    } catch {
      return null;
    }
    if (!verifiedAssertion) return null;

    const issuer = readElementText(verifiedAssertion, 'Issuer');
    if (!issuer || issuer !== config.issuer) return null;

    if (!validateConditions(verifiedAssertion, config.audience)) return null;

    const nameId = readElementText(verifiedAssertion, 'NameID') ?? '';
    const attributes = extractAttributes(verifiedAssertion);

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

function verifySignedAssertion(xml: string, certPem: string): XmlDocument | null {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  const assertions = xpath.select(ASSERTION_XPATH, asDomNode(doc)) as Node[];
  if (assertions.length !== 1) return null;

  const signatures = xpath.select(SIGNATURE_XPATH, asDomNode(doc)) as Node[];
  if (signatures.length !== 1) return null;

  const sig = new SignedXml({ publicCert: normalizeCertificate(certPem) });
  sig.loadSignature(signatures[0] as Node);
  if (!sig.checkSignature(xml)) return null;

  const signedRefs = sig.getSignedReferences();
  if (signedRefs.length !== 1) return null;

  const verifiedDoc = new DOMParser().parseFromString(signedRefs[0] ?? '', 'text/xml');
  const verifiedAssertions = xpath.select(ASSERTION_XPATH, asDomNode(verifiedDoc)) as Node[];
  if (verifiedAssertions.length !== 1) return null;

  return verifiedDoc;
}

function normalizeCertificate(cert: string): string {
  if (cert.includes('-----BEGIN')) return cert;
  const clean = cert.replace(/\s/g, '');
  const lines = clean.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function validateConditions(assertionDoc: XmlDocument, audience: string): boolean {
  const conditionsNodes = xpath.select(
    "//*[local-name()='Conditions' and namespace-uri()='urn:oasis:names:tc:SAML:2.0:assertion']",
    asDomNode(assertionDoc),
  ) as Node[];
  if (conditionsNodes.length !== 1) return false;

  const conditions = conditionsNodes[0] as unknown as XmlElement;
  const notBefore = conditions.getAttribute('NotBefore');
  if (notBefore) {
    const notBeforeMs = new Date(notBefore).getTime();
    if (Date.now() < notBeforeMs - 5 * 60 * 1000) return false;
  }

  const notOnOrAfter = conditions.getAttribute('NotOnOrAfter');
  if (!notOnOrAfter) return false;
  const notOnOrAfterMs = new Date(notOnOrAfter).getTime();
  if (Date.now() >= notOnOrAfterMs + 5 * 60 * 1000) return false;

  const audienceNodes = xpath.select(
    "//*[local-name()='Audience' and namespace-uri()='urn:oasis:names:tc:SAML:2.0:assertion']",
    asDomNode(assertionDoc),
  ) as Node[];
  if (audienceNodes.length === 0) return false;
  const audienceValue = audienceNodes[0]?.textContent?.trim();
  if (!audienceValue || audienceValue !== audience) return false;

  return true;
}

function readElementText(doc: XmlDocument, localName: string): string | undefined {
  const nodes = xpath.select(
    `//*[local-name()='${localName}' and namespace-uri()='urn:oasis:names:tc:SAML:2.0:assertion']`,
    asDomNode(doc),
  ) as Node[];
  const text = nodes[0]?.textContent?.trim();
  return text || undefined;
}

function extractAttributes(assertionDoc: XmlDocument): Record<string, string[]> {
  const attributes: Record<string, string[]> = {};
  const attrNodes = xpath.select(
    "//*[local-name()='Attribute' and namespace-uri()='urn:oasis:names:tc:SAML:2.0:assertion']",
    asDomNode(assertionDoc),
  ) as unknown as XmlElement[];

  for (const attr of attrNodes) {
    const name = attr.getAttribute('Name');
    if (!name) continue;
    const valueNodes = xpath.select(
      ".//*[local-name()='AttributeValue']",
      asDomNode(attr),
    ) as Node[];
    const values = valueNodes.map((n) => n.textContent?.trim() ?? '').filter((v) => v.length > 0);
    attributes[name] = values;
  }

  return attributes;
}
