/**
 * Light manual harness for ChatPanel (no Storybook runner required).
 * Wire this component into a dev page with a mocked `fetch` for SSE turn events.
 */
import { ChatPanel } from '../components/ChatPanel.js';

export const chatPanelStoryProps = {
  chatName: 'help',
  audience: 'user',
  locale: 'en',
  sessionId: '00000000-0000-4000-8000-000000000001',
  turnUrl: '/api/chat/help/turn',
};

export function ChatPanelStoryHarness() {
  return <ChatPanel {...chatPanelStoryProps} />;
}
