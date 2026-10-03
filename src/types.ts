export type Unsubscribe = () => void;

/** Structural so the core's declarations can be consumed without lib.dom. */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface OperationOptions {
  readonly signal?: CancellationSignal;
  /** Includes time waiting in the command queue. */
  readonly timeoutMs?: number;
}

export interface InputReport {
  readonly reportId: number;
  /** Report ID and transport framing are excluded. */
  readonly payload: Uint8Array;
  readonly receivedAt: number;
}

export interface TransportLimits {
  /** Payload byte lengths; excludes report ID. No guessed descriptor sizes. */
  readonly featureReports: ReadonlyMap<number, number>;
  readonly inputReports: ReadonlyMap<number, number>;
}

export interface ReportTransport {
  readonly kind: string;
  readonly limits: TransportLimits;
  open(): Promise<void>;
  readReport(id: number): Promise<Uint8Array>;
  writeReport(id: number, payload: Uint8Array): Promise<void>;
  onInput(listener: (report: InputReport) => void): Unsubscribe;
  onDisconnect(listener: (reason: unknown) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  /** Pixel extents, rather than lower-right coordinates. */
  readonly width: number;
  readonly height: number;
}

export type Protection =
  | { readonly kind: 'plaintext' }
  | { readonly kind: 'rsa-aes'; readonly sessionId: number; readonly keyBits: 128 | 192 | 256 }
  | { readonly kind: 'dh-aes'; readonly sessionId: number; readonly keyBits: 128 }
  | { readonly kind: 'tls'; readonly peerVerified: true };

export interface PenSample {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
  readonly pressureNormalized: number;
  readonly inProximity: boolean;
  readonly touching: boolean;
  readonly switches: number;
  readonly receivedAt: number;
  readonly deviceTime?: number;
  readonly sequence?: number;
  /** Uninterpreted 0x30 option; interpretation depends on the requested mode. */
  readonly option?: number;
  readonly reportId: number;
  readonly sessionEpoch: number;
  readonly encrypted: boolean;
}

export type Support =
  | { readonly state: 'supported'; readonly evidence: 'descriptor' | 'profile' }
  | { readonly state: 'unsupported'; readonly reason: string }
  | { readonly state: 'unknown'; readonly reason: string };

export type DeviceEvent =
  | { readonly type: 'pen'; readonly sample: PenSample }
  | { readonly type: 'signature'; readonly key: number; readonly encrypted: boolean }
  | {
      readonly type: 'keypad';
      readonly screen: number;
      readonly key: number;
      readonly encrypted: boolean;
    }
  | {
      readonly type: 'pinpad';
      readonly key: number;
      readonly value: string;
      readonly encrypted: boolean;
    }
  | { readonly type: 'unknown-report'; readonly reportId: number; readonly byteLength: number }
  | { readonly type: 'error'; readonly error: Error }
  | { readonly type: 'disconnect'; readonly reason: unknown };
