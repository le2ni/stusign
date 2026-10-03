import { describe, expect, it, vi } from 'vitest';
import { StuDevice } from '../src/index.js';
import { MockTransport } from '../src/testing/index.js';
import {
  createWebHidManager,
  normalizeFeatureReport,
  getHidReportLengths,
  WebHidTransport,
} from '../src/transports/webhid.js';
import type {
  HidApi,
  HidDevice,
  HidInputEvent,
  HidConnectionEvent,
} from '../src/transports/webhid.js';

function fakeDevice(): HidDevice & {
  writes: Uint8Array[];
  inputs: Set<(event: HidInputEvent) => void>;
} {
  const inputs = new Set<(event: HidInputEvent) => void>(),
    writes: Uint8Array[] = [];
  return {
    vendorId: 0x056a,
    productId: 0x00a8,
    productName: 'STU-540',
    opened: false,
    collections: [
      {
        children: [
          {
            featureReports: [3, 8, 9].map((reportId) => ({
              reportId,
              items: [{ reportCount: reportId === 3 ? 4 : 16, reportSize: 8 }],
            })),
          },
        ],
      },
    ],
    inputs,
    writes,
    async open() {
      Object.assign(this, { opened: true });
    },
    async close() {
      Object.assign(this, { opened: false });
    },
    async receiveFeatureReport(id) {
      const data = new Uint8Array(id === 3 ? 5 : 17);
      data[0] = id;
      return new DataView(data.buffer);
    },
    async sendFeatureReport(_id, data) {
      writes.push(data.slice());
    },
    addEventListener(_name, listener) {
      inputs.add(listener);
    },
    removeEventListener(_name, listener) {
      inputs.delete(listener);
    },
  };
}

