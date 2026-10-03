import { StuError, integer } from '../errors.js';
import { Emitter } from '../events.js';
import type { InputReport, ReportTransport, TransportLimits, Unsubscribe } from '../types.js';
import { ReportId } from '../protocol/catalogue.js';

export interface HidReportDescription {
  readonly reportId: number;
  readonly items: readonly { readonly reportSize: number; readonly reportCount: number }[];
}
export interface HidCollection {
  readonly featureReports?: readonly HidReportDescription[];
  readonly inputReports?: readonly HidReportDescription[];
  readonly children?: readonly HidCollection[];
}
export interface HidInputEvent {
  readonly reportId: number;
  readonly data: DataView;
}
export interface HidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly opened: boolean;
  readonly collections: readonly HidCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  sendFeatureReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: HidInputEvent) => void): void;
  removeEventListener(type: 'inputreport', listener: (event: HidInputEvent) => void): void;
}
export interface HidConnectionEvent {
  readonly device: HidDevice;
}
export interface HidApi {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: {
    filters: { vendorId: number; productId: number }[];
  }): Promise<HidDevice[]>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: HidConnectionEvent) => void,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: HidConnectionEvent) => void,
  ): void;
}
export interface WebHidOptions {
  readonly hid?: HidApi;
  readonly featureReportPrefix?: 'auto' | 'included' | 'excluded';
}

export const WACOM_VENDOR_ID = 0x056a;
/** IDs from Wacom's UsbDevice constants; 541 requires its separate TLS backend. */
export const STU_PRODUCT_IDS: readonly number[] = Object.freeze([
  0x00a1, 0x00a2, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8,
]);
const owners = new WeakMap<HidDevice, WebHidTransport>();

export function getHidReportLengths(collections: readonly HidCollection[]): TransportLimits {
  const featureReports = new Map<number, number>(),
    inputReports = new Map<number, number>();
  const visit = (collection: HidCollection): void => {
    for (const [reports, target] of [
      [collection.featureReports, featureReports],
      [collection.inputReports, inputReports],
    ] as const) {
      for (const report of reports ?? []) {
        const bits = report.items.reduce(
          (total, item) =>
            total +
            integer(item.reportSize, 0, 65535, 'reportSize') *
              integer(item.reportCount, 0, 65535, 'reportCount'),
          0,
        );
        const length = Math.ceil(bits / 8);
        integer(length, 1, 65535, 'report length');
        const previous = target.get(report.reportId);
        if (previous !== undefined && previous !== length)
          throw new StuError('MALFORMED_REPORT', 'Conflicting HID report descriptors');
        target.set(report.reportId, length);
      }
    }
    for (const child of collection.children ?? []) visit(child);
  };
  collections.forEach(visit);
  return { featureReports, inputReports };
}

export function normalizeFeatureReport(
  reportId: number,
  data: DataView,
  payloadLength: number,
  prefix: WebHidOptions['featureReportPrefix'] = 'auto',
): Uint8Array {
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (prefix !== 'included' && raw.length === payloadLength) return raw.slice();
  if (prefix !== 'excluded' && raw.length === payloadLength + 1 && raw[0] === reportId)
    return raw.slice(1);
  throw new StuError('MALFORMED_REPORT', 'Feature-report framing does not match the descriptor', {
    reportId,
  });
}

