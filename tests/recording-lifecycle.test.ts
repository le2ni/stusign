import { describe, expect, it, vi } from 'vitest';
import { Recording, StuDevice } from '../src/index.js';
import type { CaptureMetadata } from '../src/index.js';
import { MockTransport, penFixture } from '../src/testing/index.js';

const metadata: CaptureMetadata = {
  dimensions: { width: 16, height: 8, maxX: 10000, maxY: 5000 },
  protection: { kind: 'plaintext' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('recording lifecycle races', () => {
  it('waits for an in-flight start before cancelling and cannot revive the recording', async () => {
    const begin = deferred<CaptureMetadata>();
    const end = vi.fn(async () => {});
    const recording = new Recording({ begin: () => begin.promise, end }, { encryption: 'none' });
    const start = recording.start();
    const rejected = expect(start).rejects.toMatchObject({ code: 'ABORTED' });
    await Promise.resolve();
    const cancel = recording.cancel();
    expect(recording.cancel()).toBe(cancel);
    expect(end).not.toHaveBeenCalled();
    begin.resolve(metadata);
    await rejected;
    await cancel;
    expect(end).toHaveBeenCalledOnce();
    expect(recording.state).toBe('cancelled');
    expect(recording.sampleCount).toBe(0);
    await expect(recording.finish()).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('does not publish a signature if cancelled while finishing, and cleans up only once', async () => {
    const cleanup = deferred<void>();
    const end = vi.fn(() => cleanup.promise);
    const recording = new Recording({ begin: async () => metadata, end }, { encryption: 'none' });
    await recording.start();
    const finish = recording.finish();
    expect(recording.finish()).toBe(finish);
    const rejected = expect(finish).rejects.toMatchObject({ code: 'ABORTED' });
    const cancel = recording.cancel();
    cleanup.resolve();
    await rejected;
    await cancel;
    expect(end).toHaveBeenCalledOnce();
    expect(recording.state).toBe('cancelled');
  });

  it('immediate disposal prevents a queued start from acquiring the device', async () => {
    const begin = vi.fn(async () => metadata);
    const recording = new Recording({ begin, end: async () => {} }, { encryption: 'none' });
    const start = recording.start();
    const rejected = expect(start).rejects.toMatchObject({ code: 'ABORTED' });
    await recording.dispose();
    await rejected;
    expect(begin).not.toHaveBeenCalled();
    expect(recording.state).toBe('cancelled');
  });

  it('propagates cleanup failure to both finish and concurrent cancellation', async () => {
    const failure = new Error('Transport cleanup failed');
    const recording = new Recording(
      {
        begin: async () => metadata,
        end: async () => {
          throw failure;
        },
      },
      { encryption: 'none' },
    );
    await recording.start();
    const finish = recording.finish();
    const finished = expect(finish).rejects.toBe(failure);
    const cancelled = expect(recording.cancel()).rejects.toBe(failure);
    await Promise.all([finished, cancelled]);
    expect(recording.state).toBe('cancelled');
  });

  it('disposal releases the cached finished signature as well as recorder samples', async () => {
    const recording = new Recording(
      { begin: async () => metadata, end: async () => {} },
      { encryption: 'none' },
    );
    await recording.start();
    const signature = await recording.finish();
    await recording.dispose();
    expect(recording.sampleCount).toBe(0);
    await expect(recording.finish()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(signature.toJSON().format).toBe('stusign.recording');
  });

  it('releases encryption immediately and faults the connection on invalid input', async () => {
    const transport = new MockTransport();
    const dispose = vi.fn();
    const tablet = await StuDevice.open(transport, {
      readyStabilityMs: 0,
      cryptoProvider: {
        negotiate: async () => ({
          protection: { kind: 'rsa-aes', sessionId: 1, keyBits: 256 },
          decrypt: (bytes) => bytes.slice(),
          dispose,
        }),
      },
    });
    const recording = tablet.capture.create({ encryption: 'required' });
    await recording.start();
    transport.emit(1, penFixture().payload); // Plaintext is invalid during encryption.
    expect(tablet.state).toBe('faulted');
    expect(dispose).toHaveBeenCalledOnce();
    await expect(recording.finish()).rejects.toMatchObject({ code: 'ENCRYPTION' });
    await expect(tablet.getStatus()).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await recording.dispose();
    await tablet.close();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
