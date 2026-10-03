import { describe, expect, it, vi } from 'vitest';
import { AutoReconnect } from '../examples/hardware/reconnect.js';
import { MockTransport } from '../src/testing/index.js';

function fixture() {
  const device = new MockTransport();
  let busy = false,
    connected = false;
  const list = vi.fn(async () => [device]);
  const open = vi.fn(async () => {
    connected = true;
  });
  const notice = vi.fn(),
    error = vi.fn();
  const reconnect = new AutoReconnect({
    getAuthorizedDevices: list,
    isBusy: () => busy,
    isConnected: () => connected,
    open,
    notice,
    error,
  });
  return {
    reconnect,
    device,
    list,
    open,
    notice,
    error,
    busy(value: boolean) {
      busy = value;
    },
    connected(value: boolean) {
      connected = value;
    },
  };
}

describe('automatic authorized-tablet reopening', () => {
  it('starts off and opens an authorized device on page load when enabled', async () => {
    const f = fixture();
    await f.reconnect.request('USB connection');
    expect(f.list).not.toHaveBeenCalled();
    await f.reconnect.setEnabled(true, 'page load');
    expect(f.open).toHaveBeenCalledExactlyOnceWith(f.device, 'page load');
  });

  it.each([0, 2])('asks for manual selection with %i authorized tablets', async (count) => {
    const f = fixture();
    f.list.mockResolvedValue(Array.from({ length: count }, () => new MockTransport()));
    await f.reconnect.setEnabled(true);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Choose STU-540'));
  });

  it('defers a USB event until a running test and its review finish', async () => {
    const f = fixture();
    await f.reconnect.setEnabled(true);
    f.connected(false);
    f.busy(true);
    await f.reconnect.request('USB connection');
    expect(f.open).toHaveBeenCalledTimes(1);
    f.busy(false);
    await f.reconnect.flush();
    expect(f.open).toHaveBeenLastCalledWith(f.device, 'USB connection');
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it.each(['disable', 'manual action', 'page closed'] as const)(
    'discards a late lookup after %s',
    async (action) => {
      const f = fixture();
      let resolve!: (devices: MockTransport[]) => void;
      f.list.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const opening = f.reconnect.setEnabled(true);
      if (action === 'disable') await f.reconnect.setEnabled(false);
      else if (action === 'page closed') f.reconnect.dispose();
      else f.reconnect.cancelPending();
      resolve([f.device]);
      await opening;
      expect(f.open).not.toHaveBeenCalled();
    },
  );

  it('coalesces duplicate connection events while discovery is pending', async () => {
    const f = fixture();
    let resolve!: (devices: MockTransport[]) => void;
    f.list.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const opening = f.reconnect.setEnabled(true);
    await f.reconnect.request('USB connection');
    await f.reconnect.request('USB connection');
    resolve([f.device]);
    await opening;
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it('yields to a manual operation that started during discovery', async () => {
    const f = fixture();
    let resolve!: (devices: MockTransport[]) => void;
    f.list.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const opening = f.reconnect.setEnabled(true);
    f.busy(true);
    resolve([f.device]);
    await opening;
    expect(f.open).not.toHaveBeenCalled();
    f.reconnect.cancelPending();
    f.busy(false);
    await f.reconnect.flush();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('leaves a manually closed connection alone until a new connection event', async () => {
    const f = fixture();
    await f.reconnect.setEnabled(true);
    f.reconnect.cancelPending();
    f.connected(false);
    await f.reconnect.flush();
    expect(f.open).toHaveBeenCalledTimes(1);
    await f.reconnect.request('USB connection');
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it('reports discovery failure without starting a retry loop', async () => {
    const f = fixture();
    const error = new Error('Permission unavailable');
    f.list.mockRejectedValue(error);
    await f.reconnect.setEnabled(true);
    await f.reconnect.flush();
    expect(f.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.open).not.toHaveBeenCalled();
  });
});
