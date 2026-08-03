import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  concatAudioChunks,
  estimateAudioSeconds,
  fileExtensionForContentType,
  readOption,
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
import { toFile } from 'openai';
import { OPENAI_WHISPER_STT_DESCRIPTOR, OPENAI_WHISPER_STT_MODELS } from './descriptor.js';
import {
  type OpenAIAudioClientLike,
  resolveOpenAIBaseURL,
  resolveOpenAIClientFactory,
} from './openai-client.js';
import { OPENAI_VOICE_PRICING } from './pricing.js';

class OpenAIWhisperSTTProvider implements STTProvider {
  readonly capabilities = OPENAI_WHISPER_STT_DESCRIPTOR;
  readonly #apiKey: string;
  readonly #baseURL: string | undefined;
  readonly #clientFactory: ReturnType<typeof resolveOpenAIClientFactory>;
  readonly #model: string;
  readonly #prompt: string | undefined;
  #audioInputSeconds = 0;
  #audioChunks: Uint8Array[] = [];
  #client: OpenAIAudioClientLike | undefined;
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
    this.#baseURL = resolveOpenAIBaseURL(credentials);
    this.#clientFactory = resolveOpenAIClientFactory(credentials);
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
    const upload = createUploadBlob(audio, this.#contentType);
    const file = await toFile(upload, `turn.${fileExtensionForContentType(upload.type)}`);
    const language = this.voiceSlice.languages?.[0];
    const client = this.#getClient();

    let result: { text?: string | null };
    try {
      result = await client.audio.transcriptions.create({
        file,
        model: this.#model,
        response_format: 'json',
        ...(language ? { language } : {}),
        ...(this.#prompt ? { prompt: this.#prompt } : {}),
      });
    } catch (error) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `OpenAI transcription request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = typeof result.text === 'string' ? result.text.trim() : '';
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

  #getClient(): OpenAIAudioClientLike {
    if (!this.#client) {
      this.#client = this.#clientFactory({
        apiKey: this.#apiKey,
        baseURL: this.#baseURL,
      });
    }
    return this.#client;
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
