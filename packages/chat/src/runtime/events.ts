import type { ChatEvent } from '../types/event.js';

export class ChatEventEmitter {
  private queue: ChatEvent[] = [];
  private resolvers: Array<(evt: ChatEvent | null) => void> = [];
  private ended = false;

  emit(evt: ChatEvent): void {
    if (this.ended) return;
    const resolver = this.resolvers.shift();
    if (resolver) resolver(evt);
    else this.queue.push(evt);
  }

  end(): void {
    this.ended = true;
    for (const r of this.resolvers) r(null);
    this.resolvers = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
    return {
      next: () =>
        new Promise((resolve) => {
          if (this.queue.length > 0) {
            resolve({ value: this.queue.shift() as ChatEvent, done: false });
            return;
          }
          if (this.ended) {
            resolve({ value: undefined, done: true });
            return;
          }
          this.resolvers.push((evt) => {
            if (evt === null) resolve({ value: undefined, done: true });
            else resolve({ value: evt, done: false });
          });
        }),
    };
  }
}

export async function* emitterToIterable(emitter: ChatEventEmitter): AsyncIterable<ChatEvent> {
  for await (const evt of emitter) {
    yield evt;
  }
}
