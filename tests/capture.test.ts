import { describe, expect, it, vi } from 'vitest';
import { Recorder, Signature, transformPoint } from '../src/capture/index.js';
import { decodePen } from '../src/protocol/index.js';
import { penFixture } from '../src/testing/index.js';

const metadata = {
  dimensions: { width: 800, height: 480, maxX: 8000, maxY: 4800 },
  protection: { kind: 'plaintext' as const },
  identity: { model: 'STU-540', serial: 'sensitive' },
};
const sample = (sequence: number, touching = true) => {
  const fixture = penFixture({ sequence, touching });
  return decodePen(fixture.reportId, fixture.payload, {
    pressureMax: 1023,
    receivedAt: sequence,
    sessionEpoch: 1,
  });
};

describe('recording model', () => {
  it('handles sequence rollover and breaks strokes across actual loss', () => {
    const recorder = new Recorder();
    [65534, 65535, 0, 2, 3].forEach((sequence) => recorder.push(sample(sequence)));
    const signature = recorder.finish(metadata);
    expect(signature.loss).toEqual([{ index: 3, reason: 'sequence-gap', missing: 1 }]);
    expect(signature.strokes).toHaveLength(2);
  });
  it('separates strokes at hover and preserves raw samples', () => {
    const recorder = new Recorder();
    recorder.push(sample(1));
    recorder.push(sample(2, false));
    recorder.push(sample(3));
    const signature = recorder.finish(metadata);
    expect(signature.samples).toHaveLength(3);
    expect(signature.contactSamples).toHaveLength(2);
    expect(signature.strokes).toHaveLength(2);
    expect(signature.toSVG()).toMatch(/<circle/);
    expect(signature.toSVG()).not.toContain('sensitive');
  });
  it('exports fresh immutable snapshots and omits device identity by default', () => {
    const recorder = new Recorder();
    recorder.push(sample(0));
    const signature = recorder.finish(metadata);
    recorder.clear();
    expect(signature.samples).toHaveLength(1);
    expect(Object.isFrozen(signature.samples[0])).toBe(true);
    const exported = signature.toJSON();
    expect(exported.metadata).not.toHaveProperty('identity');
    expect(signature.toJSON({ includeDeviceIdentity: true }).metadata.identity?.serial).toBe(
      'sensitive',
    );
    expect(Signature.fromJSON(JSON.parse(JSON.stringify(exported))).samples).toEqual(
      signature.samples,
    );
  });
  it('rejects untrusted JSON and SVG injection', () => {
    const signature = new Signature([sample(1)], metadata);
    expect(() => signature.toSVG({ color: '"/><script>alert(1)</script>' })).toThrow();
    expect(() =>
      Signature.fromJSON({ ...signature.toJSON(), samples: [{ ...sample(1), x: NaN }] }),
    ).toThrow();
    expect(() => Signature.fromJSON({ ...signature.toJSON(), version: 2 })).toThrow();
  });
  it('transforms sensor coordinates without rounding away precision', () => {
    expect(
      transformPoint({ x: 4000.5, y: 2400 }, metadata.dimensions, { width: 800, height: 480 }).x,
    ).toBeCloseTo(400.05, 8);
    expect(
      transformPoint({ x: 0, y: 0 }, metadata.dimensions, {
        width: 800,
        height: 480,
        rotation: 90,
      }),
    ).toEqual({ x: 800, y: 0 });
    expect(() =>
      transformPoint({ x: 0, y: 0 }, metadata.dimensions, { width: Infinity, height: 480 }),
    ).toThrow();
    expect(() =>
      transformPoint({ x: NaN, y: 0 }, metadata.dimensions, { width: 800, height: 480 }),
    ).toThrow();
  });
  it('validates complete imported dimensions, protection and ordered loss metadata', () => {
    const json = new Signature([sample(1)], metadata).toJSON();
    const invalidMetadata = [
      { ...metadata, dimensions: {} },
      { ...metadata, protection: { kind: 'rsa-aes', keyBits: 256 } },
      { ...metadata, protection: { kind: 'rsa-aes', sessionId: 1, keyBits: 64 } },
      { ...metadata, protection: { kind: 'tls', peerVerified: false } },
      { ...metadata, identity: { model: 123 } },
    ];
    for (const value of invalidMetadata)
      expect(() => Signature.fromJSON({ ...json, metadata: value })).toThrow();
    expect(() =>
      Signature.fromJSON({ ...json, loss: [{ index: 2, reason: 'sequence-gap' }] }),
    ).toThrow();
    expect(() => Signature.fromJSON({ ...json, loss: [null] })).toThrow();
  });
  it('tracks duplicate sequences without claiming a full wrap of missing data', () => {
    const recorder = new Recorder();
    const first = { ...sample(1) };
    recorder.push(first);
    first.sequence = 100;
    recorder.push(sample(2));
    recorder.push(sample(2));
    expect(recorder.finish(metadata).loss).toEqual([{ index: 2, reason: 'sequence-duplicate' }]);
  });
  it('unwraps device time within epochs without changing raw counters or inventing timestamps', () => {
    const points = [65534, 65535, 0, 2].map((deviceTime, i) => ({
      ...sample(i),
      receivedAt: i * 5,
      deviceTime,
    }));
    points.push({ ...sample(4), receivedAt: 20, deviceTime: 1, sessionEpoch: 2 });
    const signature = new Signature(points, metadata);
    expect(signature.timeline.map((point) => point.deviceTicks)).toEqual([
      65534, 65535, 65536, 65538, 1,
    ]);
    expect(signature.timeline.map((point) => point.hostElapsedMs)).toEqual([0, 5, 10, 15, 20]);
    expect(signature.samples[2]?.deviceTime).toBe(0);
    const { deviceTime: _, ...withoutTime } = points[0]!;
    expect(new Signature([withoutTime], metadata).timeline[0]).not.toHaveProperty('deviceTicks');
  });
  it('replays host timing at a selected speed and cancels pending waits', async () => {
    vi.useFakeTimers();
    try {
      const signature = new Signature(
        [
          { ...sample(0), receivedAt: 0 },
          { ...sample(1), receivedAt: 100 },
        ],
        metadata,
      );
      const abort = new AbortController(),
        replay = signature.replay({ speed: 2, signal: abort.signal });
      expect((await replay.next()).value).toBe(signature.samples[0]);
      let delivered = false;
      const pending = replay.next().then((value) => {
        delivered = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(delivered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).value).toBe(signature.samples[1]);
      expect((await replay.next()).done).toBe(true);
      const cancelled = signature.replay({ signal: abort.signal });
      await cancelled.next();
      const waiting = cancelled.next();
      const rejected = expect(waiting).rejects.toMatchObject({ code: 'ABORTED' });
      abort.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
