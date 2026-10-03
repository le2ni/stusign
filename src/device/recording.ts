import { Recorder } from '../capture/index.js';
import type { CaptureMetadata, Signature } from '../capture/index.js';
import { StuError } from '../errors.js';
import type { OperationOptions, PenSample } from '../types.js';

export interface CaptureOptions {
  readonly encryption: 'required' | 'none';
  readonly maxSamples?: number;
}
export interface CaptureOwner {
  begin(recording: Recording, options: OperationOptions): Promise<CaptureMetadata>;
  end(recording: Recording, options: OperationOptions): Promise<void>;
}
export type RecordingState =
  'idle' | 'starting' | 'recording' | 'stopping' | 'finished' | 'cancelled' | 'failed';

export class Recording {
  private readonly recorder: Recorder;
  private metadata: CaptureMetadata | undefined;
  private failure: Error | undefined;
  private phase: RecordingState = 'idle';
  private starting: Promise<void> | undefined;
  private finishing: Promise<Signature> | undefined;
  private cancelling: Promise<void> | undefined;
  private cancelRequested = false;
  constructor(
    private readonly owner: CaptureOwner,
    readonly options: CaptureOptions,
  ) {
    this.options = Object.freeze({ ...options });
    if (options.encryption !== 'required' && options.encryption !== 'none')
      throw new StuError('INVALID_ARGUMENT', 'Choose an explicit capture encryption policy');
    this.recorder = new Recorder(options.maxSamples);
  }
  get state(): RecordingState {
    return this.phase;
  }
  get sampleCount(): number {
    return this.recorder.count;
  }
  start(options: OperationOptions = {}): Promise<void> {
    if (this.phase !== 'idle')
      return Promise.reject(new StuError('INVALID_STATE', 'Recording has already been started'));
    this.phase = 'starting';
    this.starting = Promise.resolve().then(async () => {
      try {
        if (this.cancelRequested) throw new StuError('ABORTED', 'Recording cancelled');
        this.metadata = await this.owner.begin(this, options);
        if (this.cancelRequested) throw new StuError('ABORTED', 'Recording cancelled');
        if (this.failure) throw this.failure;
        this.phase = 'recording';
      } catch (error) {
        if (!this.cancelRequested) this.fail(error);
        throw error;
      }
    });
    return this.starting;
  }
  /** @internal Called before public event listeners. */
  accept(sample: PenSample): void {
    if (this.cancelRequested) return;
    if (this.phase !== 'starting' && this.phase !== 'recording' && this.phase !== 'stopping')
      return;
    if (this.options.encryption === 'required' && !sample.encrypted) return;
    try {
      this.recorder.push(sample);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  /** @internal */
  fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new StuError('INVALID_STATE', 'Capture failed');
    this.phase = 'failed';
  }
  finish(options: OperationOptions = {}): Promise<Signature> {
    if (this.cancelRequested) return Promise.reject(new StuError('ABORTED', 'Recording cancelled'));
    if (this.finishing) return this.finishing;
    if (this.failure) return Promise.reject(this.failure);
    if (this.phase !== 'recording' || !this.metadata)
      return Promise.reject(new StuError('INVALID_STATE', 'Recording is not active'));
    const metadata = this.metadata;
    this.phase = 'stopping';
    this.finishing = Promise.resolve().then(async () => {
      try {
        await this.owner.end(this, options);
        if (this.cancelRequested) throw new StuError('ABORTED', 'Recording cancelled');
        if (this.failure) throw this.failure;
        const signature = this.recorder.finish(metadata);
        this.phase = 'finished';
        return signature;
      } catch (error) {
        if (!this.cancelRequested) this.fail(error);
        throw error;
      }
    });
    return this.finishing;
  }
  cancel(options: OperationOptions = {}): Promise<void> {
    if (this.cancelling) return this.cancelling;
    if (this.phase === 'finished' || this.phase === 'cancelled') return Promise.resolve();
    this.cancelRequested = true;
    this.phase = 'stopping';
    this.cancelling = Promise.resolve().then(async () => {
      try {
        await this.starting?.catch(() => {});
        // A concurrent finish already owns protocol cleanup. Cancellation still
        // prevents it from returning a signature once that cleanup completes.
        if (this.finishing)
          await this.finishing.catch((error: unknown) => {
            if (!(error instanceof StuError && error.code === 'ABORTED')) throw error;
          });
        else await this.owner.end(this, options);
      } finally {
        this.recorder.clear();
        this.metadata = undefined;
        this.starting = undefined;
        this.finishing = undefined;
        this.phase = 'cancelled';
      }
    });
    return this.cancelling;
  }
  async dispose(): Promise<void> {
    if (this.phase !== 'finished') await this.cancel();
    else {
      this.recorder.clear();
      this.metadata = undefined;
      // A settled finish promise retains its Signature until released too.
      this.finishing = undefined;
      this.starting = undefined;
    }
  }
}
