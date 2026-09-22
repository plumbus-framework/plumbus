import { describe, expect, it } from 'vitest';
import {
  capabilityTemplate,
  capabilityTestTemplate,
  entityTemplate,
  eventTemplate,
  flowTemplate,
  flowTestTemplate,
  localeFolderTranslationTemplate,
  localeMessagesTemplate,
  promptTemplate,
} from '../templates/resources.js';

describe('Resource templates', () => {
  it('generates capability template with correct kind and domain', () => {
    const result = capabilityTemplate('approveRefund', 'action', 'billing');
    expect(result).toContain('name: "approveRefund"');
    expect(result).toContain('kind: "action"');
    expect(result).toContain('domain: "billing"');
    expect(result).toContain('defineCapability');
    expect(result).toContain('handler: async (ctx, input)');
  });

  it('generates capability test template', () => {
    const result = capabilityTestTemplate('approveRefund', 'billing');
    expect(result).toContain('ApproveRefund');
    expect(result).toContain('describe');
  });

  it('generates entity template with fields', () => {
    const result = entityTemplate('customer');
    expect(result).toContain('defineEntity');
    expect(result).toContain('name: "Customer"');
    expect(result).toContain('field.id()');
    expect(result).toContain('tenantScoped: true');
  });

  it('generates flow template with correct structure', () => {
    const result = flowTemplate('refund-approval', 'billing');
    expect(result).toContain('defineFlow');
    expect(result).toContain('name: "refund-approval"');
    expect(result).toContain('domain: "billing"');
    expect(result).toContain('steps:');
  });

  it('generates flow test template', () => {
    const result = flowTestTemplate('refund-approval', 'billing');
    expect(result).toContain('RefundApproval Flow');
    expect(result).toContain('simulateFlow');
    expect(result).toContain('refundApprovalFlow');
  });

  it('generates event template', () => {
    const result = eventTemplate('orderPlaced');
    expect(result).toContain('defineEvent');
    expect(result).toContain('name: "orderPlaced"');
  });

  it('generates prompt template', () => {
    const result = promptTemplate('summarizeTicket');
    expect(result).toContain('definePrompt');
    expect(result).toContain('name: "summarizeTicket"');
    expect(result).toContain('model:');
  });

  it('generates locale message file template', () => {
    const result = localeMessagesTemplate();
    expect(result).toContain('export const messages');
    expect(result).toContain('satisfies Record<string, string>');
  });

  it('generates locale-folder translation assembler template', () => {
    const result = localeFolderTranslationTemplate('myNamespace');
    expect(result).toContain('defineTranslation');
    expect(result).toContain('name: "myNamespace"');
    expect(result).toContain('./en/my-namespace.messages.js');
    expect(result).toContain('./he/my-namespace.messages.js');
  });
});
