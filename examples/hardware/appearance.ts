import { StuError } from 'stusign';
import type { OperationOptions, StuDevice } from 'stusign';
import { rgbTo565 } from 'stusign/protocol';
import type { RgbaImage } from 'stusign/protocol';

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Save only explicitly applied colors, independently of volatile device readback. */
export class BackgroundPreference {
  enabled = true;
  color: number | undefined;

  constructor(
    private readonly key: string,
    private readonly storage: PreferenceStorage,
  ) {}

  get startupColor(): number | undefined {
    return this.enabled ? this.color : undefined;
  }

  restore(): void {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('enabled' in value) ||
      typeof value.enabled !== 'boolean' ||
      ('color' in value &&
        (typeof value.color !== 'number' ||
          !Number.isInteger(value.color) ||
          value.color < 0 ||
          value.color > 0xffffff))
    )
      throw new Error('The remembered background is invalid. Apply a color to save it again.');
    this.enabled = value.enabled;
    this.color = 'color' in value ? (value.color as number) : undefined;
  }

  remember(color: number): void {
    if (!Number.isInteger(color) || color < 0 || color > 0xffffff)
      throw new Error('Invalid background RGB color.');
    this.color = color;
    this.persist();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.persist();
  }

  private persist(): void {
    this.storage.setItem(this.key, JSON.stringify({ enabled: this.enabled, color: this.color }));
  }
}

export function backgroundRgb(background: { color: number; format: 'rgb24' | 'rgb565' }): number {
  if (background.format === 'rgb24') return background.color;
  const red = Math.round((((background.color >>> 11) & 31) * 255) / 31);
  const green = Math.round((((background.color >>> 5) & 63) * 255) / 63);
  const blue = Math.round(((background.color & 31) * 255) / 31);
  return (red << 16) | (green << 8) | blue;
}

export function solidImage(width: number, height: number, color: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const pixel = [color >>> 16, (color >>> 8) & 255, color & 255, 255];
  for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
  return { width, height, data };
}

/** Verify the flag without restarting the tablet or claiming a visual power-on check. */
export async function applyBootScreen(
  device: StuDevice,
  enabled: boolean,
  options?: OperationOptions,
): Promise<void> {
  await device.settings.setBootScreen(enabled, options);
  if ((await device.settings.getBootScreen(options)) !== enabled)
    throw new StuError('DEVICE_STATUS', 'The boot-screen setting did not match on readback');
}

/** Keep the chosen setting; only clear after the tablet confirms it. */
export async function applyBackground(
  device: StuDevice,
  color: number,
  options?: OperationOptions,
): Promise<number> {
  await device.settings.setBackground(color, options);
  const actual = await device.settings.getBackground(options);
  if (actual.color !== (actual.format === 'rgb24' ? color : rgbTo565(color)))
    throw new StuError('DEVICE_STATUS', 'The background color did not match on readback');
  await device.display.clear(undefined, options);
  return backgroundRgb(actual);
}
