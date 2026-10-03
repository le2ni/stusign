import { StuError, integer } from '../errors.js';
import type { OperationOptions } from '../types.js';

export interface Transaction {
  check(): void;
  /** A platform I/O call is always awaited before the lane is reused. */
  io<T>(operation: () => Promise<T>): Promise<T>;
  pause(ms: number): Promise<void>;
}

/** Public cancellation is prompt; the lane remains locked until work settles. */
export class Scheduler {
  private tail: Promise<void> = Promise.resolve();
  private stopped: StuError | undefined;
  private readonly pending = new Set<(error: StuError) => void>();

  run<T>(
    operation: string,
    work: (transaction: Transaction) => Promise<T>,
    options: OperationOptions = {},
  ): Promise<T> {
    const timeout = integer(options.timeoutMs ?? 15_000, 1, 2_147_483_647, 'timeoutMs');
    if (this.stopped) return Promise.reject(this.stopped);
    let failure: StuError | undefined;
    let rejectResult: (error: unknown) => void;
    let resolveResult: (value: T) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const signal = options.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.pending.delete(cancel);
    };
    const cancel = (error: StuError): void => {
      failure ??= error;
      cleanup();
      rejectResult(failure);
    };
    const abort = (): void =>
      cancel(new StuError('ABORTED', `${operation} aborted`, { operation }));
    timer = setTimeout(
      () => cancel(new StuError('TIMEOUT', `${operation} timed out`, { operation })),
      timeout,
    );
    this.pending.add(cancel);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const check = (): void => {
      if (failure) throw failure;
      if (this.stopped) throw this.stopped;
    };
    const transaction: Transaction = {
      check,
      async io<TValue>(fn: () => Promise<TValue>): Promise<TValue> {
        check();
        const value = await fn();
        check();
        return value;
      },
      async pause(ms: number): Promise<void> {
        check();
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        check();
      },
    };
    const task = this.tail.then(async () => {
      try {
        check();
        resolveResult(await work(transaction));
      } catch (error) {
        rejectResult(error);
      } finally {
        cleanup();
      }
    });
    this.tail = task.catch(() => {});
    return result;
  }

  stop(reason = new StuError('DISCONNECTED', 'Device closed')): void {
    this.stopped = reason;
    for (const cancel of this.pending) cancel(reason);
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
