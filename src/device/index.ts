import { StuError, asStuError, integer } from '../errors.js';
import { Emitter } from '../events.js';
import type {
  DeviceEvent,
  InputReport,
  OperationOptions,
  PenSample,
  Protection,
  ReportTransport,
  Support,
  Unsubscribe,
} from '../types.js';
import { Scheduler } from './scheduler.js';
import type { Transaction } from './scheduler.js';
import { ReportId, getReportDefinition } from '../protocol/catalogue.js';
import {
  decodeCapability,
  decodeEncryptedPen,
  decodeInformation,
  decodePen,
  decodeStatus,
  uid,
} from '../protocol/codecs.js';
import type { Capability, Codec, DeviceInformation, DeviceStatus } from '../protocol/codecs.js';
import { decodeEvent, decodeOperationMode, encodeOperationMode } from '../protocol/modes.js';
import type { OperationMode } from '../protocol/modes.js';
import { concat, view } from '../protocol/binary.js';
import { rgbTo565 } from '../protocol/images.js';
import type { CryptoProvider, EncryptionSession } from '../crypto/contracts.js';
import { Settings } from './settings.js';
import { Display } from './display.js';
import { Rom } from './rom.js';
import { snapshotStartupImage } from './startup.js';
import type { StartupImage } from './startup.js';
import { Recording } from './recording.js';
import type { CaptureOptions, CaptureOwner } from './recording.js';
import type { CaptureMetadata } from '../capture/index.js';
import type { DeviceContext } from './context.js';
import { createEventStream } from './stream.js';
import type { EventStreamOptions } from './stream.js';

export interface StuDeviceOptions extends OperationOptions {
  readonly cryptoProvider?: CryptoProvider;
  /** Require a continuously ready status before initialization. Default: 500 ms. */
  readonly readyStabilityMs?: number;
  /** Reapply the volatile clear-screen RGB color on open; clear only without startupImage. */
  readonly startupBackground?: number;
  /** Show an uploaded or stored image before open() resolves. No ROM writes on open. */
  readonly startupImage?: StartupImage;
}
export interface ProtocolAccess {
  read<T>(codec: Codec<T>, options?: OperationOptions): Promise<T>;
  write<T>(codec: Codec<T>, value: T, options?: OperationOptions): Promise<void>;
  readRaw(id: number, options?: OperationOptions): Promise<Uint8Array>;
  writeRaw(id: number, payload: Uint8Array, options?: OperationOptions): Promise<void>;
}
export interface ModeService {
  get(options?: OperationOptions): Promise<OperationMode>;
  set(mode: OperationMode, options?: OperationOptions): Promise<void>;
}
export type DeviceState = 'opening' | 'open' | 'closing' | 'closed' | 'faulted';

let nextEpoch = 0;
const ownedTransports = new WeakSet<ReportTransport>();
export class StuDevice implements DeviceContext, CaptureOwner {
  readonly settings: Settings;
  readonly display: Display;
  readonly rom: Rom;
  readonly protocol: ProtocolAccess;
  readonly modes: ModeService;
  readonly capture: { create(options: CaptureOptions): Recording };
  readonly sessionEpoch = ++nextEpoch;
  private readonly scheduler = new Scheduler();
  private readonly errors = new Emitter<Error>();
  private readonly events = new Emitter<DeviceEvent>((error) =>
    this.errors.emit(asStuError(error, 'event listener')),
  );
  private readonly subscriptions: Unsubscribe[] = [];
  private phase: DeviceState = 'opening';
  private optionMode = 0;
  private recording: Recording | undefined;
  private collecting = false;
  private encryption: EncryptionSession | undefined;
  private captureStarted = false;
  private encryptionTransition = false;
  private closing: Promise<void> | undefined;
  private disconnectNotified = false;
  private information: DeviceInformation | undefined;
  private capabilities: Capability | undefined;

