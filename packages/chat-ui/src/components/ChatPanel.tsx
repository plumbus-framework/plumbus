'use client';

import { useChat } from '../hooks/useChat.js';
import { ChatInput } from './ChatInput.js';
import { ChatMessages } from './ChatMessages.js';
import { ConfirmationDialog } from './ConfirmationDialog.js';

export function ChatPanel({
  chatName,
  audience,
  locale,
  sessionId,
  persistence = 'server',
  turnUrl,
  className,
}: {
  chatName: string;
  audience: string;
  locale: string;
  sessionId: string;
  persistence?: 'server' | 'client';
  turnUrl?: string;
  className?: string;
}) {
  const chat = useChat({ chatName, sessionId, audience, locale, persistence, turnUrl });

  return (
    <div className={className}>
      {chat.notices.map((n) => (
        <div key={n.code} role="status">
          {n.message}
        </div>
      ))}
      <ChatMessages messages={chat.messages} />
      <ConfirmationDialog
        pendingConfirmation={chat.pendingConfirmation}
        onConfirm={() => chat.confirm(chat.pendingConfirmation?.actionId ?? '')}
        onReject={chat.cancel}
      />
      <ChatInput pending={chat.status === 'streaming'} onSend={(t) => void chat.send(t)} />
    </div>
  );
}
