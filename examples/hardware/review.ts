export type TechnicalResult = 'running' | 'passed' | 'failed' | 'skipped';
export type Confirmation = 'matches' | 'differs' | 'not-checked' | 'acknowledged' | 'cancelled';
export type Verdict = 'pending' | 'passed' | 'failed' | 'skipped' | 'cancelled';

export function verdict(technical: TechnicalResult, confirmation?: Confirmation): Verdict {
  if (technical === 'failed') return 'failed';
  if (confirmation === 'cancelled') return 'cancelled';
  if (technical === 'skipped') return 'skipped';
  if (technical === 'running' || confirmation === undefined) return 'pending';
  if (confirmation === 'matches') return 'passed';
  if (confirmation === 'differs') return 'failed';
  return 'skipped';
}

/** One explicit user decision at a time; cancellation also releases a waiting step. */
export class ReviewGate<T> {
  private settle: ((answer: T) => void) | undefined;

  wait(signal: AbortSignal): Promise<T> {
    if (this.settle) throw new Error('A review is already waiting');
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        this.settle = undefined;
        signal.removeEventListener('abort', cancel);
      };
      const cancel = (): void => {
        cleanup();
        reject(signal.reason);
      };
      this.settle = (answer) => {
        cleanup();
        resolve(answer);
      };
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  answer(answer: T): boolean {
    if (!this.settle) return false;
    this.settle(answer);
    return true;
  }
}
