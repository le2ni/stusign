import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StuDevice, StuError } from '../src/index.js';
import { ReportId } from '../src/protocol/index.js';
import { MockTransport } from '../src/testing/index.js';

const image = () => ({ width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(255) });

describe('startup after a power cycle', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('checks an already ready tablet immediately and restores appearance without a timer delay', async () => {
    const transport = new MockTransport();
    const started = performance.now();
    // Do not advance timers: a warm reopen must complete without a stability delay.
    const device = await StuDevice.open(transport, {
      readyStabilityMs: 0,
      startupBackground: 0x28664c,
      startupImage: { source: 'upload', image: image() },
    });
    expect(performance.now()).toBe(started);
    const firstWrite = transport.calls.findIndex(({ kind }) => kind === 'write');
    expect(
      transport.calls
        .slice(0, firstWrite)
        .filter(({ kind }) => kind === 'read')
        .slice(0, 4)
        .map(({ id }) => id),
    ).toEqual([ReportId.Status, ReportId.Information, ReportId.Capability, ReportId.Status]);
    expect(transport.calls[firstWrite]?.id).toBe(ReportId.BackgroundColor24);
    expect(transport.calls.filter(({ kind }) => kind === 'write').at(-1)?.id).toBe(
      ReportId.EndImageData,
    );
    expect(await device.settings.getBackground()).toEqual({ color: 0x28664c, format: 'rgb24' });
    await device.close();
  });

  it('still waits through transient reads and busy firmware when the stability delay is zero', async () => {
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (id !== ReportId.Status) return;
        if (performance.now() < 200) throw new StuError('TRANSPORT', 'Firmware is starting');
        transport.reports.set(id, Uint8Array.of(performance.now() < 600 ? 4 : 0, 0, 0, 0));
      },
    });
    const opening = StuDevice.open(transport, {
      readyStabilityMs: 0,
      startupBackground: 0x28664c,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.calls.some(({ kind }) => kind === 'write')).toBe(false);
    expect(transport.calls.some(({ id }) => id === ReportId.Information)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const device = await opening;
    expect(await device.settings.getBackground()).toEqual({ color: 0x28664c, format: 'rgb24' });
    await device.close();
  });

  it('retries a transient transport-open error within the same startup deadline', async () => {
    let attempts = 0;
    class StartingTransport extends MockTransport {
      override async open(): Promise<void> {
        if (++attempts < 3) throw new StuError('TRANSPORT', 'USB interface is starting');
        await super.open();
      }
    }
    const opening = StuDevice.open(new StartingTransport());
    await vi.advanceTimersByTimeAsync(800);
    await (await opening).close();
    expect(attempts).toBe(3);
  });

  it('does not retry denied permission to open the transport', async () => {
    let attempts = 0;
    class DeniedTransport extends MockTransport {
      override async open(): Promise<void> {
        attempts++;
        throw new StuError('PERMISSION_DENIED', 'Access denied');
      }
    }
    await expect(StuDevice.open(new DeniedTransport())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(attempts).toBe(1);
  });

  it('waits through failed reads, reset, a premature Ready, boot and ROM busy before applying appearance', async () => {
    let booting = true;
    const writes: number[] = [];
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (!booting) return;
        const elapsed = performance.now();
        if (elapsed < 200) throw new StuError('TRANSPORT', 'Firmware is starting');
        const state =
          elapsed < 300 ? 0xff : elapsed < 400 ? 0 : elapsed < 1600 ? 4 : elapsed < 2000 ? 5 : 0;
        if (id === ReportId.Status) transport.reports.set(id, Uint8Array.of(state, 0, 0, 0));
        if (elapsed >= 2000) booting = false;
      },
      beforeWrite: async () => {
        writes.push(performance.now());
      },
    });
    const opening = StuDevice.open(transport, {
      startupBackground: 0x123456,
      startupImage: { source: 'upload', image: image() },
    });
    await vi.advanceTimersByTimeAsync(2400);
    expect(writes).toEqual([]);
    expect(transport.calls.some(({ id }) => id === ReportId.Information)).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const device = await opening;
    expect(writes.every((time) => time >= 2500)).toBe(true);
    const ids = transport.calls.filter(({ kind }) => kind === 'write').map(({ id }) => id);
    expect(ids[0]).toBe(ReportId.BackgroundColor24);
    expect(ids[1]).toBe(ReportId.StartImageData);
    expect(ids.at(-1)).toBe(ReportId.EndImageData);
    expect(ids).not.toContain(ReportId.ClearScreen);
    await device.close();
  });

  it('restores a stored image and background after reset without sending pixels or clearing the image', async () => {
    let booting = false;
    const transport = new MockTransport({
      simulateRom: true,
      beforeRead: async (id) => {
        if (booting && id === ReportId.Status) {
          const state = performance.now() < 1500 ? 4 : 0;
          transport.reports.set(id, Uint8Array.of(state, 0, 0, 0));
          if (!state) booting = false;
        }
      },
    });
    const first = await StuDevice.open(transport, { readyStabilityMs: 0 });
    const saved = await first.rom.storeImage({ kind: 'slideshow', number: 10 }, image());
    await first.close();
    booting = true;
    transport.reports.set(ReportId.BackgroundColor24, Uint8Array.of(255, 255, 255));
    transport.calls.length = 0;
    const opening = StuDevice.open(transport, {
      startupBackground: 0,
      startupImage: { source: 'stored', slot: saved.slot, expectedHash: saved.hash },
    });
    await vi.advanceTimersByTimeAsync(1900);
    expect(transport.calls.filter(({ kind }) => kind === 'write')).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    const device = await opening;
    expect(transport.calls.filter(({ kind }) => kind === 'write').map(({ id }) => id)).toEqual([
      ReportId.BackgroundColor24,
      ReportId.RomImageHash,
      ReportId.RomImageDisplay,
    ]);
    expect(await device.settings.getBackground()).toEqual({ color: 0, format: 'rgb24' });
    await device.close();
  });

  it('reapplies a background-only startup after each volatile reset and clears after readback', async () => {
    const transport = new MockTransport();
    for (let cycle = 0; cycle < 2; cycle++) {
      transport.reports.set(ReportId.BackgroundColor24, Uint8Array.of(255, 255, 255));
      transport.calls.length = 0;
      const device = await StuDevice.open(transport, {
        readyStabilityMs: 0,
        startupBackground: 0x28664c,
      });
      expect(transport.calls.filter(({ kind }) => kind === 'write').map(({ id }) => id)).toEqual([
        ReportId.BackgroundColor24,
        ReportId.ClearScreen,
      ]);
      expect(
        transport.calls.findIndex(
          ({ kind, id }) => kind === 'read' && id === ReportId.BackgroundColor24,
        ),
      ).toBeLessThan(transport.calls.findIndex(({ id }) => id === ReportId.ClearScreen));
      expect(await device.settings.getBackground()).toEqual({ color: 0x28664c, format: 'rgb24' });
      await device.close();
    }
  });

  it('bounds readiness waiting and releases the transport on timeout', async () => {
    const transport = new MockTransport();
    transport.reports.set(ReportId.Status, Uint8Array.of(4, 0, 0, 0));
    const failed = expect(
      StuDevice.open(transport, {
        timeoutMs: 2000,
        startupImage: { source: 'upload', image: image() },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(2100);
    await failed;
    expect(transport.calls.some(({ kind }) => kind === 'write')).toBe(false);
    expect(transport.calls.at(-1)?.kind).toBe('close');
    transport.reports.set(ReportId.Status, new Uint8Array(4));
    await (await StuDevice.open(transport, { readyStabilityMs: 0 })).close();
  });

  it.each(['abort', 'disconnect'] as const)(
    'stops boot waiting on %s without a late display write',
    async (reason) => {
      const transport = new MockTransport();
      const controller = new AbortController();
      const failed = expect(
        StuDevice.open(transport, {
          signal: controller.signal,
          startupBackground: 0x123456,
        }),
      ).rejects.toMatchObject({ code: reason === 'abort' ? 'ABORTED' : 'DISCONNECTED' });
      await vi.advanceTimersByTimeAsync(200);
      if (reason === 'abort') controller.abort();
      else transport.disconnect();
      await vi.advanceTimersByTimeAsync(200);
      await failed;
      expect(transport.calls.some(({ kind }) => kind === 'write')).toBe(false);
      expect(transport.calls.at(-1)?.kind).toBe('close');
    },
  );

  it.each(['PERMISSION_DENIED', 'MALFORMED_REPORT', 'UNSUPPORTED_FEATURE'] as const)(
    'does not retry %s errors',
    async (code) => {
      const transport = new MockTransport({
        beforeRead: async () => {
          throw new StuError(code, 'Permanent failure');
        },
      });
      await expect(StuDevice.open(transport)).rejects.toMatchObject({ code });
      expect(transport.calls.filter(({ kind }) => kind === 'read')).toHaveLength(1);
      expect(transport.calls.at(-1)?.kind).toBe('close');
    },
  );

  it('requires readiness again after a transient metadata read failure', async () => {
    let first = true;
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (id === ReportId.Information && first) {
          first = false;
          throw new StuError('TRANSPORT', 'Firmware is not ready');
        }
      },
    });
    const opening = StuDevice.open(transport, { startupBackground: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.calls.some(({ kind }) => kind === 'write')).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await (await opening).close();
    expect(transport.calls.filter(({ id }) => id === ReportId.Information)).toHaveLength(2);
  });

  it('does not display the image if background readback fails', async () => {
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (id === ReportId.BackgroundColor24) transport.reports.set(id, new Uint8Array(3));
      },
    });
    await expect(
      StuDevice.open(transport, {
        readyStabilityMs: 0,
        startupBackground: 0xffffff,
        startupImage: { source: 'upload', image: image() },
      }),
    ).rejects.toMatchObject({ code: 'DEVICE_STATUS' });
    expect(transport.calls.filter(({ kind }) => kind === 'write').map(({ id }) => id)).toEqual([
      ReportId.BackgroundColor24,
    ]);
    expect(transport.calls.at(-1)?.kind).toBe('close');
  });

  it('does not retry a failed display-setting write', async () => {
    const transport = new MockTransport({
      beforeWrite: async () => {
        throw new StuError('TRANSPORT', 'Write failed');
      },
    });
    await expect(
      StuDevice.open(transport, { readyStabilityMs: 0, startupBackground: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSPORT' });
    expect(transport.calls.filter(({ kind }) => kind === 'write')).toHaveLength(1);
  });

  it('validates startup options before opening a transport', async () => {
    const transport = new MockTransport();
    await expect(StuDevice.open(transport, { startupBackground: -1 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(StuDevice.open(transport, { readyStabilityMs: NaN })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(transport.calls).toEqual([]);
  });
});
