import { createTypeSafeDecisionAdapter, DecisionProviderError } from '../dist/index.js';

if (process.env.PLUMBUS_LIVE_DECISION_TESTS !== '1') {
  throw new DecisionProviderError('typesafe', 'configuration', 'Set PLUMBUS_LIVE_DECISION_TESTS=1 to explicitly enable one live inference request');
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new DecisionProviderError('typesafe', 'configuration', 'Set TYPESAFE_API_KEY in the process environment');
const adapter = createTypeSafeDecisionAdapter({ apiKey, model: process.env.TYPESAFE_MODEL, baseUrl: process.env.TYPESAFE_BASE_URL });
const result = await adapter.decide({
  state: 'I was charged twice for my order. Please refund the duplicate charge.',
  questions: {
    department: { type: 'choice', instructions: 'Which team handles this request?', criteria: { billing: 'Payments and refunds', technical: 'Software bugs', other: 'Other requests' } },
    urgency: { type: 'score', instructions: 'How urgent is this request?', criteria: ['Routine', 'Time sensitive', 'Emergency'] },
    refund: { type: 'probability', instructions: 'Does the customer explicitly request a refund?' },
  },
});
console.log(JSON.stringify(result, null, 2));
