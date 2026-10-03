import { MockTransport } from '../../src/testing/index.js';
import { encodeSerialFrame, SerialFrameParser } from '../../src/protocol/serial.js';
import type {
  SerialApi,
  SerialConnectionEvent,
  SerialPort,
} from '../../src/transports/webserial.js';

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** Real browser-style streams around a synthetic STU. Not a hardware oracle. */
export class FakeSerialPort implements SerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array<ArrayBuffer>> | null = null;
  input!: ReadableStreamDefaultController<Uint8Array>;
  readonly requests: Uint8Array[] = [];
  readonly sizes = new Uint8Array(512);
  readonly mock = new MockTransport({ simulateRom: true });
  readonly openOptions: Parameters<SerialPort['open']>[0][] = [];
  readonly signals: Parameters<SerialPort['setSignals']>[0][] = [];
  closed = 0;
  forgotten = 0;
  onRequest: ((report: Uint8Array) => boolean | Promise<boolean>) | undefined;
  openDelay: Promise<void> | undefined;
  constructor() {
    this.sizes[0] = 0xff;
    const data = new DataView(this.sizes.buffer);
    for (const [id, size] of [...this.mock.limits.featureReports, ...this.mock.limits.inputReports])
      data.setUint16(id * 2, size + 1, false);
    data.setUint16(0x80 * 2, 2, false);
    data.setUint16(0x81 * 2, 2, false);
    data.setUint16(0xff * 2, 512, false);
  }
  getInfo(): { usbVendorId: number; usbProductId: number } {
    return { usbVendorId: 0x0403, usbProductId: 0x6001 };
  }
  async open(options: Parameters<SerialPort['open']>[0]): Promise<void> {
    this.openOptions.push(options);
    await this.openDelay;
    await this.mock.open();
    this.readable = new ReadableStream({
      start: (controller) => {
        this.input = controller;
      },
    });
    this.writable = new WritableStream({
      write: async (frame) => {
        const report = new SerialFrameParser().feed(frame)[0]!;
        this.requests.push(report);
        if (await this.onRequest?.(report)) return;
        if (report[0] === 0x80) {
          const id = report[1]!;
          if (id === 0xff) this.send(this.sizes);
          else this.send(Uint8Array.of(id, ...(await this.mock.readReport(id))));
        } else {
          await this.mock.writeReport(report[0]!, report.subarray(1));
          this.ack();
        }
      },
    });
  }
  ack(status = 0): void {
    // Success is the independent unchecked ACK observed from the native converter.
    if (!status) this.input.enqueue(Uint8Array.of(0x80, 3, 0x40, 0x40, 0));
    else this.send(Uint8Array.of(0x81, status));
  }
  send(report: Uint8Array, split = 0): void {
    const frame = encodeSerialFrame(report);
    if (split) {
      this.input.enqueue(frame.slice(0, split));
      this.input.enqueue(frame.slice(split));
    } else this.input.enqueue(frame);
  }
  async setSignals(signals: Parameters<SerialPort['setSignals']>[0]): Promise<void> {
    this.signals.push(signals);
  }
  async close(): Promise<void> {
    if (this.readable?.locked || this.writable?.locked) throw new Error('Streams still locked');
    this.readable = this.writable = null;
    this.closed++;
    await this.mock.close();
  }
  async forget(): Promise<void> {
    this.forgotten++;
  }
}

export class FakeSerialApi implements SerialApi {
  readonly listeners = {
    connect: new Set<(event: SerialConnectionEvent) => void>(),
    disconnect: new Set<(event: SerialConnectionEvent) => void>(),
  };
  constructor(readonly ports: SerialPort[]) {}
  async getPorts(): Promise<SerialPort[]> {
    return this.ports;
  }
  async requestPort(): Promise<SerialPort> {
    return this.ports[0]!;
  }
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: SerialConnectionEvent) => void,
  ): void {
    this.listeners[type].add(listener);
  }
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: SerialConnectionEvent) => void,
  ): void {
    this.listeners[type].delete(listener);
  }
  emit(type: 'connect' | 'disconnect', port: SerialPort): void {
    for (const listener of this.listeners[type]) listener({ target: port });
  }
}
