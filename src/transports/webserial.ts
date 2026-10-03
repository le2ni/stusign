import { StuError, asStuError, integer } from '../errors.js';
import { Emitter } from '../events.js';
import { getReportDefinition, ReportId } from '../protocol/catalogue.js';
import { decodeInformation } from '../protocol/codecs.js';
import type { DeviceInformation } from '../protocol/codecs.js';
import {
  decodeSerialReportSizes,
  encodeSerialFrame,
  SerialFrameParser,
} from '../protocol/serial.js';
import { getModelProfile } from '../profiles/index.js';
import type { InputReport, ReportTransport, TransportLimits, Unsubscribe } from '../types.js';

// Structural browser interfaces keep the published declarations independent of lib.dom.
export interface SerialReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
export interface SerialWriter {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  abort(): Promise<void>;
  releaseLock(): void;
}
export interface SerialPortInfo {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
}
export interface SerialPort {
  readonly readable: { getReader(): SerialReader } | null;
  readonly writable: { getWriter(): SerialWriter } | null;
  getInfo(): SerialPortInfo;
  open(options: {
    baudRate: number;
    dataBits: 8;
    stopBits: 1;
    parity: 'none';
    flowControl: 'none';
    bufferSize: number;
  }): Promise<void>;
  setSignals(signals: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
}
export interface SerialConnectionEvent {
  readonly target: unknown;
  /** Older Chromium exposed port instead of using the event target. */
  readonly port?: SerialPort;
}
export interface SerialPortFilter {
  readonly usbVendorId: number;
  readonly usbProductId?: number;
}
export interface SerialApi {
  getPorts(): Promise<SerialPort[]>;
  requestPort(options?: { filters: SerialPortFilter[] }): Promise<SerialPort>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: SerialConnectionEvent) => void,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: SerialConnectionEvent) => void,
  ): void;
}
export interface WebSerialOptions {
  readonly serial?: SerialApi;
  /** USB virtual COM: 128000 (default). Physical Wacom RS-232 kit: 115200. */
  readonly baudRate?: number;
  /** One command exchange, including writing. A timeout faults this connection. Default 5000. */
  readonly responseTimeoutMs?: number;
}
export interface WebSerialManagerOptions extends WebSerialOptions {
  /** No default vendor filter: FTDI and physical COM adapters need not identify as Wacom. */
  readonly filters?: readonly SerialPortFilter[];
}
interface Pending {
  readonly expectedId: number;
  readonly commandId: number;
  readonly length: number;
  readonly timer: ReturnType<typeof setTimeout>;
  replied: boolean;
  reply(result: { report: Uint8Array } | { error: StuError }): void;
  abort(error: StuError): void;
}
const owners = new WeakMap<SerialPort, WebSerialTransport>();

export class WebSerialTransport implements ReportTransport {
  readonly kind = 'webserial';
  readonly baudRate: number;
  readonly responseTimeoutMs: number;
  private phase: 'closed' | 'opening' | 'open' | 'faulted' = 'closed';
  private generation = 0;
  private opening = false;
  private ownsPort = false;
  private closing: Promise<void> | undefined;
  private reader: SerialReader | undefined;
  private writer: SerialWriter | undefined;
  private readTask: Promise<void> | undefined;
  private pending: Pending | undefined;
  private tail: Promise<void> = Promise.resolve();
  private sizes: ReadonlyMap<number, number> = new Map();
  private descriptors: TransportLimits = { featureReports: new Map(), inputReports: new Map() };
  private information: DeviceInformation | undefined;
  private readonly inputs = new Emitter<InputReport>();
  private readonly disconnects = new Emitter<unknown>();
  private readonly disconnectListener = (event: SerialConnectionEvent): void => {
    if ((event.port ?? event.target) === this.port)
      this.fail(new StuError('DISCONNECTED', 'Serial tablet unplugged'));
  };

  constructor(
    readonly port: SerialPort,
    private readonly options: WebSerialOptions = {},
  ) {
    this.baudRate = integer(options.baudRate ?? 128000, 1, 4_000_000, 'baudRate');
    this.responseTimeoutMs = integer(
      options.responseTimeoutMs ?? 5000,
      1,
      2_147_483_647,
      'responseTimeoutMs',
    );
  }
  get limits(): TransportLimits {
    return this.descriptors;
  }
  /** Complete device-reported sizes INCLUDING IDs. Empty until discovery succeeds. */
  get reportSizes(): ReadonlyMap<number, number> {
    return this.sizes;
  }
  get identity(): DeviceInformation | undefined {
    return this.information;
  }

