/** Ordered voice-event delivery over LiveKit packets and native text streams. */
import { ErrorCode, PlumbusError } from '@plumbus/core/errors';

export const VOICE_EVENT_STREAM_TOPIC = 'voice.events.large';
const PACKET_BYTES = 15 * 1024;
const EVENT_BYTES = 256 * 1024;

interface DataParticipant {
  publishData(data: Uint8Array, options: { reliable: boolean; topic: string }): Promise<unknown>;
  sendText?(text: string, options: { topic: string }): Promise<unknown>;
}

export function createVoiceEventSender(
  participant: () => DataParticipant | undefined,
  topic = 'voice.events',
) {
  let tail = Promise.resolve();
  return (payload: unknown): Promise<void> => {
    const text = JSON.stringify(payload) ?? 'null';
    const encoded = new TextEncoder().encode(text);
    const job = tail.then(async () => {
      const target = participant();
      if (!target) return;
      if (encoded.byteLength > EVENT_BYTES) {
        throw new PlumbusError(ErrorCode.Validation, 'Voice event exceeds 256 KiB');
      }
      if (encoded.byteLength <= PACKET_BYTES) {
        await target.publishData(encoded, { reliable: true, topic });
      } else {
        if (!target.sendText)
          throw new PlumbusError(
            ErrorCode.DependencyViolation,
            'Large voice events require LiveKit text streams',
          );
        await target.sendText(text, { topic: VOICE_EVENT_STREAM_TOPIC });
      }
    });
    tail = job.catch(() => {});
    return job;
  };
}

export interface VoiceEventTextReader extends AsyncIterable<string> {
  signal?: AbortSignal;
}

export function createVoiceEventReceiver(
  deliver: (payload: Uint8Array) => void,
  invalid: () => void,
) {
  let pending: Promise<void> | undefined;
  let disposed = false;
  const readers = new Set<AbortController>();

  function enqueue(payload: Promise<Uint8Array>) {
    // Observe a read rejection immediately, even while it waits behind a prior event.
    const result = payload.then(
      (value) => ({ value }),
      () => ({ value: undefined }),
    );
    const job = (pending ?? Promise.resolve()).then(async () => {
      const { value } = await result;
      if (disposed) return;
      if (value) deliver(value);
      else invalid();
    });
    pending = job.catch(() => {
      if (!disposed) invalid();
    });
    const current = pending;
    void current.then(() => {
      if (pending === current) pending = undefined;
    });
  }

  async function read(reader: VoiceEventTextReader): Promise<Uint8Array> {
    if (readers.size >= 8)
      throw new PlumbusError(ErrorCode.Validation, 'Too many pending voice event streams');
    const controller = new AbortController();
    readers.add(controller);
    reader.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), 30_000);
    let bytes = 0;
    const parts: string[] = [];
    try {
      for await (const part of reader) {
        bytes += new TextEncoder().encode(part).byteLength;
        if (bytes > EVENT_BYTES)
          throw new PlumbusError(ErrorCode.Validation, 'Voice event exceeds 256 KiB');
        parts.push(part);
      }
      return new TextEncoder().encode(parts.join(''));
    } finally {
      clearTimeout(timer);
      controller.abort();
      readers.delete(controller);
    }
  }

  return {
    packet(payload: Uint8Array) {
      if (disposed) return;
      if (payload.byteLength > EVENT_BYTES) {
        invalid();
        return;
      }
      if (pending) enqueue(Promise.resolve(payload));
      else deliver(payload);
    },
    stream(reader: VoiceEventTextReader) {
      if (!disposed) enqueue(read(reader));
    },
    dispose() {
      disposed = true;
      for (const controller of readers) controller.abort();
      readers.clear();
    },
  };
}
