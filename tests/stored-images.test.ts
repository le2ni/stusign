import { describe, expect, it } from 'vitest';
import { StuDevice } from '../src/index.js';
import { MockTransport } from '../src/testing/index.js';
import { ReportId } from '../src/protocol/index.js';

const rgba = () => ({ width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(255) });
const slot = { kind: 'slideshow', number: 10 } as const;

describe('stored images and connection welcome images', () => {
  it('stores once, recalls with a selector, and keeps the slot across reconnects', async () => {
    const transport = new MockTransport({ simulateRom: true });
    const tablet = await StuDevice.open(transport);
    const reference = await tablet.rom.storeImage(slot, rgba());
    expect(reference.slot).toEqual(slot);
    expect(reference.hash).toHaveLength(16);
    expect(transport.calls.find(({ id }) => id === ReportId.RomStartImageData)?.payload).toEqual(
      Uint8Array.of(4, 2, 10, 0, 0, 0),
    );
    await tablet.close();
    const start = transport.calls.length;
    const reopened = await StuDevice.open(transport, {
      startupImage: {
        source: 'stored',
        slot: reference.slot,
        expectedHash: reference.hash,
      },
    });
    await reopened.rom.display(slot);
    const writes = transport.calls.slice(start).filter(({ kind }) => kind === 'write');
    expect(
      writes.filter(({ id }) => id === ReportId.RomImageDisplay).map(({ payload }) => payload),
    ).toEqual([Uint8Array.of(2, 10), Uint8Array.of(2, 10)]);
    expect(
      writes.every(({ id }) => id === ReportId.RomImageHash || id === ReportId.RomImageDisplay),
    ).toBe(true);
    await reopened.close();
  });
  it('never overwrites an occupied slot without an explicit overwrite option', async () => {
    const transport = new MockTransport({ simulateRom: true });
    const tablet = await StuDevice.open(transport);
    const first = await tablet.rom.storeImage(slot, rgba());
    const start = transport.calls.length;
    await expect(tablet.rom.storeImage(slot, rgba())).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(transport.calls.slice(start).some(({ id }) => id === ReportId.RomStartImageData)).toBe(
      false,
    );
    const second = await tablet.rom.storeImage(slot, rgba(), { overwrite: true });
    expect(second.hash).not.toEqual(first.hash);
    const beforeDisplay = transport.calls.length;
    await expect(tablet.rom.display(slot, { expectedHash: first.hash })).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
    });
    expect(
      transport.calls.slice(beforeDisplay).some(({ id }) => id === ReportId.RomImageDisplay),
    ).toBe(false);
    await tablet.close();
  });
  it('rejects an unknown slot result even with overwrite enabled', async () => {
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (id === ReportId.RomImageHash) transport.reports.get(id)![2] = 0x15;
      },
    });
    const tablet = await StuDevice.open(transport);
    await expect(tablet.rom.storeImage(slot, rgba(), { overwrite: true })).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
      status: 0x15,
    });
    expect(transport.calls.some(({ id }) => id === ReportId.RomStartImageData)).toBe(false);
    await tablet.close();
  });
  it('fails if the committed slot cannot be read back as stored', async () => {
    let queried = false;
    const transport = new MockTransport({
      simulateRom: true,
      beforeRead: async (id) => {
        if (id === ReportId.RomImageHash) {
          if (queried) transport.reports.get(id)![2] = 1;
          queried = true;
        }
      },
    });
    const tablet = await StuDevice.open(transport);
    await expect(tablet.rom.storeImage(slot, rgba())).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
    });
    await tablet.close();
  });
  it('abandons a cancelled replacement and retains the previous stored reference', async () => {
    const controller = new AbortController();
    let cancel = false;
    const transport = new MockTransport({
      simulateRom: true,
      beforeWrite: async (id) => {
        if (cancel && id === ReportId.ImageDataBlock) controller.abort();
      },
    });
    const tablet = await StuDevice.open(transport);
    const previous = await tablet.rom.storeImage(slot, rgba());
    cancel = true;
    await expect(
      tablet.rom.storeImage(slot, rgba(), { overwrite: true, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect((await tablet.rom.getHash(slot)).hash).toEqual(previous.hash);
    expect(
      transport.calls.filter(({ id }) => id === ReportId.EndImageData).at(-1)?.payload,
    ).toEqual(Uint8Array.of(1));
    await tablet.close();
  });
  it('rejects invalid dimensions and missing reports before starting a persistent transfer', async () => {
    const transport = new MockTransport({ simulateRom: true });
    const tablet = await StuDevice.open(transport);
    expect(() =>
      tablet.rom.storeImage(slot, { width: 1, height: 1, data: new Uint8Array(4) }),
    ).toThrow(/dimensions/);
    (transport.limits.featureReports as Map<number, number>).delete(ReportId.RomImageHash);
    expect(() => tablet.rom.storeImage(slot, rgba())).toThrow(/descriptor/);
    expect(transport.calls.some(({ id }) => id === ReportId.RomStartImageData)).toBe(false);
    await tablet.close();
  });
  it('does not fall back to uploading when a startup slot is missing', async () => {
    const transport = new MockTransport({ simulateRom: true });
    await expect(
      StuDevice.open(transport, {
        startupImage: {
          source: 'stored',
          slot,
          expectedHash: new Uint8Array(16),
        },
      }),
    ).rejects.toMatchObject({ code: 'DEVICE_STATUS' });
    expect(transport.calls.at(-1)?.kind).toBe('close');
    expect(
      transport.calls.some(
        ({ id }) => id === ReportId.ImageDataBlock || id === ReportId.RomStartImageData,
      ),
    ).toBe(false);
  });
  it('rejects recall of a deleted slot while preserving other stored images', async () => {
    const transport = new MockTransport({ simulateRom: true });
    const tablet = await StuDevice.open(transport);
    const saved = await tablet.rom.storeImage(slot, rgba());
    const other = await tablet.rom.storeImage({ kind: 'message', number: 6 }, rgba());
    await tablet.rom.delete(slot);
    await expect(
      tablet.rom.display(saved.slot, { expectedHash: saved.hash }),
    ).rejects.toMatchObject({ code: 'DEVICE_STATUS' });
    await tablet.rom.display(other.slot, { expectedHash: other.hash });
    await tablet.close();
  });
  it('snapshots uploaded startup pixels before opening the transport', async () => {
    const transport = new MockTransport();
    const image = rgba();
    const opening = StuDevice.open(transport, { startupImage: { source: 'upload', image } });
    image.data.fill(0);
    const tablet = await opening;
    const blocks = transport.calls.filter(
      ({ id, kind }) => kind === 'write' && id === ReportId.ImageDataBlock,
    );
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]?.payload?.subarray(2).every((byte) => byte === 255)).toBe(true);
    expect(
      transport.calls.some(
        ({ id }) => id === ReportId.RomStartImageData || id === ReportId.BootScreen,
      ),
    ).toBe(false);
    await tablet.close();
  });
  it('keeps slot validation, upload and readback together in the queue', async () => {
    const transport = new MockTransport({ simulateRom: true });
    const tablet = await StuDevice.open(transport);
    await Promise.all([tablet.rom.storeImage(slot, rgba()), tablet.settings.setInking(false)]);
    const writes = transport.calls.filter(({ kind }) => kind === 'write');
    expect(writes.at(-1)?.id).toBe(ReportId.InkingMode);
    expect(writes.at(-2)?.id).toBe(ReportId.RomImageHash);
    await tablet.close();
  });
});
