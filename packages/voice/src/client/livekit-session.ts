import type { VoiceEvent } from '../types/event.js';
import {
  coerceVoiceEvent,
  isAgentAudioPublication,
  normalizeBrowserCapturedPcm16,
  parseLiveKitVoiceDataPayload,
  resolveAgentAudioTrackName,
} from './livekit-session-helpers.js';

export interface LiveKitVoiceSessionOptions {
  voiceName: string;
  tokenUrl: string;
  authHeader?: string;
  onEvent?: (event: VoiceEvent | Record<string, unknown>) => void;
  onAudioChunk?: (chunk: Uint8Array) => void;
}

export interface LiveKitVoiceSessionPtt {
  down(): Promise<void>;
  up(payload?: Record<string, unknown>): Promise<void>;
}

export interface LiveKitVoiceSession {
  connect(): Promise<void>;
  sendControl(payload: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  ptt: LiveKitVoiceSessionPtt;
}

interface LiveKitTokenResponse {
  url: string;
  token: string;
  room: string;
  identity: string;
  audioTrackName?: string;
  agentAudioTrackName?: string;
  mode?: string;
}

export async function createLiveKitVoiceSession(
  options: LiveKitVoiceSessionOptions,
): Promise<LiveKitVoiceSession> {
  let livekit: typeof import('livekit-client');
  try {
    livekit = await import('livekit-client');
  } catch {
    throw new Error(
      'livekit-client is required for createLiveKitVoiceSession — install it as a dependency of your app',
    );
  }

  const tokenResponse = await fetch(options.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.authHeader ? { authorization: options.authHeader } : {}),
    },
    body: JSON.stringify({ voiceName: options.voiceName }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Failed to mint LiveKit voice token (${tokenResponse.status})`);
  }

  const body = (await tokenResponse.json()) as LiveKitTokenResponse;
  const agentAudioTrackName = resolveAgentAudioTrackName(body);
  const room = new livekit.Room();
  const audioCaptureCleanups = new Map<string, () => void>();

  room.on(livekit.RoomEvent.DataReceived, (payload) => {
    const parsed = parseLiveKitVoiceDataPayload(payload);
    options.onEvent?.(coerceVoiceEvent(parsed));
  });

  const subscribeAgentAudio = (
    track: import('livekit-client').RemoteTrack,
    publication: import('livekit-client').RemoteTrackPublication,
  ) => {
    if (!livekit.isAudioTrack(track) || !options.onAudioChunk) {
      return;
    }
    if (!isAgentAudioPublication(publication, agentAudioTrackName)) {
      return;
    }

    audioCaptureCleanups.get(publication.trackSid)?.();
    audioCaptureCleanups.set(
      publication.trackSid,
      startRemoteAudioPcm16Capture(track, options.onAudioChunk),
    );
  };

  const scanExistingAgentTracks = () => {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track && publication.isSubscribed) {
          subscribeAgentAudio(publication.track, publication);
        }
      }
    }
  };

  room.on(livekit.RoomEvent.TrackSubscribed, (track, publication) => {
    subscribeAgentAudio(track, publication);
  });

  return {
    async connect() {
      await room.connect(body.url, body.token);
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      scanExistingAgentTracks();
    },
    async sendControl(payload) {
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      await room.localParticipant.publishData(encoded, { reliable: true });
    },
    async disconnect() {
      for (const cleanup of audioCaptureCleanups.values()) {
        cleanup();
      }
      audioCaptureCleanups.clear();
      await room.disconnect();
    },
    ptt: {
      async down() {
        const encoded = new TextEncoder().encode(JSON.stringify({ type: 'ptt.down' }));
        await room.localParticipant.publishData(encoded, { reliable: true });
      },
      async up(payload = {}) {
        const encoded = new TextEncoder().encode(JSON.stringify({ type: 'ptt.up', ...payload }));
        await room.localParticipant.publishData(encoded, { reliable: true });
      },
    },
  };
}

function startRemoteAudioPcm16Capture(
  track: { mediaStreamTrack: MediaStreamTrack },
  onChunk: (chunk: Uint8Array) => void,
): () => void {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  processor.onaudioprocess = (event) => {
    onChunk(normalizeBrowserCapturedPcm16(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate));
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);
  void audioContext.resume();

  return () => {
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    silentGain.disconnect();
    void audioContext.close();
  };
}
