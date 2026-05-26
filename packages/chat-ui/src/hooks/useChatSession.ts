'use client';

import { useState } from 'react';

/**
 * Placeholder. Returns local `useState` defaults — `sessions` never populates,
 * `selectSession`/`clearSessions` mutate local state only. Kept on the barrel
 * so a real multi-session API can land in a future minor without a breaking
 * export change. Do not depend on its shape.
 */
export function useChatSession(_args?: { chatName?: string }) {
  const [sessions, setSessions] = useState<Array<{ id: string; label: string }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  return {
    sessions,
    activeSessionId,
    selectSession: setActiveSessionId,
    clearSessions: () => setSessions([]),
  };
}
