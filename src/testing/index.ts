import { Emitter } from '../events.js';
import { StuError, integer } from '../errors.js';
import type { InputReport, ReportTransport, TransportLimits, Unsubscribe } from '../types.js';
import { ReportId, reportDefinitions } from '../protocol/catalogue.js';

export interface TransportCall {
  readonly kind: 'open' | 'close' | 'read' | 'write';
  readonly id?: number;
  readonly payload?: Uint8Array;
}
export interface MockOptions {
  readonly model?: string;
  readonly width?: number;
  readonly height?: number;
  readonly blockCapacity?: number;
  readonly beforeRead?: (id: number) => Promise<void>;
  readonly beforeWrite?: (id: number, payload: Uint8Array) => Promise<void>;
  /** Emulate ROM persistence across close/open. Hashes are synthetic identities, not MD5. */
  readonly simulateRom?: boolean;
}

/** Synthetic device, not a claim of hardware interoperability. Never feed real PINs into a call-recording mock. */
export class MockTransport implements ReportTransport {
  readonly kind = 'mock';
  readonly calls: TransportCall[] = [];
  readonly reports = new Map<number, Uint8Array>();
  readonly limits: TransportLimits;
  private opened = false;
  private readonly inputs = new Emitter<InputReport>();
  private readonly disconnects = new Emitter<unknown>();
  private readonly romImages = new Map<string, Uint8Array>();
  private romUpload: { slot: string } | undefined;
  private romRevision = 0;
  constructor(private readonly options: MockOptions = {}) {
    const features = new Map<number, number>(),
      inputs = new Map<number, number>();
    for (const definition of reportDefinitions)
      if (definition.payloadLength !== undefined) {
        if (definition.read || definition.write)
          features.set(definition.id, definition.payloadLength);
        if (definition.input) inputs.set(definition.id, definition.payloadLength);
        this.reports.set(definition.id, new Uint8Array(definition.payloadLength));
      }
    features.set(ReportId.ImageDataBlock, (options.blockCapacity ?? 253) + 2);
    this.limits = { featureReports: features, inputReports: inputs };
    const information = new Uint8Array(16);
    const model = options.model ?? 'STU-540';
    Array.from(model)
      .slice(0, 9)
      .forEach((char, i) => {
        information[i] = char.charCodeAt(0);
      });
    information[9] = 1;
    this.reports.set(ReportId.Information, information);
    const capability = new Uint8Array(16),
      data = new DataView(capability.buffer);
    [8000, 4800, 1023, options.width ?? 16, options.height ?? 8].forEach((value, i) =>
      data.setUint16(i * 2, value),
    );
    capability[10] = 200;
    data.setUint16(11, 2540);
    capability[13] = 15;
    this.reports.set(ReportId.Capability, capability);
  }
  async open(): Promise<void> {
    this.calls.push({ kind: 'open' });
    this.opened = true;
  }
  private check(): void {
    if (!this.opened) throw new StuError('DISCONNECTED', 'Mock is disconnected');
  }
  async readReport(id: number): Promise<Uint8Array> {
    this.check();
    this.calls.push({ kind: 'read', id });
    await this.options.beforeRead?.(id);
    this.check();
    const report = this.reports.get(id);
    if (!report)
      throw new StuError('UNSUPPORTED_FEATURE', 'Mock report is undefined', { reportId: id });
    return report.slice();
  }
  async writeReport(id: number, payload: Uint8Array): Promise<void> {
    this.check();
    this.calls.push({ kind: 'write', id, payload: payload.slice() });
    await this.options.beforeWrite?.(id, payload);
    this.check();
    if (this.options.simulateRom) {
      const slotKey = (mode: number, number: number): string => `${mode}:${number}`;
      if (id === ReportId.RomImageHash) {
        const response = new Uint8Array(19);
        response.set(payload.subarray(0, 2));
        const hash = this.romImages.get(slotKey(payload[0]!, payload[1]!));
        response[2] = hash ? 0 : 1;
        if (hash) response.set(hash, 3);
        this.reports.set(id, response);
        return;
      }
      if (id === ReportId.RomImageDisplay) {
        this.reports.set(
          ReportId.Status,
          Uint8Array.of(0, this.romImages.has(slotKey(payload[0]!, payload[1]!)) ? 0 : 0x15, 0, 0),
        );
        return;
      }
      if (id === ReportId.RomImageDelete) {
        const mode = payload[0]!;
        if (mode >= 6) this.romImages.delete(slotKey(mode - 5, payload[1]!));
        else
          for (const key of this.romImages.keys()) {
            if (mode === 0 || key.startsWith(`${mode}:`)) this.romImages.delete(key);
          }
        this.reports.set(ReportId.Status, new Uint8Array(4));
        return;
      }
      if (id === ReportId.RomStartImageData)
        this.romUpload = { slot: slotKey(payload[1]!, payload[2]!) };
      if (id === ReportId.EndImageData && this.romUpload) {
        if (payload[0] === 0) {
          const hash = new Uint8Array(16);
          new DataView(hash.buffer).setUint32(12, ++this.romRevision);
          this.romImages.set(this.romUpload.slot, hash);
        }
        this.romUpload = undefined;
      }
    }
    if (
      id === ReportId.StartImageData ||
      id === ReportId.StartImageDataArea ||
      id === ReportId.RomStartImageData
    )
      this.reports.set(ReportId.Status, Uint8Array.of(1, 0, 0, 0));
    else if (id === ReportId.EndImageData || id === ReportId.EndCapture)
      this.reports.set(ReportId.Status, new Uint8Array(4));
    else if (id === ReportId.StartCapture)
      this.reports.set(ReportId.Status, Uint8Array.of(2, 0, 0, 0));
    else if (id !== ReportId.ImageDataBlock) {
      const data = new Uint8Array(this.limits.featureReports.get(id) ?? payload.length);
      data.set(payload);
      this.reports.set(id, data);
    }
  }
  emit(reportId: number, payload: Uint8Array, receivedAt = 0): void {
    this.check();
    this.inputs.emit({ reportId, payload: payload.slice(), receivedAt });
  }
  disconnect(reason: unknown = new StuError('DISCONNECTED', 'Synthetic unplug')): void {
    this.opened = false;
    this.disconnects.emit(reason);
  }
  onInput(listener: (report: InputReport) => void): Unsubscribe {
    return this.inputs.on(listener);
  }
  onDisconnect(listener: (reason: unknown) => void): Unsubscribe {
    return this.disconnects.on(listener);
  }
  async close(): Promise<void> {
    this.calls.push({ kind: 'close' });
    this.opened = false;
    this.romUpload = undefined;
  }
}

