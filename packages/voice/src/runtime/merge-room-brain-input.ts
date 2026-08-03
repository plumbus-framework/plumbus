export function mergeRoomBrainInput(
  brainInput: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...brainInput,
    ...(typeof metadata.projectId === 'string' ? { projectId: metadata.projectId } : {}),
    ...(typeof metadata.sessionId === 'string' ? { sessionId: metadata.sessionId } : {}),
    ...(typeof metadata.language === 'string' ? { language: metadata.language } : {}),
  };
}
