import type { OperationOptions, ReportTransport } from '../types.js';
import type { Capability, DeviceInformation, DeviceStatus } from '../protocol/codecs.js';
import type { Transaction } from './scheduler.js';

export interface DeviceContext {
  readonly transport: ReportTransport;
  readonly identity: DeviceInformation;
  readonly capability: Capability;
  run<T>(
    name: string,
    work: (tx: Transaction) => Promise<T>,
    options?: OperationOptions,
  ): Promise<T>;
  read(tx: Transaction, id: number): Promise<Uint8Array>;
  write(tx: Transaction, id: number, payload: Uint8Array): Promise<void>;
  requireReport(id: number): void;
  status(tx: Transaction, checkResult?: boolean): Promise<DeviceStatus>;
  waitStatus(
    tx: Transaction,
    allowed: readonly number[],
    checkResult?: boolean,
  ): Promise<DeviceStatus>;
  fault(error: unknown): void;
  setOptionMode(mode: number): void;
}
