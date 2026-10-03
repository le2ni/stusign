import type { ReportTransport } from 'stusign';

export type ReconnectReason = 'page load' | 'USB connection' | 'option enabled';

interface ReconnectOptions {
  getAuthorizedDevices(): Promise<readonly ReportTransport[]>;
  isBusy(): boolean;
  isConnected(): boolean;
  open(device: ReportTransport, reason: ReconnectReason): Promise<void>;
  notice(message: string): void;
  error(error: unknown): void;
}

/** Event-driven reopening; each open owns its bounded readiness wait. No background retry loop. */
export class AutoReconnect {
  private enabled = false;
  private disposed = false;
  private running = false;
  private revision = 0;
  private pending: ReconnectReason | undefined;

  constructor(private readonly options: ReconnectOptions) {}

  setEnabled(enabled: boolean, reason: ReconnectReason = 'option enabled'): Promise<void> {
    this.cancelPending();
    this.enabled = enabled;
    return enabled ? this.request(reason) : Promise.resolve();
  }

  cancelPending(): void {
    this.revision++;
    this.pending = undefined;
  }

  request(reason: ReconnectReason): Promise<void> {
    if (!this.enabled || this.disposed || this.options.isConnected()) return Promise.resolve();
    this.pending = reason;
    return this.flush();
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.disposed || this.running || !this.pending || this.options.isBusy())
      return;
    if (this.options.isConnected()) {
      this.pending = undefined;
      return;
    }
    const reason = this.pending,
      revision = this.revision;
    this.pending = undefined;
    this.running = true;
    try {
      const devices = await this.options.getAuthorizedDevices();
      if (
        revision !== this.revision ||
        !this.enabled ||
        this.disposed ||
        this.options.isConnected()
      )
        return;
      if (this.options.isBusy()) {
        this.pending ??= reason;
        return;
      }
      if (devices.length === 0) {
        this.options.notice(
          'Waiting for an authorized STU-540. Use Choose STU-540 once to grant access.',
        );
      } else if (devices.length > 1) {
        this.options.notice(
          'Several STU-540 tablets are authorized. Use Choose STU-540 to select one.',
        );
      } else {
        this.options.notice(`Reopening the authorized STU-540 after ${reason}…`);
        await this.options.open(devices[0]!, reason);
      }
    } catch (error) {
      if (revision === this.revision && this.enabled && !this.disposed) this.options.error(error);
    } finally {
      this.running = false;
      if (this.options.isConnected()) this.pending = undefined;
      else if (this.pending) void this.flush();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.cancelPending();
  }
}
