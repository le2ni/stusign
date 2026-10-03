import { integer, StuError } from '../errors.js';
import type { CancellationSignal, DeviceEvent, Unsubscribe } from '../types.js';

export interface EventStreamOptions {
  readonly maxBuffered?: number;
  readonly signal?: CancellationSignal;
  /** PIN and keypad events require explicit selection. */
  readonly types?: readonly DeviceEvent['type'][];
}

export function createEventStream(
  subscribe: (listener: (event: DeviceEvent) => void) => Unsubscribe,
  options: EventStreamOptions = {},
): AsyncIterableIterator<DeviceEvent> {
  const limit = integer(options.maxBuffered ?? 256, 1, 100_000, 'maxBuffered');
  const types = new Set(options.types ?? ['pen', 'error', 'disconnect']);
  const buffer: DeviceEvent[] = [];
  let finished = false,
    failure: Error | undefined;
  let pending:
    | { resolve: (result: IteratorResult<DeviceEvent>) => void; reject: (error: Error) => void }
    | undefined;
  let unsubscribe: Unsubscribe = () => {};
  const cleanup = (): void => {
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
  };
  const fail = (error: Error): void => {
    failure = error;
    finished = true;
    buffer.length = 0;
    cleanup();
    pending?.reject(error);
    pending = undefined;
  };
  const abort = (): void => fail(new StuError('ABORTED', 'Event stream aborted'));
  unsubscribe = subscribe((event) => {
    if (finished) return;
    if (!types.has(event.type)) {
      if (event.type === 'disconnect') {
        finished = true;
        cleanup();
        pending?.resolve({ value: undefined, done: true });
        pending = undefined;
      }
      return;
    }
    if (pending) {
      pending.resolve({ value: event, done: false });
      pending = undefined;
    } else if (buffer.length < limit) buffer.push(event);
    else {
      fail(new StuError('CAPTURE_OVERFLOW', 'Event stream consumer fell behind'));
      return;
    }
    if (event.type === 'disconnect') {
      finished = true;
      cleanup();
    }
  });
  if (finished) cleanup();
  else {
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  }
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (failure) throw failure;
      const event = buffer.shift();
      if (event) return { value: event, done: false };
      if (finished) return { value: undefined, done: true };
      if (pending) throw new StuError('INVALID_STATE', 'Use one event-stream consumer');
      return new Promise<IteratorResult<DeviceEvent>>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    async return() {
      finished = true;
      failure = undefined;
      buffer.length = 0;
      cleanup();
      pending?.resolve({ value: undefined, done: true });
      pending = undefined;
      return { value: undefined, done: true };
    },
  };
}
