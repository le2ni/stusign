import { afterEach, describe, expect, it, vi } from 'vitest';
import { StuDevice } from '../src/index.js';
import { penFixture } from '../src/testing/index.js';
import { ReportId, encodeImage, encodeSerialFrame } from '../src/protocol/index.js';
import { createWebSerialManager, WebSerialTransport } from '../src/transports/webserial.js';
import type { InputReport } from '../src/types.js';
import { FakeSerialPort, FakeSerialApi, deferred, flush } from './fixtures/serial.js';

const transports: WebSerialTransport[] = [];
const releases: (() => void)[] = [];
function setup(timeout = 5000) {
  const port = new FakeSerialPort(),
    serial = new FakeSerialApi([port]);
  const transport = new WebSerialTransport(port, { serial, responseTimeoutMs: timeout });
  transports.push(transport);
  return { port, serial, transport };
}
function gate() {
  const value = deferred();
  releases.push(value.resolve);
  return value;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const transport of transports.splice(0)) await transport.close();
  vi.useRealTimers();
});

describe('Web Serial boundary', () => {
  it('opens 128000 8N1, checks identity and discovers capabilities without settings writes', async () => {
    const { port, serial, transport } = setup();
    expect(transport.limits.featureReports.size).toBe(0);
    await transport.open();
    expect(port.openOptions).toEqual([
      {
        baudRate: 128000,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 16384,
      },
    ]);
    expect(port.signals).toEqual([{ dataTerminalReady: false, requestToSend: true }]);
    expect(port.requests).toEqual([Uint8Array.of(0x80, 8), Uint8Array.of(0x80, 0xff)]);
    expect(transport.identity?.modelName).toBe('STU-540');
    expect(transport.reportSizes.get(0x26)).toBe(256);
    expect(transport.limits.featureReports.get(0x26)).toBe(255);
    expect(transport.limits.inputReports.get(1)).toBe(6);
    expect(transport.limits.featureReports.has(0x80)).toBe(false);
    expect(serial.listeners.disconnect.size).toBe(1);
    await transport.close();
    expect(serial.listeners.disconnect.size).toBe(0);
    expect(port.closed).toBe(1);
    await transport.open();
    expect(port.openOptions).toHaveLength(2);
  });
  it('supports the physical RS-232 baud rate and validates connection options', async () => {
    const port = new FakeSerialPort();
    const transport = new WebSerialTransport(port, { baudRate: 115200 });
    transports.push(transport);
    await transport.open();
    expect(port.openOptions[0]?.baudRate).toBe(115200);
    expect(() => new WebSerialTransport(port, { baudRate: 0 })).toThrow();
    expect(() => new WebSerialTransport(port, { responseTimeoutMs: NaN })).toThrow();
  });
  it('rejects unrelated devices and invalid size tables before any settings commands', async () => {
    for (const issue of ['identity', 'sizes']) {
      const { port, transport } = setup();
      if (issue === 'identity') port.mock.reports.get(8)!.fill(0);
      else port.sizes.fill(0, 6, 8);
      await expect(transport.open()).rejects.toMatchObject({
        code: issue === 'identity' ? 'UNSUPPORTED_FEATURE' : 'MALFORMED_REPORT',
      });
      expect(port.requests.every((r) => r[0] === 0x80)).toBe(true);
      expect(port.closed).toBe(1);
    }
  });
  it('interleaves fragmented pen input with a pending read and strips report IDs', async () => {
    const { port, transport } = setup();
    await transport.open();
    const received: InputReport[] = [];
    transport.onInput((report) => received.push(report));
    const pen = penFixture();
    port.onRequest = () => {
      port.send(Uint8Array.of(pen.reportId, ...pen.payload), 3);
      port.send(Uint8Array.of(3, 0, 0, 0, 0), 2);
      return true;
    };
    expect(await transport.readReport(3)).toEqual(new Uint8Array(4));
    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toEqual(pen.payload);
  });
  it('serializes concurrent writes, snapshots payloads and waits for the untagged ACK', async () => {
    const { port, transport } = setup();
    await transport.open();
    port.onRequest = () => true;
    const payload = Uint8Array.of(2);
    const first = transport.writeReport(0x0c, payload),
      second = transport.writeReport(0x21, Uint8Array.of(1));
    payload[0] = 1;
    await flush();
    expect(port.requests.slice(2)).toEqual([Uint8Array.of(0x0c, 2, 0)]);
    port.ack();
    await first;
    await flush();
    expect(port.requests[3]).toEqual(Uint8Array.of(0x21, 1));
    port.ack();
    await second;
    await expect(transport.writeReport(0x21, new Uint8Array(2))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(transport.writeReport(0x80, Uint8Array.of(3))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
    });
    port.onRequest = undefined;
    await expect(transport.readReport(0x21)).resolves.toHaveLength(1);
  });
  it('handles NACKs for reads and writes without confusing a following command', async () => {
    const { port, transport } = setup();
    await transport.open();
    port.onRequest = () => {
      port.ack(5);
      return true;
    };
    await expect(transport.readReport(3)).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
      reportId: 3,
      status: 5,
    });
    await expect(transport.writeReport(0x21, Uint8Array.of(1))).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
      reportId: 0x21,
      status: 5,
    });
    port.onRequest = undefined;
    expect(await transport.readReport(3)).toEqual(new Uint8Array(4));
  });
  it.each([0, 5])(
    'holds the lane when an early ACK (%s) precedes write completion',
    async (status) => {
      const { port, transport } = setup();
      await transport.open();
      const delay = gate();
      port.onRequest = async () => {
        port.ack(status);
        await delay.promise;
        return true;
      };
      const first = transport.writeReport(0x21, Uint8Array.of(1)).catch((error: unknown) => error);
      const next = transport.readReport(3);
      await flush();
      expect(port.requests).toHaveLength(3);
      port.onRequest = undefined;
      delay.resolve();
      const result = await first;
      if (status) expect(result).toMatchObject({ code: 'DEVICE_STATUS' });
      else expect(result).toBeUndefined();
      expect(await next).toHaveLength(4);
    },
  );
  it('times out a hung write even after its reply and never sends queued commands', async () => {
    const { port, transport } = setup(50);
    await transport.open();
    vi.useFakeTimers();
    const delay = gate();
    port.onRequest = async () => {
      port.ack();
      await delay.promise;
      return true;
    };
    const errors: unknown[] = [];
    transport.onDisconnect((error) => errors.push(error));
    const first = transport.writeReport(0x21, Uint8Array.of(1)).catch((e: unknown) => e);
    const next = transport.readReport(3).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(51);
    expect(await first).toMatchObject({ code: 'TIMEOUT' });
    expect(await next).toMatchObject({ code: 'DISCONNECTED' });
    expect(errors).toHaveLength(1);
    expect(port.requests).toHaveLength(3);
    delay.resolve();
    await transport.close();
    expect(port.closed).toBe(1);
  });
  it('faults a missing reply and discards queued work before reopening a fresh session', async () => {
    const { port, transport } = setup(50);
    await transport.open();
    vi.useFakeTimers();
    port.onRequest = () => true;
    const first = transport.readReport(3).catch((e: unknown) => e);
    const next = transport.writeReport(0x21, Uint8Array.of(1)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(51);
    expect(await first).toMatchObject({ code: 'TIMEOUT' });
    expect(await next).toMatchObject({ code: 'DISCONNECTED' });
    await transport.close();
    expect(port.requests).toHaveLength(3);
    port.onRequest = undefined;
    await transport.open();
    expect(await transport.readReport(3)).toHaveLength(4);
  });
  it.each(['crc', 'wrong-size', 'unexpected-ack', 'duplicate-ack', 'stream-error', 'stream-end'])(
    'faults %s rather than silently losing input or misattributing replies',
    async (issue) => {
      const { port, transport } = setup();
      await transport.open();
      const errors: unknown[] = [];
      transport.onDisconnect((error) => errors.push(error));
      port.onRequest = () => {
        if (issue === 'crc') {
          const frame = encodeSerialFrame(Uint8Array.of(3, 0, 0, 0, 0));
          frame[3] = frame[3]! ^ 1;
          port.input.enqueue(frame);
        } else if (issue === 'wrong-size') port.send(Uint8Array.of(3, 0));
        else if (issue === 'stream-error') port.input.error(new Error('USB gone'));
        else if (issue === 'stream-end') port.input.close();
        else {
          port.ack();
          if (issue === 'duplicate-ack') port.ack();
        }
        return true;
      };
      const operation =
        issue === 'duplicate-ack'
          ? transport.writeReport(0x21, Uint8Array.of(1))
          : transport.readReport(3);
      await expect(operation).rejects.toBeDefined();
      await expect(transport.readReport(3)).rejects.toMatchObject({ code: 'DISCONNECTED' });
      expect(errors).toHaveLength(1);
    },
  );
  it('routes disconnection only to the owning port and releases streams and ownership', async () => {
    const { port, serial, transport } = setup();
    await transport.open();
    const errors: unknown[] = [];
    transport.onDisconnect((error) => errors.push(error));
    serial.emit('disconnect', new FakeSerialPort());
    expect(errors).toHaveLength(0);
    await expect(new WebSerialTransport(port).open()).rejects.toMatchObject({
      code: 'DEVICE_BUSY',
    });
    serial.emit('disconnect', port);
    await transport.close();
    expect(errors).toHaveLength(1);
    expect(serial.listeners.disconnect.size).toBe(0);
    const other = new WebSerialTransport(port);
    transports.push(other);
    await other.open();
  });
  it('closes a late platform open without issuing any queries and permits subsequent ownership', async () => {
    const { port, transport } = setup();
    const delay = gate();
    port.openDelay = delay.promise;
    const opening = transport.open().catch((e: unknown) => e);
    await transport.close();
    await expect(new WebSerialTransport(port).open()).rejects.toMatchObject({
      code: 'DEVICE_BUSY',
    });
    delay.resolve();
    expect(await opening).toMatchObject({ code: 'DISCONNECTED' });
    expect(port.requests).toHaveLength(0);
    expect(port.closed).toBe(1);
    await transport.open();
  });
  it('rejects pending reads on close and revokes permission only after releasing locks', async () => {
    const { port, transport } = setup();
    await transport.open();
    port.onRequest = () => true;
    const pending = transport.readReport(3).catch((e: unknown) => e);
    await flush();
    await transport.forget();
    expect(await pending).toMatchObject({ code: 'DISCONNECTED' });
    expect(port.closed).toBe(1);
    expect(port.forgotten).toBe(1);
  });
});

