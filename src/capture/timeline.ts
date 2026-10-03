import { invariant, StuError } from '../errors.js';
import type { CancellationSignal, PenSample } from '../types.js';

export interface TimelinePoint {
  readonly sample: PenSample;
  readonly hostElapsedMs: number;
  /** Raw device counter units, unwrapped within a connection epoch. Not host milliseconds. */
  readonly deviceTicks?: number;
}

/** A 16-bit counter cannot reveal multiple complete wraps between adjacent samples. */
export function buildTimeline(samples: readonly PenSample[]): readonly TimelinePoint[] {
  let previous: PenSample | undefined;
  let ticks: number | undefined;
  const first = samples[0]?.receivedAt ?? 0;
  return Object.freeze(
    samples.map((sample) => {
      if (sample.deviceTime === undefined) ticks = undefined;
      else if (
        ticks === undefined ||
        previous?.deviceTime === undefined ||
        previous.sessionEpoch !== sample.sessionEpoch
      )
        ticks = sample.deviceTime;
      else ticks += (sample.deviceTime - previous.deviceTime + 65536) % 65536;
      previous = sample;
      return Object.freeze({
        sample,
        hostElapsedMs: Math.max(0, sample.receivedAt - first),
        ...(ticks === undefined ? {} : { deviceTicks: ticks }),
      });
    }),
  );
}

export interface ReplayOptions {
  readonly speed?: number;
  readonly signal?: CancellationSignal;
  /** Skip waits while preserving sample order. */
  readonly immediate?: boolean;
}

export async function* replaySamples(
  samples: readonly PenSample[],
  options: ReplayOptions = {},
): AsyncIterableIterator<PenSample> {
  const speed = options.speed ?? 1,
    signal = options.signal,
    immediate = options.immediate ?? false;
  invariant(Number.isFinite(speed) && speed > 0, 'Replay speed must be positive');
  invariant(typeof immediate === 'boolean', 'Invalid replay timing option');
  let previous: PenSample | undefined;
  for (const sample of samples) {
    if (signal?.aborted) throw new StuError('ABORTED', 'Replay aborted');
    if (previous && !immediate) {
      const elapsed = Math.max(0, sample.receivedAt - previous.receivedAt) / speed;
      invariant(Number.isFinite(elapsed), 'Replay interval is too large');
      await wait(elapsed, signal);
    }
    previous = sample;
    yield sample;
  }
}

async function wait(milliseconds: number, signal: CancellationSignal | undefined): Promise<void> {
  while (milliseconds > 0) {
    const interval = Math.min(milliseconds, 2_147_483_647);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        cleanup();
        reject(new StuError('ABORTED', 'Replay aborted'));
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, interval);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    milliseconds -= interval;
  }
  if (signal?.aborted) throw new StuError('ABORTED', 'Replay aborted');
}
