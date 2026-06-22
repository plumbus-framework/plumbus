export interface LiveKitParticipantContext {
  userId: string;
  tenantId?: string;
  projectId?: string;
  sessionId: string;
  language?: string;
  metadata: Record<string, unknown>;
}

function parseMetadataString(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata
  }
  return {};
}

function readStringField(sources: Record<string, unknown>[], key: string): string | undefined {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function parseLiveKitParticipantContext(args: {
  roomName: string;
  participantIdentity: string;
  participantMetadata?: string;
  participantAttributes?: Record<string, string>;
}): LiveKitParticipantContext {
  const metadata = parseMetadataString(args.participantMetadata);
  const attributeRecord = args.participantAttributes ?? {};
  const sources = [metadata, attributeRecord];

  const sessionId =
    readStringField(sources, 'sessionId') ??
    (args.roomName.length > 0 ? args.roomName : args.participantIdentity);

  const userId = readStringField(sources, 'userId') ?? args.participantIdentity;

  const tenantId = readStringField(sources, 'tenantId');
  const projectId = readStringField(sources, 'projectId');
  const language = readStringField(sources, 'language');

  return {
    userId,
    tenantId,
    projectId,
    sessionId,
    language,
    metadata: {
      ...metadata,
      ...(tenantId ? { tenantId } : {}),
      ...(projectId ? { projectId } : {}),
      sessionId,
      userId,
      ...(language ? { language } : {}),
    },
  };
}

export function buildBrainInputFromParticipantContext(
  context: LiveKitParticipantContext,
): Record<string, unknown> {
  const brainInput: Record<string, unknown> = { sessionId: context.sessionId };
  if (context.projectId) {
    brainInput.projectId = context.projectId;
  }
  if (context.language) {
    brainInput.language = context.language;
  }
  return brainInput;
}