describe('WebHID boundary', () => {
  it('opens through Chrome NotAllowedError status-read failures during boot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const hid = fakeDevice();
      const reports = new MockTransport().reports;
      let statusReads = 0;
      hid.receiveFeatureReport = async (id) => {
        if (id === 3 && ++statusReads <= 2)
          throw new DOMException('Failed to receive the feature report.', 'NotAllowedError');
        const payload = reports.get(id)!;
        const data = new Uint8Array(payload.length + 1);
        data[0] = id;
        data.set(payload, 1);
        if (id === 3 && performance.now() < 500) data[1] = 4;
        return new DataView(data.buffer);
      };
      const opening = StuDevice.open(new WebHidTransport(hid)).then(
        (device) => ({ device, error: undefined }),
        (error: unknown) => ({ device: undefined, error }),
      );
      await vi.advanceTimersByTimeAsync(1200);
      const result = await opening;
      expect(result.error).toBeUndefined();
      expect(result.device?.state).toBe('open');
      expect(statusReads).toBeGreaterThan(3);
      expect(hid.writes).toEqual([]);
      await result.device?.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it('distinguishes boot-time open failures from denied permission and releases ownership', async () => {
    const device = fakeDevice();
    const open = device.open.bind(device);
    device.open = async () => {
      throw new DOMException('USB is starting', 'NetworkError');
    };
    await expect(new WebHidTransport(device).open()).rejects.toMatchObject({ code: 'TRANSPORT' });
    device.open = async () => {
      throw new DOMException('Failed to open the device.', 'NotAllowedError');
    };
    await expect(new WebHidTransport(device).open()).rejects.toMatchObject({ code: 'TRANSPORT' });
    device.open = async () => {
      throw new DOMException('Permission denied', 'SecurityError');
    };
    await expect(new WebHidTransport(device).open()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    device.open = open;
    const transport = new WebHidTransport(device);
    await transport.open();
    device.receiveFeatureReport = async () => {
      throw new DOMException('Permission revoked', 'SecurityError');
    };
    await expect(transport.readReport(3)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await transport.close();
  });
  it('normalizes explicit or descriptor-unambiguous framing, never guesses from byte value alone', () => {
    const prefixed = Uint8Array.of(3, 3, 0, 0, 0),
      payload = prefixed.subarray(1);
    expect(normalizeFeatureReport(3, new DataView(prefixed.buffer), 4)).toEqual(payload);
    expect(
      normalizeFeatureReport(
        3,
        new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
        4,
      ),
    ).toEqual(payload);
    expect(() => normalizeFeatureReport(4, new DataView(prefixed.buffer), 4)).toThrow();
    expect(() =>
      normalizeFeatureReport(3, new DataView(payload.buffer, payload.byteOffset, 4), 4, 'included'),
    ).toThrow();
  });
  it('uses nested descriptor bit counts', () => {
    expect(
      getHidReportLengths([
        {
          children: [
            {
              featureReports: [
                {
                  reportId: 1,
                  items: [
                    { reportSize: 1, reportCount: 3 },
                    { reportSize: 5, reportCount: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ]).featureReports.get(1),
    ).toBe(1);
  });
  it('pads writes to descriptors and owns listeners through repeated open/close', async () => {
    const hid = fakeDevice(),
      transport = new WebHidTransport(hid);
    await transport.open();
    expect(hid.inputs.size).toBe(1);
    await transport.writeReport(3, Uint8Array.of(1, 2));
    expect(hid.writes[0]).toEqual(Uint8Array.of(1, 2, 0, 0));
    await expect(transport.writeReport(3, new Uint8Array(5))).rejects.toThrow();
    await transport.close();
    expect(hid.inputs.size).toBe(0);
    await transport.open();
    expect(hid.inputs.size).toBe(1);
    await transport.close();
  });
  it('calls the picker synchronously from the initiating user gesture', async () => {
    const device = fakeDevice();
    let called = false;
    const api: HidApi = {
      async getDevices() {
        return [device];
      },
      async requestDevice() {
        called = true;
        return [device];
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const manager = createWebHidManager({ hid: api });
    const selection = manager.requestDevice();
    expect(called).toBe(true);
    expect(await selection).toBeInstanceOf(WebHidTransport);
    expect(await manager.getAuthorizedDevices()).toHaveLength(1);
  });
  it('handles chooser cancellation distinctly from permission failure', async () => {
    const api: HidApi = {
      async getDevices() {
        return [];
      },
      async requestDevice() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
    };
    expect(await createWebHidManager({ hid: api }).requestDevice()).toBeNull();
    api.requestDevice = async () => {
      throw new Error('Denied');
    };
    await expect(createWebHidManager({ hid: api }).requestDevice()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
  it('closes a platform open that completes after cancellation', async () => {
    const device = fakeDevice();
    let settle!: () => void;
    device.open = async () => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      Object.assign(device, { opened: true });
    };
    const transport = new WebHidTransport(device),
      opening = transport.open();
    await transport.close();
    settle();
    await expect(opening).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(device.opened).toBe(false);
    expect(device.inputs.size).toBe(0);
  });
  it('ignores unrelated unplug events and detaches on its own disconnect', async () => {
    const device = fakeDevice();
    let unplug: ((event: HidConnectionEvent) => void) | undefined;
    const api: HidApi = {
      async getDevices() {
        return [device];
      },
      async requestDevice() {
        return [device];
      },
      addEventListener(type, listener) {
        if (type === 'disconnect') unplug = listener;
      },
      removeEventListener() {},
    };
    const transport = new WebHidTransport(device, { hid: api });
    let disconnected = 0;
    transport.onDisconnect(() => {
      disconnected++;
    });
    await transport.open();
    unplug?.({ device: fakeDevice() });
    expect(disconnected).toBe(0);
    unplug?.({ device });
    expect(disconnected).toBe(1);
    expect(device.inputs.size).toBe(0);
    await transport.close();
  });
  it.each(['NetworkError', 'NotAllowedError'])(
    'identifies failed feature I/O as transport errors for %s',
    async (name) => {
      const device = fakeDevice();
      const cause = new DOMException('Failed to receive the feature report.', name);
      device.receiveFeatureReport = async () => {
        throw cause;
      };
      device.sendFeatureReport = async () => {
        throw cause;
      };
      const transport = new WebHidTransport(device);
      await transport.open();
      await expect(transport.readReport(3)).rejects.toMatchObject({
        code: 'TRANSPORT',
        reportId: 3,
        operation: 'read feature report',
        cause,
      });
      await expect(transport.writeReport(3, new Uint8Array(4))).rejects.toMatchObject({
        code: 'TRANSPORT',
        reportId: 3,
        operation: 'write feature report',
        cause,
      });
      await transport.close();
    },
  );
  it('never closes an HID interface owned by another transport', async () => {
    const device = fakeDevice(),
      first = new WebHidTransport(device),
      second = new WebHidTransport(device);
    await first.open();
    await expect(second.open()).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await second.close();
    expect(device.opened).toBe(true);
    expect(device.inputs.size).toBe(1);
    await first.close();
    await second.open();
    await second.close();
  });
  it('rejects a read completing in a later connection generation', async () => {
    const device = fakeDevice();
    let settle!: (data: DataView) => void;
    device.receiveFeatureReport = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    const transport = new WebHidTransport(device);
    await transport.open();
    const reading = transport.readReport(3);
    await transport.close();
    await transport.open();
    settle(new DataView(Uint8Array.of(3, 0, 0, 0, 0).buffer));
    await expect(reading).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await transport.close();
  });
});