  async open(): Promise<void> {
    if (this.phase === 'open') return;
    const hasStreams = Boolean(this.port.readable || this.port.writable);
    if (this.opening || this.closing || owners.has(this.port) || hasStreams)
      throw new StuError('DEVICE_BUSY', 'Serial port is already open, opening or closing');
    this.opening = true;
    this.phase = 'opening';
    this.information = undefined;
    this.sizes = new Map();
    this.descriptors = { featureReports: new Map(), inputReports: new Map() };
    const generation = ++this.generation;
    owners.set(this.port, this);
    this.options.serial?.addEventListener('disconnect', this.disconnectListener);
    try {
      await this.port.open({
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 16384,
      });
      this.ownsPort = true;
      this.assertGeneration(generation);
      // Matches the verified macOS helper: DTR low, RTS high, no CTS flow control.
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
      this.assertGeneration(generation);
      if (!this.port.readable || !this.port.writable)
        throw new StuError('TRANSPORT', 'Serial port did not provide readable/writable streams');
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.readTask = this.readLoop(this.reader, generation);
      const identity = decodeInformation(
        (
          await this.exchange(
            Uint8Array.of(ReportId.GetReport, ReportId.Information),
            ReportId.Information,
            17,
          )
        ).subarray(1),
      );
      const profile = getModelProfile(identity.modelName);
      if (!profile || profile.encryption === 'tls')
        throw new StuError(
          'UNSUPPORTED_FEATURE',
          'Selected port did not identify a supported STU tablet',
        );
      const collection = await this.exchange(
        Uint8Array.of(ReportId.GetReport, ReportId.ReportSizeCollection),
        ReportId.ReportSizeCollection,
        512,
      );
      const sizes = decodeSerialReportSizes(collection);
      const featureReports = new Map<number, number>(),
        inputReports = new Map<number, number>();
      for (const [id, length] of sizes) {
        const definition = getReportDefinition(id);
        // The serial envelope is internal; exposing GetReport would break reply correlation.
        if (id === ReportId.GetReport || id === ReportId.SetResult) continue;
        if (definition?.read || definition?.write) featureReports.set(id, length - 1);
        if (definition?.input) inputReports.set(id, length - 1);
      }
      this.assertGeneration(generation);
      this.information = identity;
      this.sizes = sizes;
      this.descriptors = { featureReports, inputReports };
      this.phase = 'open';
    } catch (cause) {
      await this.close().catch(() => {});
      if (cause instanceof StuError) throw cause;
      throw new StuError(
        cause instanceof Error && cause.name === 'SecurityError'
          ? 'PERMISSION_DENIED'
          : 'TRANSPORT',
        'Unable to open the serial tablet',
        { cause },
      );
    } finally {
      this.opening = false;
      if (!this.ownsPort && owners.get(this.port) === this) owners.delete(this.port);
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation || (this.phase !== 'open' && this.phase !== 'opening'))
      throw new StuError('DISCONNECTED', 'Serial operation belongs to a closed connection');
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (this.phase !== 'open')
      return Promise.reject(new StuError('DISCONNECTED', 'Serial interface is closed'));
    const task = this.tail.then(() => {
      this.assertGeneration(generation);
      return operation();
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private length(id: number, direction: 'read' | 'write'): number {
    integer(id, 1, 255, 'report ID');
    const length = this.descriptors.featureReports.get(id);
    if (length === undefined || !getReportDefinition(id)?.[direction])
      throw new StuError('UNSUPPORTED_FEATURE', 'Serial report is unavailable in this direction', {
        reportId: id,
      });
    return length;
  }
  readReport(id: number): Promise<Uint8Array> {
    return this.enqueue(async () => {
      const size = this.length(id, 'read') + 1;
      return (await this.exchange(Uint8Array.of(ReportId.GetReport, id), id, size)).slice(1);
    });
  }
  writeReport(id: number, payload: Uint8Array): Promise<void> {
    const snapshot = new Uint8Array(payload);
    return this.enqueue(async () => {
      const length = this.length(id, 'write');
      if (snapshot.length > length)
        throw new StuError('INVALID_ARGUMENT', 'Payload exceeds serial report length', {
          reportId: id,
        });
      const report = new Uint8Array(length + 1);
      report[0] = id;
      report.set(snapshot, 1);
      await this.exchange(report, ReportId.SetResult, 2);
    });
  }

  private exchange(report: Uint8Array, expectedId: number, length: number): Promise<Uint8Array> {
    if (this.pending || !this.writer)
      return Promise.reject(new StuError('INVALID_STATE', 'Serial command lane is unavailable'));
    const commandId = report[0] === ReportId.GetReport ? report[1]! : report[0]!;
    const frame = encodeSerialFrame(report);
    const generation = this.generation,
      writer = this.writer;
    let reply!: Pending['reply'], abort!: Pending['abort'];
    const response = new Promise<{ report: Uint8Array } | { error: StuError }>((resolve) => {
      reply = resolve;
    });
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = reject;
    });
    const pending: Pending = {
      expectedId,
      commandId,
      length,
      replied: false,
      reply,
      abort,
      // Keep timing the entire exchange even if a reply precedes write completion.
      timer: setTimeout(() => {
        if (this.pending === pending && generation === this.generation)
          this.fail(
            new StuError(
              'TIMEOUT',
              'Serial command timed out; close and reopen before sending another command',
              { reportId: commandId },
            ),
          );
      }, this.responseTimeoutMs),
    };
    this.pending = pending;
    // Capture the writer and install the waiter before sending. A rejected command
    // still occupies the lane until its write settles; untagged ACKs cannot overlap.
    const writing = Promise.resolve().then(() => {
      this.assertGeneration(generation);
      return writer.write(frame);
    });
    const completed = Promise.all([writing, response]).then(([, result]) => {
      if ('error' in result) throw result.error;
      return result.report;
    });
    return Promise.race([completed, interrupted])
      .catch((cause: unknown) => {
        const error = asStuError(cause, 'serial exchange');
        if (error.code !== 'DEVICE_STATUS' && generation === this.generation) this.fail(error);
        throw error;
      })
      .finally(() => {
        clearTimeout(pending.timer);
        if (this.pending === pending) this.pending = undefined;
      });
  }

  private accept(report: Uint8Array): void {
    const id = report[0]!,
      pending = this.pending;
    if (id === ReportId.SetResult) {
      if (
        !pending ||
        pending.replied ||
        report.length !== 2 ||
        (pending.expectedId !== id && report[1] === 0)
      )
        throw new StuError('MALFORMED_REPORT', 'Unexpected serial acknowledgement');
      pending.replied = true;
      if (report[1] !== 0)
        pending.reply({
          error: new StuError('DEVICE_STATUS', 'Tablet rejected the serial command', {
            reportId: pending.commandId,
            status: report[1]!,
          }),
        });
      else pending.reply({ report });
      return;
    }
    if (pending?.expectedId === id && !pending.replied) {
      if (report.length !== pending.length)
        throw new StuError('MALFORMED_REPORT', 'Serial reply length differs from its report size', {
          reportId: id,
        });
      pending.replied = true;
      pending.reply({ report });
      return;
    }
    if (this.phase !== 'open') return; // Ignore startup input until identity and sizes are known.
    const size = this.sizes.get(id);
    if (size !== undefined && report.length !== size)
      throw new StuError('MALFORMED_REPORT', 'Serial input length differs from its report size', {
        reportId: id,
      });
    const definition = getReportDefinition(id);
    if (definition && !definition.input)
      throw new StuError('MALFORMED_REPORT', 'Unexpected serial command reply', { reportId: id });
    this.inputs.emit({ reportId: id, payload: report.slice(1), receivedAt: performance.now() });
  }
  private async readLoop(reader: SerialReader, generation: number): Promise<void> {
    const parser = new SerialFrameParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== this.generation) return;
        if (done) throw new StuError('DISCONNECTED', 'Serial input stream ended');
        if (value)
          for (const report of parser.feed(value)) {
            this.assertGeneration(generation);
            this.accept(report);
          }
      }
    } catch (cause) {
      if (generation === this.generation) this.fail(asStuError(cause, 'read serial stream'));
    } finally {
      parser.reset();
    }
  }
  private rejectPending(error: StuError): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.abort(error);
    }
  }
  private fail(error: StuError): void {
    if (this.phase !== 'open' && this.phase !== 'opening') return;
    this.phase = 'faulted';
    this.generation++;
    this.rejectPending(error);
    this.disconnects.emit(error);
    void this.close().catch(() => {});
  }
  onInput(listener: (report: InputReport) => void): Unsubscribe {
    return this.inputs.on(listener);
  }
  onDisconnect(listener: (reason: unknown) => void): Unsubscribe {
    return this.disconnects.on(listener);
  }

  close(): Promise<void> {
    this.generation++;
    this.phase = 'closed';
    this.rejectPending(new StuError('DISCONNECTED', 'Serial interface closed'));
    this.options.serial?.removeEventListener('disconnect', this.disconnectListener);
    if (this.closing) return this.closing;
    // A pending platform open owns its handle until it settles; open() closes a late success.
    if (!this.ownsPort) return Promise.resolve();
    const reader = this.reader,
      writer = this.writer,
      readTask = this.readTask;
    this.closing = Promise.resolve()
      .then(async () => {
        await Promise.allSettled([reader?.cancel(), writer?.abort()]);
        await readTask;
        reader?.releaseLock();
        writer?.releaseLock();
        this.reader = this.writer = this.readTask = undefined;
        await this.port.close();
        this.ownsPort = false;
        if (owners.get(this.port) === this) owners.delete(this.port);
      })
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
  async forget(): Promise<void> {
    await this.close();
    if (!this.port.forget)
      throw new StuError('UNSUPPORTED_FEATURE', 'Serial permission revocation is unavailable');
    await this.port.forget();
  }
}

