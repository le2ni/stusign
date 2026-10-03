import { describe, expect, it, vi } from 'vitest';
import { StuDevice, StuError } from '../src/index.js';
import { MockTransport, penFixture } from '../src/testing/index.js';
import { ReportId, encodeImage } from '../src/protocol/index.js';
import { Scheduler } from '../src/device/scheduler.js';

const image = (): ReturnType<typeof encodeImage> =>
  encodeImage({ width: 16, height: 8, data: new Uint8Array(16 * 8 * 4) }, { format: 'bgr24' });
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('device services', () => {
  it('opens, captures, exports and disposes with no browser globals', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    const recording = tablet.capture.create({ encryption: 'none' });
    await recording.start();
    const sample = penFixture();
    transport.emit(sample.reportId, sample.payload, 10);
    transport.emit(1, penFixture({ x: 4500 }).payload, 20);
    await tablet.display.clear();
    expect(recording.sampleCount).toBe(2);
    const signature = await recording.finish();
    expect(signature.hasInk).toBe(true);
    expect(signature.durationMs).toBe(10);
    expect(signature.toSVG()).toContain('<path');
    expect(signature.toJSON().metadata).not.toHaveProperty('identity');
    await tablet.close();
    await tablet.close();
    expect(transport.calls.filter((call) => call.kind === 'close')).toHaveLength(1);
  });
  it('does not create two command queues for the same transport', async () => {
    const transport = new MockTransport();
    const first = await StuDevice.open(transport);
    await expect(StuDevice.open(transport)).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    expect(first.state).toBe('open');
    expect((await first.getStatus()).status).toBe(0);
    await first.close();
    const second = await StuDevice.open(transport);
    await second.close();
  });
  it('serializes entire uploads and awaits the final short block before committing', async () => {
    const transport = new MockTransport({
      blockCapacity: 253,
      beforeWrite: async () => {
        await tick();
      },
    });
    const tablet = await StuDevice.open(transport);
    await Promise.all([tablet.display.writeEncodedImage(image()), tablet.settings.setInking(true)]);
    const writes = transport.calls.filter((call) => call.kind === 'write');
    expect(writes.map((call) => call.id)).toEqual([0x25, 0x26, 0x26, 0x27, 0x21]);
    expect(writes[2]!.payload?.slice(0, 2)).toEqual(Uint8Array.of(131, 0));
    await tablet.close();
  });
  it('abandons a failed upload and permits a subsequent transfer', async () => {
    let shouldFail = true;
    const transport = new MockTransport({
      beforeWrite: async (id) => {
        if (id === 0x26 && shouldFail) {
          shouldFail = false;
          throw new Error('Synthetic I/O error');
        }
      },
    });
    const tablet = await StuDevice.open(transport);
    await expect(tablet.display.writeEncodedImage(image())).rejects.toThrow('Synthetic');
    expect(transport.calls.filter((call) => call.id === 0x27).at(-1)?.payload).toEqual(
      Uint8Array.of(1),
    );
    await tablet.display.writeEncodedImage(image());
    await tablet.close();
  });
  it('snapshots a queued Node Buffer image instead of retaining its shared slice', async () => {
    const transport = new MockTransport({ blockCapacity: 1024 });
    const tablet = await StuDevice.open(transport, { readyStabilityMs: 0 });
    const encoded = image();
    const data = Buffer.from(encoded.data);
    const uploading = tablet.display.writeEncodedImage({ ...encoded, data });
    data.fill(0);
    await uploading;
    const block = transport.calls.find((call) => call.kind === 'write' && call.id === 0x26);
    expect(block?.payload?.subarray(2, 2 + encoded.data.length)).toEqual(encoded.data);
    await tablet.close();
  });
  it('cancels an upload without interleaving the next write or committing it', async () => {
    const abort = new AbortController();
    const transport = new MockTransport({
      beforeWrite: async (id) => {
        if (id === 0x26) abort.abort();
      },
    });
    const tablet = await StuDevice.open(transport);
    await expect(
      tablet.display.writeEncodedImage(image(), { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await tablet.settings.setInking(false);
    const writes = transport.calls.filter((call) => call.kind === 'write');
    expect(writes.map((call) => call.id)).toEqual([0x25, 0x26, 0x27, 0x21]);
    expect(writes[2]!.payload).toEqual(Uint8Array.of(1));
    await tablet.close();
  });
  it('rejects unsupported and invalid settings before sending writes', async () => {
    const transport = new MockTransport();
    (transport.limits.featureReports as Map<number, number>).delete(ReportId.BacklightBrightness);
    const tablet = await StuDevice.open(transport);
    await expect(tablet.settings.setBacklight({ level: 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
    });
    expect(() =>
      tablet.settings.setHandwritingArea({ x: 0, y: 0, width: 100, height: 10 }),
    ).toThrow();
    expect(transport.calls.filter((call) => call.kind === 'write')).toHaveLength(0);
    await tablet.close();
  });
  it('does not silently downgrade required encryption', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    const recording = tablet.capture.create({ encryption: 'required' });
    await expect(recording.start()).rejects.toMatchObject({ code: 'ENCRYPTION' });
    expect(transport.calls.filter((call) => call.kind === 'write')).toHaveLength(0);
    await tablet.close();
  });
  it('isolates application listener errors after recording canonical samples', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    const errors: Error[] = [];
    tablet.on(() => {
      throw new Error('Application callback');
    });
    tablet.onError((error) => errors.push(error));
    const recording = tablet.capture.create({ encryption: 'none' });
    await recording.start();
    transport.emit(1, penFixture().payload);
    expect((await recording.finish()).samples).toHaveLength(1);
    expect(errors).toHaveLength(1);
    await tablet.close();
  });
  it('fails capture on overflow, malformed input, and disconnect', async () => {
    for (const failure of ['overflow', 'malformed', 'unplug']) {
      const transport = new MockTransport();
      const tablet = await StuDevice.open(transport);
      const recording = tablet.capture.create({ encryption: 'none', maxSamples: 1 });
      await recording.start();
      transport.emit(1, penFixture().payload);
      if (failure === 'overflow') transport.emit(1, penFixture().payload);
      if (failure === 'malformed') transport.emit(1, new Uint8Array(1));
      if (failure === 'unplug') transport.disconnect();
      await expect(recording.finish()).rejects.toBeInstanceOf(StuError);
      await tablet.close();
    }
  });
  it('cleans up failed initialization', async () => {
    const transport = new MockTransport();
    transport.reports.set(ReportId.Information, new Uint8Array(2));
    await expect(StuDevice.open(transport)).rejects.toMatchObject({ code: 'MALFORMED_REPORT' });
    expect(transport.calls.at(-1)?.kind).toBe('close');
  });
  it('keeps ROM selectors and reads in the same transaction', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    await Promise.all([
      tablet.rom.getHash({ kind: 'signature', number: 1 }),
      tablet.rom.getHash({ kind: 'signature', number: 2 }),
    ]);
    const calls = transport.calls.filter((call) => call.id === 0x96);
    expect(calls.map((call) => call.kind)).toEqual(['write', 'read', 'write', 'read']);
    await tablet.close();
  });
  it('waits for ROM access to finish before reading a selected hash', async () => {
    let busyPolls = 0;
    const transport = new MockTransport({
      async beforeWrite(id) {
        if (id === ReportId.RomImageHash) busyPolls = 2;
      },
      async beforeRead(id) {
        if (id === ReportId.Status) {
          transport.reports.set(id, Uint8Array.of(busyPolls ? 5 : 0, 0, 0, 0));
          if (busyPolls) busyPolls--;
        }
        if (id === ReportId.RomImageHash && transport.reports.get(ReportId.Status)![0] !== 0)
          throw new Error('ROM hash read while tablet is busy');
      },
    });
    const tablet = await StuDevice.open(transport);
    const start = transport.calls.length;
    expect(await tablet.rom.getHash({ kind: 'signature', number: 1 })).toMatchObject({
      mode: 4,
      number: 1,
      result: 0,
    });
    expect(transport.calls.slice(start).map(({ kind, id }) => [kind, id])).toEqual([
      ['read', 0x03],
      ['write', 0x96],
      ['read', 0x03],
      ['read', 0x03],
      ['read', 0x03],
      ['read', 0x96],
      ['read', 0x03],
    ]);
    await tablet.close();
  });
  it('does not read a stale ROM hash when selecting the slot was rejected', async () => {
    const transport = new MockTransport({
      async beforeWrite(id) {
        if (id === ReportId.RomImageHash)
          transport.reports.set(ReportId.Status, Uint8Array.of(0, 0x15, 0, 0));
      },
    });
    const tablet = await StuDevice.open(transport);
    await expect(tablet.rom.getHash({ kind: 'signature', number: 1 })).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
      status: 0x15,
    });
    expect(transport.calls.some(({ kind, id }) => kind === 'read' && id === 0x96)).toBe(false);
    await tablet.close();
  });
  it('handles model-specific persistence and does not query unrelated optional settings on open', async () => {
    const transport = new MockTransport({
      model: 'STU-520',
      beforeRead: async (id) => {
        if (id === 0x32) throw new Error('Optional report unavailable');
      },
    });
    const tablet = await StuDevice.open(transport);
    expect(() => tablet.settings.setBacklight({ level: 2 })).toThrow(/persist/);
    expect(() => tablet.settings.setBacklight({ level: 'off', persist: true })).toThrow(/off/);
    await tablet.settings.setBacklight({ level: 3, persist: true });
    expect(transport.calls.filter((call) => call.kind === 'write').at(-1)?.payload).toEqual(
      Uint8Array.of(3, 0),
    );
    await tablet.close();
  });
  it('honors device status failure after a settings write', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    transport.reports.set(ReportId.Status, Uint8Array.of(0, 0x15, 0, 0));
    await expect(tablet.settings.setInkThreshold({ on: 100, off: 50 })).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
      status: 0x15,
    });
    await tablet.close();
  });
  it('uploads ROM images and uses explicit deletion selectors', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    const descriptor = {
      kind: 'signature' as const,
      number: 1,
      enabledKeys: [true, true, true] as const,
    };
    expect(await tablet.rom.uploadIfChanged(descriptor, image(), new Uint8Array(16))).toBe(false);
    await tablet.rom.upload(descriptor, image());
    await tablet.rom.display(descriptor);
    await tablet.rom.delete(descriptor);
    await tablet.rom.deleteAll('signature');
    const writes = transport.calls.filter((call) => call.kind === 'write');
    expect(writes.find((call) => call.id === 0x94)?.payload).toEqual(
      Uint8Array.of(4, 4, 1, 7, 0, 0),
    );
    expect(writes.filter((call) => call.id === 0x97).map((call) => call.payload)).toEqual([
      Uint8Array.of(9, 1),
      Uint8Array.of(4, 0),
    ]);
    await tablet.close();
  });
  it('returns reset success but invalidates subsequent work', async () => {
    const tablet = await StuDevice.open(new MockTransport());
    await tablet.reset('software');
    expect(tablet.state).toBe('faulted');
    await expect(tablet.getStatus()).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await tablet.close();
  });
  it('does not overwrite a ROM slot when its hash query fails', async () => {
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (id === ReportId.RomImageHash) transport.reports.get(id)![2] = 0x15;
      },
    });
    const tablet = await StuDevice.open(transport);
    await expect(
      tablet.rom.uploadIfChanged({ kind: 'slideshow', number: 1 }, image(), new Uint8Array(16)),
    ).rejects.toMatchObject({ code: 'DEVICE_STATUS', status: 0x15 });
    expect(transport.calls.filter((call) => call.id === ReportId.RomStartImageData)).toHaveLength(
      0,
    );
    await tablet.close();
  });
  it('provides bounded streams and never drops samples from the independent recorder', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    const recording = tablet.capture.create({ encryption: 'none' });
    await recording.start();
    const stream = tablet.stream({ maxBuffered: 1 });
    transport.emit(1, penFixture().payload);
    transport.emit(1, penFixture().payload);
    await expect(stream.next()).rejects.toMatchObject({ code: 'CAPTURE_OVERFLOW' });
    expect((await recording.finish()).samples).toHaveLength(2);
    await stream.return?.();
    await tablet.close();
  });
  it('ends filtered streams when a connection closes', async () => {
    const tablet = await StuDevice.open(new MockTransport());
    const stream = tablet.stream({ types: ['pen'] });
    const next = stream.next();
    await tablet.close();
    expect(await next).toEqual({ value: undefined, done: true });
  });
  it('allows disconnect listeners to close reentrantly and only closes once', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    let reentrant: Promise<void> | undefined;
    const listener = vi.fn(() => {
      reentrant = tablet.close();
    });
    tablet.on((event) => {
      if (event.type === 'disconnect') listener();
    });
    const closing = tablet.close();
    await closing;
    expect(reentrant).toBe(closing);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(transport.calls.filter((call) => call.kind === 'close')).toHaveLength(1);
  });
  it('terminates streams on reset and emits only one disconnect after unplug and close', async () => {
    const transport = new MockTransport();
    const tablet = await StuDevice.open(transport);
    const stream = tablet.stream({ types: ['pen'] });
    const next = stream.next();
    await tablet.reset('software');
    expect(await next).toEqual({ value: undefined, done: true });
    await tablet.close();
    const second = await StuDevice.open(new MockTransport());
    const listener = vi.fn();
    second.on((event) => {
      if (event.type === 'disconnect') listener();
    });
    (second.transport as MockTransport).disconnect();
    await second.close();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('ends a protected capture before closing the transport and disposes its key once', async () => {
    const transport = new MockTransport(),
      dispose = vi.fn();
    const tablet = await StuDevice.open(transport, {
      cryptoProvider: {
        async negotiate() {
          return {
            protection: { kind: 'rsa-aes', sessionId: 1, keyBits: 256 },
            decrypt: (data) => data.slice(),
            dispose,
          };
        },
      },
    });
    const recording = tablet.capture.create({ encryption: 'required' });
    await recording.start();
    await tablet.close();
    const calls = transport.calls.filter((call) => call.kind === 'write' || call.kind === 'close');
    expect(calls.map((call) => call.id ?? call.kind)).toEqual([
      ReportId.StartCapture,
      ReportId.EndCapture,
      'close',
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(recording.state).toBe('failed');
    await recording.dispose();
    expect(recording.sampleCount).toBe(0);
  });
  it('still closes the transport if an injected crypto provider throws during disposal', async () => {
    const transport = new MockTransport(),
      errors = vi.fn();
    const tablet = await StuDevice.open(transport, {
      cryptoProvider: {
        async negotiate() {
          return {
            protection: { kind: 'rsa-aes', sessionId: 1, keyBits: 256 },
            decrypt: (data) => data.slice(),
            dispose() {
              throw new Error('Provider cleanup failed');
            },
          };
        },
      },
    });
    tablet.onError(errors);
    const recording = tablet.capture.create({ encryption: 'required' });
    await recording.start();
    await tablet.close();
    expect(tablet.state).toBe('closed');
    expect(transport.calls.at(-1)?.kind).toBe('close');
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('scheduler', () => {
  it('keeps a timed-out platform call quarantined until it settles', async () => {
    const queue = new Scheduler();
    let settle!: () => void;
    const calls: string[] = [];
    const deferred = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const first = queue.run('slow', (tx) => tx.io(() => deferred), { timeoutMs: 10 });
    const second = queue.run(
      'next',
      async () => {
        calls.push('next');
      },
      { timeoutMs: 1000 },
    );
    await expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toEqual([]);
    settle();
    await second;
    expect(calls).toEqual(['next']);
  });
  it('aborts queued work without starting it', async () => {
    const queue = new Scheduler(),
      abort = new AbortController(),
      callback = vi.fn();
    abort.abort();
    await expect(
      queue.run(
        'cancelled',
        async () => {
          callback();
        },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await queue.idle();
    expect(callback).not.toHaveBeenCalled();
  });
});
