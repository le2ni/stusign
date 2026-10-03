import { integer, invariant, StuError } from '../errors.js';
import type { PenSample, Protection, Rectangle } from '../types.js';
import { signatureSvg } from './svg.js';
import type { SvgOptions } from './svg.js';
import { buildTimeline, replaySamples } from './timeline.js';
import type { TimelinePoint, ReplayOptions } from './timeline.js';

export type { SvgOptions } from './svg.js';
export type { TimelinePoint, ReplayOptions } from './timeline.js';
export interface CaptureDimensions {
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}
export interface CaptureMetadata {
  readonly dimensions: CaptureDimensions;
  readonly protection: Protection;
  readonly identity?: { readonly model: string; readonly serial?: string };
}
export interface LossIndicator {
  readonly index: number;
  readonly reason: 'sequence-gap' | 'sequence-duplicate' | 'session-change';
  readonly missing?: number;
}
export interface RecordingJSON {
  readonly format: 'stusign.recording';
  readonly version: 1;
  readonly metadata: CaptureMetadata;
  readonly samples: readonly PenSample[];
  readonly loss: readonly LossIndicator[];
}

export class Signature {
  readonly samples: readonly PenSample[];
  readonly loss: readonly LossIndicator[];
  readonly metadata: CaptureMetadata;
  constructor(
    samples: readonly PenSample[],
    metadata: CaptureMetadata,
    loss: readonly LossIndicator[] = [],
  ) {
    validateMetadata(metadata);
    invariant(
      Array.isArray(samples) && Array.isArray(loss) && loss.length <= samples.length,
      'Invalid recording data',
    );
    samples.forEach(validateSample);
    let previousLoss = -1;
    for (const item of loss) {
      invariant(item !== null && typeof item === 'object', 'Invalid loss indicator');
      integer(item.index, previousLoss + 1, samples.length - 1, 'loss index');
      invariant(
        ['sequence-gap', 'sequence-duplicate', 'session-change'].includes(item.reason),
        'Invalid loss reason',
      );
      if (item.missing !== undefined) integer(item.missing, 1, 65535, 'missing samples');
      previousLoss = item.index;
    }
    this.samples = Object.freeze(samples.map((sample) => Object.freeze({ ...sample })));
    this.loss = Object.freeze(loss.map((item) => Object.freeze({ ...item })));
    this.metadata = Object.freeze({
      ...metadata,
      dimensions: Object.freeze({ ...metadata.dimensions }),
      protection: Object.freeze({ ...metadata.protection }),
      ...(metadata.identity ? { identity: Object.freeze({ ...metadata.identity }) } : {}),
    });
    Object.freeze(this);
  }

  get hasInk(): boolean {
    return this.samples.some((sample) => sample.touching && sample.inProximity);
  }
  get durationMs(): number {
    return this.samples.length < 2
      ? 0
      : Math.max(
          0,
          this.samples[this.samples.length - 1]!.receivedAt - this.samples[0]!.receivedAt,
        );
  }
  get complete(): boolean {
    return this.loss.length === 0;
  }
  get contactSamples(): readonly PenSample[] {
    return Object.freeze(this.samples.filter((sample) => sample.touching && sample.inProximity));
  }
  get timeline(): readonly TimelinePoint[] {
    return buildTimeline(this.samples);
  }
  replay(options: ReplayOptions = {}): AsyncIterableIterator<PenSample> {
    return replaySamples(this.samples, options);
  }

  get strokes(): readonly (readonly PenSample[])[] {
    const strokes: PenSample[][] = [];
    const breaks = new Set(this.loss.map((loss) => loss.index));
    let current: PenSample[] | undefined;
    this.samples.forEach((sample, index) => {
      if (breaks.has(index)) current = undefined;
      if (sample.touching && sample.inProximity) {
        if (!current) {
          current = [];
          strokes.push(current);
        }
        current.push(sample);
      } else current = undefined;
    });
    return strokes.map((stroke) => Object.freeze(stroke));
  }

  get bounds(): Rectangle | null {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const sample of this.samples)
      if (sample.touching && sample.inProximity) {
        left = Math.min(left, sample.x);
        top = Math.min(top, sample.y);
        right = Math.max(right, sample.x);
        bottom = Math.max(bottom, sample.y);
      }
    return left === Infinity
      ? null
      : Object.freeze({ x: left, y: top, width: right - left, height: bottom - top });
  }

  toSVG(options: SvgOptions = {}): string {
    return signatureSvg(this, options);
  }
  toJSON(options: { readonly includeDeviceIdentity?: boolean } = {}): RecordingJSON {
    const { identity, ...metadata } = this.metadata;
    return {
      format: 'stusign.recording',
      version: 1,
      metadata:
        options.includeDeviceIdentity && identity
          ? { ...metadata, identity: { ...identity } }
          : metadata,
      samples: this.samples.map((sample) => ({ ...sample })),
      loss: this.loss.map((loss) => ({ ...loss })),
    };
  }

  /** Treat imported protection metadata as a claim, never as authentication. */
  static fromJSON(value: unknown, maxSamples = 1_000_000): Signature {
    integer(maxSamples, 1, 10_000_000, 'maxSamples');
    invariant(typeof value === 'object' && value !== null, 'Recording must be an object');
    const json = value as RecordingJSON;
    invariant(
      json.format === 'stusign.recording' && json.version === 1,
      'Unsupported recording version',
    );
    invariant(
      Array.isArray(json.samples) && json.samples.length <= maxSamples && Array.isArray(json.loss),
      'Invalid or oversized recording',
    );
    return new Signature(json.samples, json.metadata, json.loss);
  }
}

