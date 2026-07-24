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
  confirmUrl,
  className,
}: {
  chatName: string;
  audience: string;
  locale: string;
  sessionId: string;
  persistence?: 'server' | 'client';
  turnUrl?: string;
  confirmUrl?: string;
  className?: string;
}) {
  const chat = useChat({ chatName, sessionId, audience, locale, persistence, turnUrl, confirmUrl });

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
        onConfirm={() => void chat.confirm(chat.pendingConfirmation?.actionId ?? '')}
        onReject={() => void chat.decline(chat.pendingConfirmation?.actionId ?? '')}
        busy={chat.status === 'streaming'}
      />
      <ChatInput pending={chat.status === 'streaming'} onSend={(t) => void chat.send(t)} />
    </div>
  );
}