describe('serial manager', () => {
  it('preserves picker activation, lists authorized ports without IO, and filters by adapter IDs', async () => {
    const port = new FakeSerialPort(),
      serial = new FakeSerialApi([port]);
    const request = vi.spyOn(serial, 'requestPort');
    const manager = createWebSerialManager({ serial });
    const selection = manager.requestDevice();
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(undefined);
    expect(await selection).toBeInstanceOf(WebSerialTransport);
    expect(await manager.getAuthorizedDevices()).toHaveLength(1);
    expect(port.openOptions).toHaveLength(0);
    expect(
      await createWebSerialManager({
        serial,
        filters: [{ usbVendorId: 0x056a }],
      }).getAuthorizedDevices(),
    ).toHaveLength(0);
    expect(
      await createWebSerialManager({
        serial,
        filters: [{ usbVendorId: 0x0403 }],
      }).getAuthorizedDevices(),
    ).toHaveLength(1);
  });
  it('distinguishes cancellation, permission errors and missing API support', async () => {
    const serial = new FakeSerialApi([]);
    vi.spyOn(serial, 'requestPort')
      .mockRejectedValueOnce(new DOMException('Cancelled', 'NotFoundError'))
      .mockRejectedValueOnce(new DOMException('Denied', 'SecurityError'));
    const manager = createWebSerialManager({ serial });
    expect(await manager.requestDevice()).toBeNull();
    await expect(manager.requestDevice()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(() => createWebSerialManager()).toThrow(/Web Serial/);
  });
  it('handles modern target and legacy port events and unsubscribes', () => {
    const port = new FakeSerialPort(),
      serial = new FakeSerialApi([port]);
    const events: boolean[] = [];
    const stop = createWebSerialManager({ serial }).onConnection(({ connected }) =>
      events.push(connected),
    );
    serial.emit('connect', port);
    for (const listener of serial.listeners.disconnect) listener({ target: serial, port });
    expect(events).toEqual([true, false]);
    stop();
    expect(serial.listeners.connect.size).toBe(0);
    expect(serial.listeners.disconnect.size).toBe(0);
  });
});

describe('StuDevice over serial', () => {
  it('uses existing display, settings, capture and stored-image services through serial framing', async () => {
    const { port, transport } = setup();
    const tablet = await StuDevice.open(transport, { readyStabilityMs: 0 });
    await tablet.settings.setDefaultMode('serial');
    expect(await tablet.settings.getDefaultMode()).toBe(2);
    const image = { width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(255) };
    await tablet.display.writeEncodedImage(encodeImage(image, { format: 'bgr24' }));
    const recording = tablet.capture.create({ encryption: 'none' });
    await recording.start();
    const pen = penFixture();
    port.send(Uint8Array.of(pen.reportId, ...pen.payload));
    await flush();
    expect(recording.sampleCount).toBe(1);
    expect((await recording.finish()).hasInk).toBe(true);
    const stored = await tablet.rom.storeImage({ kind: 'message', number: 1 }, image);
    await tablet.close();
    const start = port.requests.length;
    const reopened = await StuDevice.open(transport, {
      readyStabilityMs: 0,
      startupImage: { source: 'stored', slot: stored.slot, expectedHash: stored.hash },
    });
    expect(
      port.requests.slice(start).some((report) => report[0] === ReportId.RomImageDisplay),
    ).toBe(true);
    expect(port.requests.slice(start).some((report) => report[0] === ReportId.ImageDataBlock)).toBe(
      false,
    );
    await reopened.close();
  });
  it('keeps an aborted operation in the lane until its outstanding ACK arrives', async () => {
    const { port, transport } = setup();
    const tablet = await StuDevice.open(transport, { readyStabilityMs: 0 });
    port.onRequest = (report) => report[0] !== 0x80;
    const abort = new AbortController();
    const first = tablet.settings
      .setInking(true, { signal: abort.signal })
      .catch((e: unknown) => e);
    await flush();
    expect(port.requests.at(-1)?.[0]).toBe(0x21);
    abort.abort();
    expect(await first).toMatchObject({ code: 'ABORTED' });
    const count = port.requests.length;
    const next = tablet.settings.setInking(false);
    await flush();
    expect(port.requests).toHaveLength(count);
    port.onRequest = undefined;
    port.ack();
    await next;
    expect(port.requests.slice(count).filter((report) => report[0] === 0x21)).toEqual([
      Uint8Array.of(0x21, 0),
    ]);
    await tablet.close();
  });
});
