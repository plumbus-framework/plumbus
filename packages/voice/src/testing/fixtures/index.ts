export const hebrewTranscriptFixtures = Object.freeze({
  greeting: 'שלום עולם',
  conversationPrompt: 'ספרי לי על היום שלך.',
  mixedSentence: 'שלום עולם. More details follow.',
});

export const pcmSampleFrames = Object.freeze({
  silent16kMono: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]),
  pulse16kMono: Uint8Array.from([0, 32, 0, 224, 0, 64, 0, 192]),
});