export interface WebSerialManager {
  /** Invoke from a click/tap. Selection grants access; identity is checked by open(). */
  requestDevice(): Promise<WebSerialTransport | null>;
  /** Lists only previously granted ports, without opening or probing them. */
  getAuthorizedDevices(): Promise<readonly WebSerialTransport[]>;
  onConnection(listener: (event: { connected: boolean; port: SerialPort }) => void): Unsubscribe;
}
export function createWebSerialManager(options: WebSerialManagerOptions = {}): WebSerialManager {
  const serial =
    options.serial ?? (globalThis as { navigator?: { serial?: SerialApi } }).navigator?.serial;
  if (!serial)
    throw new StuError(
      'UNSUPPORTED_BROWSER',
      'Web Serial is unavailable; use a supported browser on HTTPS or localhost',
    );
  const filters = options.filters?.map((filter) => ({ ...filter }));
  for (const filter of filters ?? []) {
    integer(filter.usbVendorId, 0, 65535, 'usbVendorId');
    if (filter.usbProductId !== undefined) integer(filter.usbProductId, 0, 65535, 'usbProductId');
  }
  const supported = (port: SerialPort): boolean =>
    !filters?.length ||
    filters.some((filter) => {
      const info = port.getInfo();
      return (
        info.usbVendorId === filter.usbVendorId &&
        (filter.usbProductId === undefined || info.usbProductId === filter.usbProductId)
      );
    });
  const wrap = (port: SerialPort): WebSerialTransport =>
    new WebSerialTransport(port, { ...options, serial });
  return {
    async requestDevice() {
      try {
        return wrap(await serial.requestPort(filters?.length ? { filters } : undefined));
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'NotFoundError') return null;
        if (cause instanceof StuError) throw cause;
        throw new StuError('PERMISSION_DENIED', 'Serial port selection failed', { cause });
      }
    },
    async getAuthorizedDevices() {
      return (await serial.getPorts()).filter(supported).map(wrap);
    },
    onConnection(listener) {
      const notify = (event: SerialConnectionEvent, connected: boolean): void => {
        const port = (event.port ?? event.target) as SerialPort | null;
        if (port && typeof port.getInfo === 'function' && supported(port))
          listener({ connected, port });
      };
      const connect = (event: SerialConnectionEvent): void => notify(event, true);
      const disconnect = (event: SerialConnectionEvent): void => notify(event, false);
      serial.addEventListener('connect', connect);
      serial.addEventListener('disconnect', disconnect);
      return () => {
        serial.removeEventListener('connect', connect);
        serial.removeEventListener('disconnect', disconnect);
      };
    },
  };
}