function validateMetadata(metadata: CaptureMetadata): void {
  invariant(metadata !== null && typeof metadata === 'object', 'Missing recording metadata');
  invariant(
    metadata.dimensions !== null && typeof metadata.dimensions === 'object',
    'Missing capture dimensions',
  );
  for (const field of ['maxX', 'maxY', 'width', 'height'] as const) {
    const value = metadata.dimensions[field];
    invariant(Number.isFinite(value) && value > 0, `Invalid capture ${field}`);
  }
  const protection = metadata.protection;
  invariant(protection !== null && typeof protection === 'object', 'Missing capture protection');
  switch (protection.kind) {
    case 'plaintext':
      break;
    case 'rsa-aes':
    case 'dh-aes':
      integer(protection.sessionId, 0, 0xffffffff, 'session ID');
      invariant(
        (protection.kind === 'rsa-aes' ? [128, 192, 256] : [128]).includes(protection.keyBits),
        'Invalid AES key size',
      );
      break;
    case 'tls':
      invariant(protection.peerVerified === true, 'Invalid TLS protection');
      break;
    default:
      throw new StuError('INVALID_ARGUMENT', 'Unknown protection kind');
  }
  if (metadata.identity !== undefined) {
    invariant(
      metadata.identity !== null && typeof metadata.identity === 'object',
      'Invalid device identity',
    );
    invariant(
      typeof metadata.identity.model === 'string' && metadata.identity.model.length <= 256,
      'Invalid model name',
    );
    if (metadata.identity.serial !== undefined)
      invariant(
        typeof metadata.identity.serial === 'string' && metadata.identity.serial.length <= 256,
        'Invalid device serial',
      );
  }
}

function validateSample(sample: PenSample): void {
  invariant(sample !== null && typeof sample === 'object', 'Invalid pen sample');
  for (const field of ['x', 'y', 'pressure', 'switches', 'reportId', 'sessionEpoch'] as const)
    integer(sample[field], 0, 0xffffffff, field);
  invariant(
    Number.isFinite(sample.pressureNormalized) &&
      sample.pressureNormalized >= 0 &&
      sample.pressureNormalized <= 1,
    'Invalid normalized pressure',
  );
  invariant(Number.isFinite(sample.receivedAt), 'Invalid host timestamp');
  for (const field of ['inProximity', 'touching', 'encrypted'] as const)
    invariant(typeof sample[field] === 'boolean', `Invalid ${field}`);
  for (const field of ['sequence', 'deviceTime', 'option'] as const)
    if (sample[field] !== undefined) integer(sample[field], 0, 65535, field);
}

export class Recorder {
  private readonly samples: PenSample[] = [];
  private readonly loss: LossIndicator[] = [];
  private previous: PenSample | undefined;
  private failure: StuError | undefined;
  constructor(readonly maxSamples = 100_000) {
    integer(maxSamples, 1, 10_000_000, 'maxSamples');
  }
  push(sample: PenSample): void {
    if (this.failure) throw this.failure;
    validateSample(sample);
    if (this.samples.length === this.maxSamples) {
      this.failure = new StuError('CAPTURE_OVERFLOW', 'Recording sample limit exceeded');
      throw this.failure;
    }
    const index = this.samples.length;
    if (this.previous && this.previous.sessionEpoch !== sample.sessionEpoch)
      this.loss.push({ index, reason: 'session-change' });
    else if (this.previous?.sequence !== undefined && sample.sequence !== undefined) {
      const difference = (sample.sequence - this.previous.sequence + 65536) % 65536;
      if (difference === 0) this.loss.push({ index, reason: 'sequence-duplicate' });
      else if (difference !== 1)
        this.loss.push({ index, reason: 'sequence-gap', missing: difference - 1 });
    }
    const snapshot = Object.freeze({ ...sample });
    this.samples.push(snapshot);
    this.previous = snapshot;
  }
  finish(metadata: CaptureMetadata): Signature {
    if (this.failure) throw this.failure;
    return new Signature(this.samples, metadata, this.loss);
  }
  clear(): void {
    this.samples.length = 0;
    this.loss.length = 0;
    this.previous = undefined;
    this.failure = undefined;
  }
  get count(): number {
    return this.samples.length;
  }
}

export interface TransformOptions {
  readonly width: number;
  readonly height: number;
  readonly rotation?: 0 | 90 | 180 | 270;
  readonly offsetX?: number;
  readonly offsetY?: number;
}
export function transformPoint(
  point: { readonly x: number; readonly y: number },
  dimensions: CaptureDimensions,
  options: TransformOptions,
): { x: number; y: number } {
  invariant(
    [dimensions.maxX, dimensions.maxY, options.width, options.height].every(
      (value) => Number.isFinite(value) && value > 0,
    ),
    'Invalid coordinate extents',
  );
  invariant(
    [point.x, point.y, options.offsetX ?? 0, options.offsetY ?? 0].every(Number.isFinite),
    'Invalid coordinate or offset',
  );
  let x = point.x / dimensions.maxX,
    y = point.y / dimensions.maxY;
  switch (options.rotation ?? 0) {
    case 0:
      break;
    case 90:
      [x, y] = [1 - y, x];
      break;
    case 180:
      [x, y] = [1 - x, 1 - y];
      break;
    case 270:
      [x, y] = [y, 1 - x];
      break;
    default:
      throw new StuError('INVALID_ARGUMENT', 'Invalid rotation');
  }
  return {
    x: x * options.width + (options.offsetX ?? 0),
    y: y * options.height + (options.offsetY ?? 0),
  };
}