export class WebHidTransport implements ReportTransport {
  readonly kind = 'webhid';
  readonly limits: TransportLimits;
  private active = false;
  private generation = 0;
  private opening = false;
  private ownsDevice = false;
  private closing: Promise<void> | undefined;
  private readonly input = new Emitter<InputReport>();
  private readonly disconnected = new Emitter<unknown>();
  private readonly inputListener = (event: HidInputEvent): void => {
    if (!this.active) return;
    this.input.emit({
      reportId: event.reportId,
      payload: new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength,
      ).slice(),
      receivedAt: performance.now(),
    });
  };
  private readonly disconnectListener = (event: HidConnectionEvent): void => {
    if (event.device === this.device && this.active) {
      this.generation++;
      this.active = false;
      this.detach();
      this.disconnected.emit(new StuError('DISCONNECTED', 'Tablet unplugged'));
    }
  };

  constructor(
    readonly device: HidDevice,
    private readonly options: WebHidOptions = {},
  ) {
    if (device.vendorId !== WACOM_VENDOR_ID || !STU_PRODUCT_IDS.includes(device.productId))
      throw new StuError('UNSUPPORTED_FEATURE', 'Device is not a supported STU HID product');
    this.limits = getHidReportLengths(device.collections);
    for (const id of [ReportId.Status, ReportId.Information, ReportId.Capability]) {
      if (!this.limits.featureReports.has(id))
        throw new StuError('UNSUPPORTED_FEATURE', 'STU control collection is missing', {
          reportId: id,
        });
    }
  }

  async open(): Promise<void> {
    if (this.active) return;
    if (this.opening) throw new StuError('DEVICE_BUSY', 'HID open is already pending');
    if (this.closing || (owners.has(this.device) && owners.get(this.device) !== this))
      throw new StuError(
        'DEVICE_BUSY',
        'This HID interface belongs to another connection or is closing',
      );
    if (this.device.opened) throw new StuError('DEVICE_BUSY', 'This HID handle is already open');
    const generation = ++this.generation;
    owners.set(this.device, this);
    this.opening = true;
    try {
      await this.device.open();
    } catch (cause) {
      if (owners.get(this.device) === this) owners.delete(this.device);
      throw new StuError(
        cause instanceof Error && ['NetworkError', 'NotAllowedError'].includes(cause.name)
          ? 'TRANSPORT'
          : 'PERMISSION_DENIED',
        'Unable to open the HID interface',
        { cause },
      );
    } finally {
      this.opening = false;
    }
    this.ownsDevice = true;
    if (generation !== this.generation) {
      await this.close();
      throw new StuError('DISCONNECTED', 'HID open completed after close');
    }
    this.active = true;
    this.device.addEventListener('inputreport', this.inputListener);
    this.options.hid?.addEventListener('disconnect', this.disconnectListener);
  }

  private check(id: number): number {
    if (!this.active || !this.device.opened)
      throw new StuError('DISCONNECTED', 'HID interface is closed');
    const length = this.limits.featureReports.get(id);
    if (length === undefined)
      throw new StuError(
        'UNSUPPORTED_FEATURE',
        'Feature report is absent from the HID descriptor',
        { reportId: id },
      );
    return length;
  }

  async readReport(id: number): Promise<Uint8Array> {
    const length = this.check(id),
      generation = this.generation;
    try {
      const value = await this.device.receiveFeatureReport(id);
      this.check(id);
      if (generation !== this.generation)
        throw new StuError('DISCONNECTED', 'Read belongs to an earlier connection');
      return normalizeFeatureReport(id, value, length, this.options.featureReportPrefix);
    } catch (error) {
      if (error instanceof StuError) throw error;
      throw new StuError(
        isPermissionError(error) ? 'PERMISSION_DENIED' : 'TRANSPORT',
        'read feature report failed',
        {
          operation: 'read feature report',
          reportId: id,
          cause: error,
        },
      );
    }
  }

  async writeReport(id: number, payload: Uint8Array): Promise<void> {
    const length = this.check(id),
      generation = this.generation;
    if (payload.length > length)
      throw new StuError('INVALID_ARGUMENT', 'Payload exceeds HID report length', { reportId: id });
    const padded = new Uint8Array(length);
    padded.set(payload);
    try {
      await this.device.sendFeatureReport(id, padded);
      this.check(id);
      if (generation !== this.generation)
        throw new StuError('DISCONNECTED', 'Write belongs to an earlier connection');
    } catch (error) {
      if (error instanceof StuError) throw error;
      throw new StuError(
        isPermissionError(error) ? 'PERMISSION_DENIED' : 'TRANSPORT',
        'write feature report failed',
        {
          operation: 'write feature report',
          reportId: id,
          cause: error,
        },
      );
    }
  }

  onInput(listener: (report: InputReport) => void): Unsubscribe {
    return this.input.on(listener);
  }
  onDisconnect(listener: (reason: unknown) => void): Unsubscribe {
    return this.disconnected.on(listener);
  }
  private detach(): void {
    this.device.removeEventListener('inputreport', this.inputListener);
    this.options.hid?.removeEventListener('disconnect', this.disconnectListener);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.generation++;
    this.active = false;
    this.detach();
    if (!this.ownsDevice) return Promise.resolve();
    this.closing = Promise.resolve()
      .then(async () => {
        if (this.device.opened) await this.device.close();
        this.ownsDevice = false;
        if (owners.get(this.device) === this) owners.delete(this.device);
      })
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
  async forget(): Promise<void> {
    await this.close();
    if (!this.device.forget)
      throw new StuError('UNSUPPORTED_FEATURE', 'Permission revocation is unavailable');
    await this.device.forget();
  }
}

function isPermissionError(error: unknown): boolean {
  // Chromium's FinishReceive/SendFeatureReport also uses NotAllowedError for
  // failed OS transfers. Its name alone is not evidence of denied permission.
  return error instanceof Error && error.name === 'SecurityError';
}

export interface WebHidManager {
  requestDevice(): Promise<WebHidTransport | null>;
  getAuthorizedDevices(): Promise<readonly WebHidTransport[]>;
  onConnection(listener: (event: { connected: boolean; device: HidDevice }) => void): Unsubscribe;
}

export function createWebHidManager(options: WebHidOptions = {}): WebHidManager {
  const hid = options.hid ?? (globalThis as { navigator?: { hid?: HidApi } }).navigator?.hid;
  if (!hid)
    throw new StuError(
      'UNSUPPORTED_BROWSER',
      'WebHID is unavailable; use a supported browser in a secure context',
    );
  const supported = (device: HidDevice): boolean =>
    device.vendorId === WACOM_VENDOR_ID && STU_PRODUCT_IDS.includes(device.productId);
  const wrap = (device: HidDevice): WebHidTransport =>
    new WebHidTransport(device, { ...options, hid });
  return {
    async requestDevice() {
      // No await before requestDevice: preserve the caller's user activation.
      try {
        const selected = await hid.requestDevice({
          filters: STU_PRODUCT_IDS.map((productId) => ({ vendorId: WACOM_VENDOR_ID, productId })),
        });
        return selected[0] ? wrap(selected[0]) : null;
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'NotFoundError') return null;
        if (cause instanceof StuError) throw cause;
        throw new StuError('PERMISSION_DENIED', 'HID selection failed', { cause });
      }
    },
    async getAuthorizedDevices() {
      return (await hid.getDevices()).filter(supported).map(wrap);
    },
    onConnection(listener) {
      const connect = (event: HidConnectionEvent): void => {
        if (supported(event.device)) listener({ connected: true, device: event.device });
      };
      const disconnect = (event: HidConnectionEvent): void => {
        if (supported(event.device)) listener({ connected: false, device: event.device });
      };
      hid.addEventListener('connect', connect);
      hid.addEventListener('disconnect', disconnect);
      return () => {
        hid.removeEventListener('connect', connect);
        hid.removeEventListener('disconnect', disconnect);
      };
    },
  };
}
