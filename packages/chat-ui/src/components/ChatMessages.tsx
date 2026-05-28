'use client';

import type { ChatUiMessage } from '../hooks/useChat.js';
import { SourceCitation } from './SourceCitation.js';

export function ChatMessages({
  messages,
  className,
}: {
  messages: ChatUiMessage[];
  className?: string;
}) {
  return (
    <div className={className}>
      {messages.map((m, i) => (
        <div key={`${m.role}-${i}`} data-role={m.role}>
          <p>{m.content}</p>
          {m.sources?.map((s) => (
            <SourceCitation key={s} label={s} />
          ))}
        </div>
      ))}
    </div>
  );
}
