const END_SESSION_MARKER = /\[END_SESSION\]/gi;
const REFLECTED_MARKER = /\[REFLECTED:[^\]]+\]/gi;

/** Strip common LLM sentinel markers before TTS playback. */
export function stripVoiceAssistantMarkers(text: string): string {
  return text.replace(END_SESSION_MARKER, '').replace(REFLECTED_MARKER, '').trim();
}