  private constructor(
    readonly transport: ReportTransport,
    private readonly options: StuDeviceOptions,
  ) {
    const {
      startupImage: _startupImage,
      startupBackground: _startupBackground,
      readyStabilityMs: _readyStabilityMs,
      ...sessionOptions
    } = options;
    this.options = Object.freeze(sessionOptions);
    this.settings = new Settings(this);
    this.display = new Display(this);
    this.rom = new Rom(this);
    this.capture = { create: (options) => new Recording(this, options) };
    this.protocol = {
      read: (codec, options) =>
        this.run(
          'read protocol report',
          async (tx) => codec.decode(await this.read(tx, codec.id)),
          options,
        ),
      write: (codec, value, options) => {
        const payload = codec.encode(value);
        return this.run(
          'write protocol report',
          async (tx) => {
            await this.write(tx, codec.id, payload);
          },
          options,
        );
      },
      readRaw: (id, options) => this.run('read raw report', (tx) => this.read(tx, id), options),
      writeRaw: (id, data, options) => {
        const snapshot = new Uint8Array(data);
        return this.run('write raw report', (tx) => this.write(tx, id, snapshot), options);
      },
    };
    this.modes = {
      get: (options) =>
        this.run(
          'read operating mode',
          async (tx) => decodeOperationMode(await this.read(tx, ReportId.OperationMode)),
          options,
        ),
      set: (mode, options) => {
        const payload = encodeOperationMode(mode);
        return this.run(
          'set operating mode',
          async (tx) => {
            await this.waitStatus(tx, [0]);
            await this.write(tx, ReportId.OperationMode, payload);
            await this.waitStatus(tx, [0], true);
          },
          options,
        );
      },
    };
  }

