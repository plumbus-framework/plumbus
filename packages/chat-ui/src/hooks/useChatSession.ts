'use client';

import { useState } from 'react';

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
