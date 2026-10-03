import { describe, expect, it } from 'vitest';
import { StuDevice } from '../src/index.js';
import { ReportId } from '../src/protocol/index.js';
import { MockTransport } from '../src/testing/index.js';
import {
  applyBackground,
  applyBootScreen,
  BackgroundPreference,
} from '../examples/hardware/appearance.js';

describe('guided display setting changes', () => {
  it('disables and re-enables the boot flag without resetting or changing the current image', async () => {
    const transport = new MockTransport();
    const device = await StuDevice.open(transport);
    await applyBootScreen(device, false);
    expect(await device.settings.getBootScreen()).toBe(false);
    await applyBootScreen(device, true);
    expect(await device.settings.getBootScreen()).toBe(true);
    expect(
      transport.calls
        .filter((call) => call.kind === 'write')
        .map((call) => [call.id, call.payload]),
    ).toEqual([
      [ReportId.BootScreen, Uint8Array.of(0)],
      [ReportId.BootScreen, Uint8Array.of(1)],
    ]);
    await device.close();
  });

  it('does not report success if the boot-screen flag fails readback', async () => {
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (id === ReportId.BootScreen) transport.reports.set(id, Uint8Array.of(0));
      },
    });
    const device = await StuDevice.open(transport);
    await expect(applyBootScreen(device, true)).rejects.toMatchObject({ code: 'DEVICE_STATUS' });
    await device.close();
  });

  it.each([
    {
      legacy: false,
      report: ReportId.BackgroundColor24,
      bytes: Uint8Array.of(0x56, 0x34, 0x12),
      displayed: 0x123456,
    },
    {
      legacy: true,
      report: ReportId.BackgroundColor,
      bytes: Uint8Array.of(0xaa, 0x11),
      displayed: 0x103552,
    },
  ])(
    'verifies $report then clears with no image transfer',
    async ({ legacy, report, bytes, displayed }) => {
      const transport = new MockTransport();
      if (legacy)
        (transport.limits.featureReports as Map<number, number>).delete(ReportId.BackgroundColor24);
      const device = await StuDevice.open(transport);
      await expect(applyBackground(device, 0x123456)).resolves.toBe(displayed);
      expect(
        transport.calls
          .filter((call) => call.kind === 'write')
          .map((call) => [call.id, call.payload]),
      ).toEqual([
        [report, bytes],
        [ReportId.ClearScreen, Uint8Array.of(0)],
      ]);
      expect(
        transport.calls.findIndex((call) => call.kind === 'read' && call.id === report),
      ).toBeLessThan(transport.calls.findIndex((call) => call.id === ReportId.ClearScreen));
      await device.close();
    },
  );

  it('keeps the existing image if background readback fails', async () => {
    const transport = new MockTransport({
      beforeRead: async (id) => {
        if (id === ReportId.BackgroundColor24) transport.reports.set(id, new Uint8Array(3));
      },
    });
    const device = await StuDevice.open(transport);
    await expect(applyBackground(device, 0xffffff)).rejects.toMatchObject({
      code: 'DEVICE_STATUS',
    });
    expect(
      transport.calls.some((call) => call.kind === 'write' && call.id === ReportId.ClearScreen),
    ).toBe(false);
    await device.close();
  });
});

describe('remembered background', () => {
  const storage = () => {
    const entries = new Map<string, string>();
    return {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
  };

  it('does not change a tablet until a color is applied, then remembers black across reloads', () => {
    const saved = storage();
    const preference = new BackgroundPreference('hardware', saved);
    preference.restore();
    expect(preference.startupColor).toBeUndefined();
    preference.remember(0);
    const reloaded = new BackgroundPreference('hardware', saved);
    reloaded.restore();
    expect(reloaded.startupColor).toBe(0);
    const simulation = new BackgroundPreference('simulation', saved);
    simulation.restore();
    expect(simulation.startupColor).toBeUndefined();
  });

  it('remembers opting out without losing the chosen color', () => {
    const saved = storage();
    const preference = new BackgroundPreference('hardware', saved);
    preference.remember(0x123456);
    preference.setEnabled(false);
    const reloaded = new BackgroundPreference('hardware', saved);
    reloaded.restore();
    expect(reloaded.startupColor).toBeUndefined();
    reloaded.setEnabled(true);
    expect(reloaded.startupColor).toBe(0x123456);
  });

  it('keeps the current choice usable if browser storage fails', () => {
    const preference = new BackgroundPreference('hardware', {
      getItem: () => null,
      setItem: () => {
        throw new Error('Storage unavailable');
      },
    });
    expect(() => preference.remember(0x123456)).toThrow();
    expect(preference.startupColor).toBe(0x123456);
  });

  it.each(['null', '{"enabled":true,"color":-1}', '{"enabled":true,"color":"black"}'])(
    'rejects invalid stored preferences: %s',
    (value) => {
      const preference = new BackgroundPreference('hardware', {
        getItem: () => value,
        setItem: () => {},
      });
      expect(() => preference.restore()).toThrow();
      expect(preference.startupColor).toBeUndefined();
    },
  );
});