export interface PenFixture {
  readonly x?: number;
  readonly y?: number;
  readonly pressure?: number;
  readonly touching?: boolean;
  readonly proximity?: boolean;
  readonly time?: number;
  readonly sequence?: number;
}
export function penFixture(options: PenFixture = {}): { reportId: number; payload: Uint8Array } {
  const timed = options.time !== undefined || options.sequence !== undefined;
  const payload = new Uint8Array(timed ? 10 : 6),
    d = new DataView(payload.buffer);
  d.setUint16(
    0,
    (options.proximity === false ? 0 : 0x8000) |
      (options.touching === false ? 0 : 0x1000) |
      integer(options.pressure ?? 512, 0, 4095, 'pressure'),
  );
  d.setUint16(2, integer(options.x ?? 4000, 0, 65535, 'x'));
  d.setUint16(4, integer(options.y ?? 2400, 0, 65535, 'y'));
  if (timed) {
    d.setUint16(6, options.time ?? 0);
    d.setUint16(8, options.sequence ?? 0);
  }
  return { reportId: timed ? ReportId.PenDataTimeCountSequence : ReportId.PenData, payload };
}

export interface ReplayStep {
  readonly kind: 'read' | 'write';
  readonly id: number;
  readonly payload: Uint8Array;
}
export class ReplayTransport extends MockTransport {
  private offset = 0;
  constructor(
    private readonly steps: readonly ReplayStep[],
    options: MockOptions = {},
  ) {
    super(options);
  }
  private next(kind: ReplayStep['kind'], id: number): ReplayStep {
    const step = this.steps[this.offset++];
    if (!step || step.kind !== kind || step.id !== id)
      throw new StuError('INVALID_STATE', `Replay diverged at operation ${this.offset - 1}`);
    return step;
  }
  override async readReport(id: number): Promise<Uint8Array> {
    return this.next('read', id).payload.slice();
  }
  override async writeReport(id: number, payload: Uint8Array): Promise<void> {
    const expected = this.next('write', id).payload;
    if (expected.length !== payload.length || !expected.every((value, i) => payload[i] === value))
      throw new StuError('INVALID_STATE', 'Replay write bytes differ');
  }
  assertComplete(): void {
    if (this.offset !== this.steps.length)
      throw new StuError('INVALID_STATE', 'Replay has unconsumed operations');
  }
}