  static async open(
    transport: ReportTransport,
    options: StuDeviceOptions = {},
  ): Promise<StuDevice> {
    if (ownedTransports.has(transport))
      throw new StuError('DEVICE_BUSY', 'This transport already belongs to a device connection');
    const startup = snapshotStartupImage(options.startupImage);
    const background = options.startupBackground;
    if (background !== undefined) integer(background, 0, 0xffffff, 'startupBackground');
    const stableMs = integer(options.readyStabilityMs ?? 500, 0, 30_000, 'readyStabilityMs');
    const device = new StuDevice(transport, options);
    ownedTransports.add(transport);
    try {
      device.subscriptions.push(transport.onInput((report) => device.handleInput(report)));
      device.subscriptions.push(transport.onDisconnect((reason) => device.disconnected(reason)));
      await device.scheduler.run(
        'open device',
        async (tx) => {
          for (;;) {
            try {
              await tx.io(() => transport.open());
              break;
            } catch (error) {
              tx.check();
              if (!(error instanceof StuError) || error.code !== 'TRANSPORT') throw error;
              await tx.pause(100);
            }
          }
          await device.initialize(tx, stableMs);
          device.phase = 'open';
        },
        { timeoutMs: 30_000, ...options },
      );
      if (background !== undefined) {
        await device.settings.setBackground(background, options);
        const actual = await device.settings.getBackground(options);
        if (actual.color !== (actual.format === 'rgb24' ? background : rgbTo565(background)))
          throw new StuError('DEVICE_STATUS', 'Startup background did not match on readback');
        if (!startup) await device.display.clear(undefined, options);
      }
      if (startup?.source === 'upload') {
        await device.display.writeImage(startup.image, {
          format: startup.format ?? 'auto',
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } else if (startup?.source === 'stored') {
        await device.rom.display(startup.slot, {
          ...(startup.expectedHash ? { expectedHash: startup.expectedHash } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      }
      return device;
    } catch (error) {
      await device.close().catch(() => {});
      throw error;
    }
  }

  /** USB enumeration can precede firmware readiness; do not write during that interval. */
  private async initialize(tx: Transaction, stableMs: number): Promise<void> {
    let readySince: number | undefined;
    for (;;) {
      try {
        const status = await this.status(tx);
        if (status.status === 0 || status.status === 2) {
          readySince ??= performance.now();
          if (performance.now() - readySince >= stableMs) {
            const information = decodeInformation(await this.read(tx, ReportId.Information));
            if (!/^STU-/.test(information.modelName) || information.modelName === 'STU-541')
              throw new StuError('UNSUPPORTED_FEATURE', 'Device requires a different STU backend');
            const capability = decodeCapability(await this.read(tx, ReportId.Capability));
            // A reset/boot transition between metadata reads invalidates this snapshot.
            if ((await this.status(tx)).status === status.status) {
              this.information = information;
              this.capabilities = capability;
              return;
            }
            readySince = undefined;
          }
        } else if ([3, 4, 5, 0xff].includes(status.status)) {
          // Calculation, boot image, ROM access and system reset are transient at startup.
          readySince = undefined;
        } else {
          throw new StuError('INVALID_STATE', 'Tablet is not available for initialization', {
            status: status.status,
          });
        }
      } catch (error) {
        tx.check();
        // Retry only transport reads during startup, never permissions, invalid data or writes.
        if (!(error instanceof StuError) || error.code !== 'TRANSPORT') throw error;
        readySince = undefined;
      }
      await tx.pause(100);
    }
  }

  get identity(): DeviceInformation {
    if (!this.information) throw new StuError('INVALID_STATE', 'Identity is not initialized');
    return this.information;
  }
  get capability(): Capability {
    if (!this.capabilities) throw new StuError('INVALID_STATE', 'Capabilities are not initialized');
    return this.capabilities;
  }
  get state(): DeviceState {
    return this.phase;
  }
  get protection(): Protection {
    return this.encryption?.protection ?? Object.freeze({ kind: 'plaintext' });
  }
  support(id: number): Support {
    if (!getReportDefinition(id))
      return { state: 'unknown', reason: 'Report is not in the public catalogue' };
    return this.transport.limits.featureReports.has(id) ||
      this.transport.limits.inputReports.has(id)
      ? { state: 'supported', evidence: 'descriptor' }
      : { state: 'unsupported', reason: 'Report is absent from this transport descriptor' };
  }
  on(listener: (event: DeviceEvent) => void): Unsubscribe {
    return this.events.on(listener);
  }
  onError(listener: (error: Error) => void): Unsubscribe {
    return this.errors.on(listener);
  }
  stream(options: EventStreamOptions = {}): AsyncIterableIterator<DeviceEvent> {
    if (this.phase !== 'open') throw new StuError('DISCONNECTED', 'Device is not open');
    return createEventStream((listener) => this.on(listener), options);
  }
  /** @internal */
  run<T>(
    name: string,
    work: (tx: Transaction) => Promise<T>,
    options?: OperationOptions,
  ): Promise<T> {
    if (this.phase !== 'open')
      return Promise.reject(new StuError('DISCONNECTED', 'Device is not open'));
    return this.scheduler.run(name, work, options);
  }
  /** @internal */
  requireReport(id: number): void {
    integer(id, 0, 255, 'report ID');
    if (!this.transport.limits.featureReports.has(id))
      throw new StuError('UNSUPPORTED_FEATURE', 'Report is absent from the device descriptor', {
        reportId: id,
      });
  }
  /** @internal */
  read(tx: Transaction, id: number): Promise<Uint8Array> {
    this.requireReport(id);
    if (!getReportDefinition(id)?.read)
      throw new StuError('INVALID_ARGUMENT', 'Report is not readable', { reportId: id });
    return tx.io(async () => new Uint8Array(await this.transport.readReport(id)));
  }
  /** @internal */
  write(tx: Transaction, id: number, payload: Uint8Array): Promise<void> {
    this.requireReport(id);
    if (!getReportDefinition(id)?.write)
      throw new StuError('INVALID_ARGUMENT', 'Report is not writable', { reportId: id });
    if (payload.length > this.transport.limits.featureReports.get(id)!)
      throw new StuError('INVALID_ARGUMENT', 'Payload exceeds the report descriptor', {
        reportId: id,
      });
    return tx.io(() => this.transport.writeReport(id, payload));
  }
  /** @internal */
  async status(tx: Transaction, checkResult = false): Promise<DeviceStatus> {
    const status = decodeStatus(await this.read(tx, ReportId.Status));
    if (checkResult && status.lastResult !== 0)
      throw new StuError('DEVICE_STATUS', 'Device rejected the command', {
        status: status.lastResult,
      });
    return status;
  }
  getStatus(options?: OperationOptions): Promise<DeviceStatus> {
    return this.run('read status', (tx) => this.status(tx), options);
  }
  /** @internal */
  async waitStatus(
    tx: Transaction,
    allowed: readonly number[],
    checkResult = false,
  ): Promise<DeviceStatus> {
    for (;;) {
      const status = await this.status(tx, checkResult);
      if (allowed.includes(status.status)) return status;
      if (![3, 4, 5].includes(status.status))
        throw new StuError('INVALID_STATE', 'Command is not allowed in the current device state', {
          status: status.status,
        });
      await tx.pause(25);
    }
  }
  /** @internal */
  setOptionMode(mode: number): void {
    this.optionMode = mode;
  }
  async reset(kind: 'software' | 'hardware', options?: OperationOptions): Promise<void> {
    if (kind !== 'software' && kind !== 'hardware')
      throw new StuError('INVALID_ARGUMENT', 'Invalid reset kind');
    await this.run(
      'reset device',
      async (tx) => {
        await this.write(tx, ReportId.Reset, Uint8Array.of(kind === 'hardware' ? 1 : 0));
      },
      options,
    );
    this.fault(new StuError('DISCONNECTED', 'Device reset; reopen to refresh state'));
  }

  /** @internal */
  async begin(recording: Recording, options: OperationOptions): Promise<CaptureMetadata> {
    if (this.recording) throw new StuError('INVALID_STATE', 'Another recording owns this device');
    this.recording = recording;
    try {
      return await this.run(
        'start capture',
        async (tx) => {
          await this.waitStatus(tx, [0]);
          if (recording.options.encryption === 'required') {
            const provider = this.options.cryptoProvider;
            if (!provider)
              throw new StuError('ENCRYPTION', 'Encrypted capture requires a crypto provider');
            this.requireReport(ReportId.StartCapture);
            this.requireReport(ReportId.EndCapture);
            const generation = this.transport.limits.featureReports.has(ReportId.EncryptionStatus)
              ? 'rsa-aes'
              : 'dh-aes';
            let session: EncryptionSession | undefined;
            try {
              session = await provider.negotiate(
                {
                  read: (id) => this.read(tx, id),
                  write: (id, data) => this.write(tx, id, data),
                  pause: (ms) => tx.pause(ms),
                },
                generation,
              );
              tx.check();
              this.encryption = session;
              this.encryptionTransition = true;
              this.collecting = true;
              this.captureStarted = true;
              await this.write(tx, ReportId.StartCapture, uid.encode(session.protection.sessionId));
              await this.waitStatus(tx, [2], true);
              this.encryptionTransition = false;
            } catch (error) {
              this.collecting = false;
              if (session) {
                try {
                  await this.transport.writeReport(ReportId.EndCapture, Uint8Array.of(0));
                  this.captureStarted = false;
                } catch (cleanup) {
                  this.fault(cleanup);
                }
                session.dispose();
                if (this.encryption === session) this.encryption = undefined;
              }
              throw error;
            }
          } else this.collecting = true;
          return {
            dimensions: {
              maxX: this.capability.tabletMaxX,
              maxY: this.capability.tabletMaxY,
              width: this.capability.screenWidth,
              height: this.capability.screenHeight,
            },
            protection: this.protection,
            identity: { model: this.identity.modelName },
          };
        },
        { timeoutMs: 30_000, ...options },
      );
    } catch (error) {
      if (this.recording === recording) {
        this.recording = undefined;
        this.collecting = false;
      }
      throw error;
    }
  }
  /** @internal */
  async end(recording: Recording, options: OperationOptions): Promise<void> {
    if (this.recording !== recording) return;
    try {
      if (this.phase === 'open')
        await this.run(
          'finish capture',
          async (tx) => {
            if (this.encryption) {
              this.encryptionTransition = true;
              await this.write(tx, ReportId.EndCapture, Uint8Array.of(0));
              await this.waitStatus(tx, [0], true);
              this.captureStarted = false;
            }
          },
          options,
        );
    } catch (error) {
      this.fault(error);
      throw error;
    } finally {
      this.collecting = false;
      this.recording = undefined;
      this.releaseEncryption();
    }
  }

  private emitSample(sample: PenSample): void {
    if (this.collecting && this.recording) this.recording.accept(sample);
    this.events.emit(Object.freeze({ type: 'pen', sample }));
  }
  private handleInput(report: InputReport): void {
    if (this.phase !== 'open' || !this.capabilities) return;
    try {
      const context = {
        pressureMax: this.capability.pressureMax,
        receivedAt: report.receivedAt,
        sessionEpoch: this.sessionEpoch,
        optionMode: this.optionMode,
      };
      if (
        report.reportId === ReportId.PenData ||
        report.reportId === ReportId.PenDataOption ||
        report.reportId === ReportId.PenDataTimeCountSequence
      ) {
        if (this.encryption) {
          if (this.encryptionTransition) return;
          throw new StuError('ENCRYPTION', 'Unexpected plaintext during encrypted capture');
        }
        this.emitSample(decodePen(report.reportId, report.payload, context));
      } else if (
        report.reportId === ReportId.PenDataEncrypted ||
        report.reportId === ReportId.PenDataEncryptedOption ||
        report.reportId === ReportId.PenDataTimeCountSequenceEncrypted
      ) {
        if (!this.encryption)
          throw new StuError(
            'ENCRYPTION',
            'Encrypted pen report arrived without a negotiated session',
          );
        view(report.payload, report.reportId === ReportId.PenDataEncryptedOption ? 20 : 16);
        const decoded = this.encryption.decrypt(report.payload.subarray(0, 16));
        const plaintext =
          report.payload.length === 20 ? concat(decoded, report.payload.subarray(16)) : decoded;
        try {
          decodeEncryptedPen(
            report.reportId,
            plaintext,
            this.encryption.protection.sessionId,
            context,
          ).forEach((sample) => this.emitSample(sample));
        } finally {
          plaintext.fill(0);
          decoded.fill(0);
        }
      } else if (report.reportId === ReportId.EventData) {
        if (!this.encryption) this.events.emit(decodeEvent(report.payload));
      } else if (report.reportId === ReportId.EventDataEncrypted) {
        if (!this.encryption)
          throw new StuError('ENCRYPTION', 'Encrypted UI event arrived without a session');
        const plaintext = this.encryption.decrypt(report.payload);
        try {
          const d = view(plaintext, 16);
          if (d.getUint32(1) !== this.encryption.protection.sessionId)
            throw new StuError('ENCRYPTION', 'UI event session mismatch');
          if (plaintext[0] !== plaintext[7])
            throw new StuError('MALFORMED_REPORT', 'Encrypted UI event layout is not recognized');
          this.events.emit(decodeEvent(plaintext.subarray(7), true));
        } finally {
          plaintext.fill(0);
        }
      } else
        this.events.emit({
          type: 'unknown-report',
          reportId: report.reportId,
          byteLength: report.payload.length,
        });
    } catch (error) {
      const failure = asStuError(error, 'decode input');
      // Invalid input makes the stream untrustworthy. Fail closed and release
      // session secrets immediately, even if the application never calls finish.
      this.fault(failure);
      this.errors.emit(failure);
      this.events.emit({ type: 'error', error: failure });
    }
  }
  private disconnected(reason: unknown): void {
    this.fault(reason);
  }
  private notifyDisconnect(reason: unknown): void {
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.events.emit({ type: 'disconnect', reason });
  }
  private releaseEncryption(): void {
    const session = this.encryption;
    this.encryption = undefined;
    try {
      session?.dispose();
    } catch (error) {
      this.errors.emit(asStuError(error, 'dispose encryption'));
    }
  }
  /** @internal */
  fault(error: unknown): void {
    if (this.phase === 'closed') return;
    if (this.phase !== 'closing') this.phase = 'faulted';
    this.collecting = false;
    const failure = asStuError(error, 'device');
    this.scheduler.stop(failure);
    this.recording?.fail(failure);
    this.releaseEncryption();
    this.notifyDisconnect(failure);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.collecting = false;
    const reason = new StuError('DISCONNECTED', 'Device closed');
    this.recording?.fail(reason);
    this.scheduler.stop(reason);
    // Assign the promise before calling listeners, which may themselves close.
    this.closing = Promise.resolve().then(async () => {
      try {
        this.notifyDisconnect(reason);
        this.subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
        this.releaseEncryption();
        // A stalled platform call cannot be aborted by JS. Only perform protocol
        // cleanup once it has settled; otherwise close the transport to tear it down.
        const idle = await settlesWithin(this.scheduler.idle(), 1000);
        if (idle && this.captureStarted) {
          await settlesWithin(
            this.transport.writeReport(ReportId.EndCapture, Uint8Array.of(0)),
            1000,
          ).catch(() => false);
          this.captureStarted = false;
        }
        if (!(await settlesWithin(this.transport.close(), 2000)))
          throw new StuError('TIMEOUT', 'Transport close did not settle');
        ownedTransports.delete(this.transport);
      } finally {
        this.phase = 'closed';
        this.recording = undefined;
        this.events.clear();
        this.errors.clear();
      }
    });
    return this.closing;
  }
  dispose(): Promise<void> {
    return this.close();
  }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
