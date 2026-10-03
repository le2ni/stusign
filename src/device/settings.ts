import type { OperationOptions, Rectangle } from '../types.js';
import { boolean, integer, invariant, StuError } from '../errors.js';
import * as codecs from '../protocol/codecs.js';
import type { Codec, InkThreshold } from '../protocol/codecs.js';
import { ascii, validateRectangle } from '../protocol/binary.js';
import { ReportId } from '../protocol/catalogue.js';
import { rgbTo565 } from '../protocol/images.js';
import type { DeviceContext } from './context.js';

export interface BacklightSetting {
  readonly level: 0 | 1 | 2 | 3 | 'off';
  readonly persist?: boolean;
}

export class Settings {
  constructor(private readonly device: DeviceContext) {}
  private get<T>(codec: Codec<T>, options?: OperationOptions): Promise<T> {
    return this.device.run(
      'read setting',
      async (tx) => codec.decode(await this.device.read(tx, codec.id)),
      options,
    );
  }
  private set<T>(
    codec: Codec<T>,
    value: T,
    allowed: readonly number[] = [0, 2],
    options?: OperationOptions,
  ): Promise<void> {
    const payload = codec.encode(value);
    return this.device.run(
      'write setting',
      async (tx) => {
        await this.device.waitStatus(tx, allowed);
        await this.device.write(tx, codec.id, payload);
        await this.device.status(tx, true);
      },
      options,
    );
  }
  getInking(options?: OperationOptions): Promise<boolean> {
    return this.get(codecs.inkingMode, options).then(Boolean);
  }
  setInking(enabled: boolean, options?: OperationOptions): Promise<void> {
    return this.set(codecs.inkingMode, Number(boolean(enabled, 'inking')), [0, 2], options);
  }
  getRenderingMode(options?: OperationOptions): Promise<number> {
    return this.get(codecs.renderingMode, options);
  }
  setRenderingMode(mode: 0 | 1, options?: OperationOptions): Promise<void> {
    return this.set(codecs.renderingMode, mode, [0, 2], options);
  }
  getReportRate(options?: OperationOptions): Promise<number> {
    return this.get(codecs.reportRate, options);
  }
  setReportRate(rate: number, options?: OperationOptions): Promise<void> {
    integer(rate, 1, this.device.capability.maxReportRate || 255, 'report rate');
    return this.set(codecs.reportRate, rate, [0], options);
  }
  async getPenDataOptionMode(options?: OperationOptions): Promise<number> {
    const mode = await this.get(codecs.penDataOptionMode, options);
    this.device.setOptionMode(mode);
    return mode;
  }
  async setPenDataOptionMode(mode: 0 | 1 | 2 | 3, options?: OperationOptions): Promise<void> {
    // Report option changes must happen outside encrypted capture.
    await this.set(codecs.penDataOptionMode, mode, [0], options);
    this.device.setOptionMode(mode);
  }
  getInkThreshold(options?: OperationOptions): Promise<InkThreshold> {
    return this.get(codecs.inkThreshold, options);
  }
  setInkThreshold(value: InkThreshold, options?: OperationOptions): Promise<void> {
    integer(value.on, 0, this.device.capability.pressureMax, 'on threshold');
    return this.set(codecs.inkThreshold, value, [0], options);
  }
  getHandwritingArea(options?: OperationOptions): Promise<Rectangle> {
    return this.get(codecs.handwritingArea, options);
  }
  setHandwritingArea(rectangle: Rectangle, options?: OperationOptions): Promise<void> {
    validateRectangle(
      rectangle,
      this.device.capability.screenWidth,
      this.device.capability.screenHeight,
    );
    return this.set(codecs.handwritingArea, rectangle, [0, 2], options);
  }
  getBacklight(options?: OperationOptions): Promise<number> {
    return this.get(codecs.backlight, options);
  }
  setBacklight(setting: BacklightSetting, options?: OperationOptions): Promise<void> {
    if (setting.persist !== undefined) boolean(setting.persist, 'persist');
    const level = setting.level === 'off' ? 4 : integer(setting.level, 0, 3, 'backlight level');
    if (/^STU-520/.test(this.device.identity.modelName)) {
      invariant(level !== 4, 'STU-520 does not have the off level');
      invariant(
        setting.persist === true,
        'STU-520 brightness writes persist; explicitly request persist: true',
      );
      return this.set(codecs.backlight, level, [0, 2], options);
    }
    return this.set(codecs.backlight, level | (setting.persist ? 0x8000 : 0), [0, 2], options);
  }
  getContrast(options?: OperationOptions): Promise<number> {
    return this.get(codecs.contrast, options);
  }
  setContrast(value: number, options?: OperationOptions): Promise<void> {
    return this.set(codecs.contrast, value, [0, 2], options);
  }
  getBackground(
    options?: OperationOptions,
  ): Promise<{ readonly color: number; readonly format: 'rgb565' | 'rgb24' }> {
    const modern = this.device.transport.limits.featureReports.has(ReportId.BackgroundColor24);
    return this.get(modern ? codecs.background24 : codecs.background16, options).then((color) => ({
      color,
      format: modern ? 'rgb24' : 'rgb565',
    }));
  }
  /** Volatile clear-screen color. Reapply via startupBackground after a power cycle. */
  setBackground(color: number, options?: OperationOptions): Promise<void> {
    integer(color, 0, 0xffffff, 'RGB color');
    const modern = this.device.transport.limits.featureReports.has(ReportId.BackgroundColor24);
    return this.set(
      modern ? codecs.background24 : codecs.background16,
      modern ? color : rgbTo565(color),
      [0, 2],
      options,
    );
  }
  getInkStyle(
    options?: OperationOptions,
  ): Promise<codecs.InkStyle & { readonly format: 'rgb565' | 'rgb24' }> {
    const modern = this.device.transport.limits.featureReports.has(
      ReportId.HandwritingThicknessColor24,
    );
    return this.get(modern ? codecs.inkStyle24 : codecs.inkStyle16, options).then((style) => ({
      ...style,
      format: modern ? 'rgb24' : 'rgb565',
    }));
  }
  setInkStyle(style: codecs.InkStyle, options?: OperationOptions): Promise<void> {
    integer(style.color, 0, 0xffffff, 'RGB color');
    if (/^STU-(300|430|500)/.test(this.device.identity.modelName) && style.color !== 0)
      throw new StuError('UNSUPPORTED_FEATURE', 'Monochrome ink must be black');
    const modern = this.device.transport.limits.featureReports.has(
      ReportId.HandwritingThicknessColor24,
    );
    return this.set(
      modern ? codecs.inkStyle24 : codecs.inkStyle16,
      { color: modern ? style.color : rgbTo565(style.color), thickness: style.thickness },
      [0, 2],
      options,
    );
  }
  /** Whether the firmware boot screen is enabled; this does not read its image. */
  getBootScreen(options?: OperationOptions): Promise<boolean> {
    return this.get(codecs.bootScreen, options).then(Boolean);
  }
  /** Enable/disable the firmware boot screen. */
  setBootScreen(enabled: boolean, options?: OperationOptions): Promise<void> {
    return this.set(codecs.bootScreen, Number(boolean(enabled, 'boot screen')), [0], options);
  }
  getUid(options?: OperationOptions): Promise<number> {
    return this.get(codecs.uid, options);
  }
  setUid(value: number, options?: OperationOptions): Promise<void> {
    return this.set(codecs.uid, value, [0], options);
  }
  getDefaultMode(options?: OperationOptions): Promise<number> {
    return this.get(codecs.defaultMode, options);
  }
  /** Persistent provisioning; the new mode may require reset/re-enumeration. */
  setDefaultMode(mode: 'hid' | 'serial', options?: OperationOptions): Promise<void> {
    invariant(mode === 'hid' || mode === 'serial', 'Invalid default transport');
    return this.set(codecs.defaultMode, mode === 'hid' ? 1 : 2, [0], options);
  }
  getSerial(kind: 'uid2' | 'extended' = 'extended', options?: OperationOptions): Promise<string> {
    return this.device.run(
      'read serial identity',
      async (tx) =>
        ascii(await this.device.read(tx, kind === 'uid2' ? ReportId.Uid2 : ReportId.Eserial)),
      options,
    );
  }
}
