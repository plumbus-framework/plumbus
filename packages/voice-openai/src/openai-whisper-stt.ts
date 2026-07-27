import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  concatAudioChunks,
  estimateAudioSeconds,
  fileExtensionForContentType,
  type RuntimeFetch,
  readOption,
  resolveHttpBaseUrl,
  resolveRuntimeFetch,
  roundMetric,
  type STTProvider,
  type STTProviderAudioChunk,
  type STTProviderConnectArgs,
  type STTProviderRegistration,
  type STTProviderTranscriptEvent,
  toBlob,
  toBlobPart,
  type VoiceProviderCredentials,
  type VoiceSttConfig,
  wrapPcm16AsWav,
} from '@plumbus/voice/provider-kit';
import { OPENAI_WHISPER_STT_DESCRIPTOR, OPENAI_WHISPER_STT_MODELS } from './descriptor.js';
import { OPENAI_VOICE_PRICING } from './pricing.js';

class OpenAIWhisperSTTProvider implements STTProvider {
  readonly capabilities = OPENAI_WHISPER_STT_DESCRIPTOR;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: RuntimeFetch;
  readonly #model: string;
  readonly #prompt: string | undefined;
  #audioInputSeconds = 0;
  #audioChunks: Uint8Array[] = [];
  #connectArgs: STTProviderConnectArgs | undefined;
  #contentType: string | undefined;
  #finalizedTranscript: STTProviderTranscriptEvent | undefined;
  #sessionId: string | undefined;

  constructor(
    credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceSttConfig,
  ) {
    if (!credentials.apiKey) {
      throw new PlumbusError(
        ErrorCode.Validation,
        'OpenAI Whisper STT provider requires an apiKey',
      );
    }
    this.#apiKey = credentials.apiKey;
    this.#baseUrl = resolveHttpBaseUrl(credentials, 'https://api.openai.com/v1');
    this.#fetch = resolveRuntimeFetch(credentials, voiceSlice);
    this.#model = voiceSlice.model ?? OPENAI_WHISPER_STT_MODELS[0]?.id ?? 'whisper-1';
    this.#prompt = readOption<string>(voiceSlice.options, 'prompt');
  }

  connect(args: STTProviderConnectArgs): void {
    this.#sessionId = args.sessionId;
    this.#connectArgs = args;
  }

  sendAudio(audio: STTProviderAudioChunk): void {
    this.#audioInputSeconds += estimateAudioSeconds(audio);
    this.#audioChunks.push(audio.chunk);
    this.#contentType = audio.contentType ?? this.#contentType;
  }

  onClientTranscript(_event: STTProviderTranscriptEvent): void {}

  async finalize(): Promise<STTProviderTranscriptEvent | undefined> {
    if (this.#finalizedTranscript) {
      return this.#finalizedTranscript;
    }
    if (this.#audioChunks.length === 0) {
      return undefined;
    }

    const audio = concatAudioChunks(this.#audioChunks);
    const form = new FormData();
    const file = createUploadBlob(audio, this.#contentType);
    form.set('file', file, `turn.${fileExtensionForContentType(file.type)}`);
    form.set('model', this.#model);
    form.set('response_format', 'json');

    const language = this.voiceSlice.languages?.[0];
    if (language) {
      form.set('language', language);
    }
    if (this.#prompt) {
      form.set('prompt', this.#prompt);
    }

    const response = await this.#fetch(`${this.#baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `OpenAI transcription request failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as { text?: unknown };
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      return undefined;
    }

    this.#finalizedTranscript = {
      text,
      final: true,
      language,
    };
    await this.#connectArgs?.onTranscript?.(this.#finalizedTranscript);
    return this.#finalizedTranscript;
  }

  usage() {
    if (this.#audioInputSeconds <= 0) {
      return [];
    }

    return [
      {
        provider: this.capabilities.id,
        kind: 'transcribe' as const,
        quantity: roundMetric(this.#audioInputSeconds),
        unit: 'seconds' as const,
        model: this.voiceSlice.model ?? OPENAI_WHISPER_STT_MODELS[0]?.id ?? 'whisper-1',
        metadata: { sessionId: this.#sessionId, streaming: false },
      },
    ];
  }
}

export const OPENAI_WHISPER_STT_REGISTRATION: STTProviderRegistration = {
  descriptor: OPENAI_WHISPER_STT_DESCRIPTOR,
  pricing: Object.values(OPENAI_VOICE_PRICING).filter(
    (entry) => entry.operation === 'transcribe' && entry.unit === 'audioInputSeconds',
  ),
  create(credentials, voiceSlice) {
    return new OpenAIWhisperSTTProvider(credentials, voiceSlice);
  },
};

function createUploadBlob(audio: Uint8Array, contentType: string | undefined): Blob {
  const normalizedType = (contentType ?? '').toLowerCase();
  if (normalizedType.includes('pcm')) {
    return wrapPcm16AsWav(audio, contentType);
  }
  return toBlob([toBlobPart(audio)], contentType ?? 'application/octet-stream');
}
