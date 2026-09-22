export interface PendingAction {
  id: string;
  sessionId: string;
  capabilityName: string;
  input: unknown;
  schemaHash: string;
  confirmationMessage: string;
  expiresAt: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired';
}
