import { defineChat } from '../../define/defineChat.js';
import { defineChatEvaluation } from '../../define/defineChatEvaluation.js';
import { staticContext } from '../../context/static-context.js';

const audienceChat = defineChat({
  name: 'audienceEval',
  access: {},
  policy: {
    audience: { roles: ['user', 'admin'], mode: 'strict' },
    scope: { description: 'Test scope' },
  },
  context: [
    staticContext({
      id: 'adminOnly',
      items: [{ id: '1', kind: 'text', content: 'admin secret' }],
      includeIf: (t) => t.audience === 'admin',
    }),
  ],
});

export const audienceFilterEval = defineChatEvaluation({
  name: 'audienceFilterEval',
  chat: audienceChat,
  scenarios: [
    {
      name: 'allows own billing status',
      given: { audience: 'user' },
      when: { send: 'hello' },
      then: [{ type: 'expectInScope', value: true }],
    },
  ],
});

export const scopeRefusalEval = defineChatEvaluation({
  name: 'scopeRefusalEval',
  chat: defineChat({
    name: 'scopeEval',
    access: {},
    policy: { scope: { description: 'Only billing' } },
  }),
  scenarios: [
    {
      name: 'scope notice',
      given: {},
      when: { send: 'write me a poem about cats' },
      then: [{ type: 'expectNoticeEmitted', code: 'chat.out_of_scope' }],
    },
  ],
});

export const actionConfirmationEval = defineChatEvaluation({
  name: 'actionConfirmationEval',
  chat: defineChat({
    name: 'actionEval',
    access: {},
    policy: { action: { allowedCapabilities: ['testCap'] } },
  }),
  scenarios: [
    {
      name: 'pending action',
      given: {},
      when: { send: 'run action' },
      then: [{ type: 'expectInScope', value: true }],
    },
  ],
});
