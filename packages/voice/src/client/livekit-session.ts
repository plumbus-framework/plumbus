import type { VoiceEvent } from '../types/event.js';
import type { SerializedNoiseCancellation } from '../types/noise-cancellation.js';
import {
  applyClientNoiseCancellation,
  micConstraintsForNoiseCancellation,
  resolvedNoiseCancellationFromToken,
} from './client-noise-cancellation.js';
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
  tokenRequestBody?: Record<string, unknown>;
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
  noiseCancellation?: SerializedNoiseCancellation;
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
    body: JSON.stringify({ voiceName: options.voiceName, ...options.tokenRequestBody }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Failed to mint LiveKit voice token (${tokenResponse.status})`);
  }

  const body = (await tokenResponse.json()) as LiveKitTokenResponse;
  const agentAudioTrackName = resolveAgentAudioTrackName(body);
  const noiseCancellation = resolvedNoiseCancellationFromToken(body.noiseCancellation);
  const room = new livekit.Room();
  const audioCaptureCleanups = new Map<string, () => void>();
  const attachedAudioElements = new Map<string, HTMLMediaElement>();
  let activeAgentAudioTrackSid: string | undefined;

  room.on(livekit.RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    const parsed = parseLiveKitVoiceDataPayload(payload);
    const event = coerceVoiceEvent(parsed);
    console.info('[voice-client] data event received', {
      type: typeof event === 'object' && event !== null ? event.type : undefined,
      topic,
    });
    options.onEvent?.(event);
  });

  const releaseAgentAudio = (trackSid: string) => {
    audioCaptureCleanups.get(trackSid)?.();
    audioCaptureCleanups.delete(trackSid);
    const element = attachedAudioElements.get(trackSid);
    if (element) {
      try {
        (element as HTMLMediaElement).pause?.();
      } catch {
        // ignore
      }
      element.remove?.();
      attachedAudioElements.delete(trackSid);
      console.info('[voice-client] removed agent audio sink', {
        trackSid,
        sinkCount: attachedAudioElements.size,
      });
    }
    if (activeAgentAudioTrackSid === trackSid) {
      activeAgentAudioTrackSid = undefined;
    }
  };

  const removeAllAgentAudioSinks = () => {
    for (const trackSid of [...attachedAudioElements.keys()]) {
      releaseAgentAudio(trackSid);
    }
    for (const cleanup of audioCaptureCleanups.values()) {
      cleanup();
    }
    audioCaptureCleanups.clear();
    activeAgentAudioTrackSid = undefined;
  };

  const subscribeAgentAudio = (
    track: import('livekit-client').RemoteTrack,
    publication: import('livekit-client').RemoteTrackPublication,
  ) => {
    if (!livekit.isAudioTrack(track)) {
      console.info('[voice-client] ignored non-audio track', {
        trackName: publication.trackName,
      });
      return;
    }
    if (!isAgentAudioPublication(publication, agentAudioTrackName)) {
      console.info('[voice-client] ignored remote audio track', {
        trackName: publication.trackName,
        expectedTrackName: agentAudioTrackName,
      });
      return;
    }

    if (
      activeAgentAudioTrackSid === publication.trackSid &&
      attachedAudioElements.has(publication.trackSid)
    ) {
      console.info('[voice-client] ignored duplicate agent audio subscription', {
        trackSid: publication.trackSid,
      });
      return;
    }

    if (attachedAudioElements.size > 0) {
      console.info('[voice-client] removing stale agent audio sinks', {
        count: attachedAudioElements.size,
      });
      removeAllAgentAudioSinks();
    }

    console.info('[voice-client] subscribed to agent audio track', {
      trackName: publication.trackName,
      trackSid: publication.trackSid,
    });

    // Primary, reliable playback path: attach the remote track to a media
    // element so the browser decodes and plays it directly. Web Audio capture
    // of a remote WebRTC track is unreliable across browsers (Chrome only
    // pumps the graph when the track is also sunk to a media element), so it
    // must never be the sole playback path.
    attachedAudioElements.get(publication.trackSid)?.remove?.();
    const element = track.attach();
    element.autoplay = true;
    if ('muted' in element) {
      (element as HTMLMediaElement).muted = false;
    }
    if (typeof document !== 'undefined' && document.body) {
      element.style.display = 'none';
      document.body.appendChild(element);
    }
    void (element as HTMLMediaElement).play?.()?.catch?.(() => {
      // Autoplay can be blocked until the next user gesture; the toggle click
      // that starts the session normally satisfies the gesture requirement.
    });
    attachedAudioElements.set(publication.trackSid, element);
    activeAgentAudioTrackSid = publication.trackSid;
    console.info('[voice-client] agent audio sink attached', {
      trackSid: publication.trackSid,
      sinkCount: attachedAudioElements.size,
    });

    // Optional, best-effort PCM hook (e.g. waveform visualization). Never the
    // audible playback path — the capture graph stays muted.
    if (options.onAudioChunk) {
      audioCaptureCleanups.get(publication.trackSid)?.();
      audioCaptureCleanups.set(
        publication.trackSid,
        startRemoteAudioPcm16Capture(track, options.onAudioChunk),
      );
    }
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

  room.on(livekit.RoomEvent.TrackUnsubscribed, (_track, publication) => {
    releaseAgentAudio(publication.trackSid);
  });

  return {
    async connect() {
      removeAllAgentAudioSinks();
      await room.connect(body.url, body.token);
      const micConstraints = micConstraintsForNoiseCancellation(noiseCancellation);
      await room.localParticipant.setMicrophoneEnabled(true, micConstraints);

      const micPublication = room.localParticipant.getTrackPublication(
        livekit.Track.Source.Microphone,
      );
      const localAudioTrack = micPublication?.track;
      if (localAudioTrack && 'setProcessor' in localAudioTrack) {
        await applyClientNoiseCancellation({
          localAudioTrack: localAudioTrack as {
            setProcessor: (processor: unknown) => Promise<void>;
          },
          config: noiseCancellation,
        });
      }

      scanExistingAgentTracks();
    },
    async sendControl(payload) {
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      await room.localParticipant.publishData(encoded, { reliable: true });
    },
    async disconnect() {
      removeAllAgentAudioSinks();
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
    onChunk(
      normalizeBrowserCapturedPcm16(
        event.inputBuffer.getChannelData(0),
        event.inputBuffer.sampleRate,
      ),
    );
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
