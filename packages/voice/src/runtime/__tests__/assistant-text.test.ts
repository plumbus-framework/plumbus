import { describe, expect, it } from 'vitest';
import { stripVoiceAssistantMarkers } from '../assistant-text.js';

describe('stripVoiceAssistantMarkers', () => {
  it('removes END_SESSION and REFLECTED markers', () => {
    expect(stripVoiceAssistantMarkers('Hello [END_SESSION] world')).toBe('Hello  world');
    expect(stripVoiceAssistantMarkers('Done [REFLECTED:topic] now')).toBe('Done  now');
  });
});
