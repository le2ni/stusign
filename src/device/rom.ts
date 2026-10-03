import { boolean, invariant, StuError } from '../errors.js';
import type { OperationOptions } from '../types.js';
import { ReportId } from '../protocol/catalogue.js';
import { decodeRectangle } from '../protocol/binary.js';
import { decodeRomHash, encodeRomDescriptor, encodeRomSlot } from '../protocol/modes.js';
import type { RomDescriptor, RomImageHash, RomSlot } from '../protocol/modes.js';
import { encodeImage } from '../protocol/images.js';
import type { EncodedImage, RgbaImage } from '../protocol/images.js';
import type { DeviceContext } from './context.js';
import { transferImage, validateImage } from './display.js';
import type { UploadOptions } from './display.js';
import type { Transaction } from './scheduler.js';

/** Plain images with no embedded keypad or signature-button layout. */
export interface StoredImageSlot {
  readonly kind: 'slideshow' | 'message';
  readonly number: number;
}
export interface StoredImageReference {
  readonly slot: StoredImageSlot;
  /** Device-returned image identity, not a cryptographic authenticity proof. */
  readonly hash: Uint8Array;
}
export interface StoreImageOptions extends Omit<UploadOptions, 'area'> {
  /** Allow replacing an occupied slot. Empty slots need no overwrite flag. */
  readonly overwrite?: boolean;
  readonly background?: number;
}
export interface StoredImageDisplayOptions extends OperationOptions {
  /** Optionally reject a missing or replaced slot before displaying it. */
  readonly expectedHash?: Uint8Array;
}

export class Rom {
  constructor(private readonly device: DeviceContext) {}
  getHash(slot: RomSlot, options?: OperationOptions): Promise<RomImageHash> {
    const selector = new Uint8Array(19);
    selector.set(encodeRomSlot(slot));
    return this.device.run('read ROM image hash', (tx) => this.readHash(tx, selector), options);
  }
  private async readHash(tx: Transaction, selector: Uint8Array): Promise<RomImageHash> {
    await this.device.waitStatus(tx, [0, 2]);
    await this.device.write(tx, ReportId.RomImageHash, selector);
    // Selecting a slot can enter RomBusy. Do not read its hash until ready.
    await this.device.waitStatus(tx, [0, 2], true);
    const hash = decodeRomHash(await this.device.read(tx, ReportId.RomImageHash));
    await this.device.status(tx, true);
    if (hash.mode !== selector[0] || (hash.number | (hash.pressed ? 128 : 0)) !== selector[1])
      throw new StuError('MALFORMED_REPORT', 'ROM hash response does not match selector');
    return hash;
  }
  /** Store one full-screen BGR24 image persistently, then return its device hash. */
  storeImage(
    slot: StoredImageSlot,
    image: RgbaImage,
    options: StoreImageOptions = {},
  ): Promise<StoredImageReference> {
    invariant(slot.kind === 'slideshow' || slot.kind === 'message', 'Expected a plain image slot');
    invariant(
      !('pressed' in slot) || slot.pressed === false,
      'Stored images have no pressed variant',
    );
    if (options.overwrite !== undefined) boolean(options.overwrite, 'overwrite');
    const target = Object.freeze({ kind: slot.kind, number: slot.number });
    const selector = new Uint8Array(19);
    selector.set(encodeRomSlot(target));
    invariant(
      image.width === this.device.capability.screenWidth &&
        image.height === this.device.capability.screenHeight,
      'Stored image dimensions must match the display',
    );
    const encoded = encodeImage(image, {
      format: 'bgr24',
      ...(options.background === undefined ? {} : { background: options.background }),
    });
    validateImage(this.device, encoded);
    const descriptor = encodeRomDescriptor(target, encoded.encoding);
    const settings = { ...options };
    // Validate the entire workflow before making a persistent write.
    for (const id of [
      ReportId.RomImageHash,
      ReportId.RomStartImageData,
      ReportId.ImageDataBlock,
      ReportId.EndImageData,
    ])
      this.device.requireReport(id);
    return this.device.run(
      'store image',
      async (tx) => {
        const existing = await this.readHash(tx, selector);
        if (existing.result === 0 && settings.overwrite !== true)
          throw new StuError(
            'INVALID_STATE',
            'ROM slot is occupied; use overwrite: true to replace its image',
          );
        if (existing.result !== 0 && existing.result !== 1)
          throw new StuError('DEVICE_STATUS', 'Cannot determine whether the ROM slot is empty', {
            status: existing.result,
          });
        await transferImage(
          this.device,
          tx,
          encoded,
          ReportId.RomStartImageData,
          descriptor,
          settings,
        );
        const stored = await this.readHash(tx, selector);
        if (stored.result !== 0)
          throw new StuError('DEVICE_STATUS', 'Stored image could not be read back', {
            status: stored.result,
          });
        return Object.freeze({ slot: target, hash: stored.hash });
      },
      { timeoutMs: 120_000, ...settings },
    );
  }
  upload(
    descriptor: RomDescriptor,
    image: EncodedImage,
    options: UploadOptions = {},
  ): Promise<void> {
    validateImage(this.device, image);
    const payload = encodeRomDescriptor(descriptor, image.encoding),
      snapshot = { ...image, data: new Uint8Array(image.data) };
    return this.device.run(
      'upload ROM image',
      (tx) =>
        transferImage(this.device, tx, snapshot, ReportId.RomStartImageData, payload, options),
      { timeoutMs: 120_000, ...options },
    );
  }
  /** Hash supplied from a previously read device hash; encoding-specific MD5 rules need hardware qualification. */
  async uploadIfChanged(
    descriptor: RomDescriptor,
    image: EncodedImage,
    expectedHash: Uint8Array,
    options: UploadOptions = {},
  ): Promise<boolean> {
    invariant(expectedHash.length === 16, 'ROM hash must be 16 bytes');
    validateImage(this.device, image);
    const expected = new Uint8Array(expectedHash),
      selector = new Uint8Array(19);
    selector.set(encodeRomSlot(descriptor));
    const payload = encodeRomDescriptor(descriptor, image.encoding),
      snapshot = { ...image, data: new Uint8Array(image.data) };
    return this.device.run(
      'upload ROM image if changed',
      async (tx) => {
        const current = await this.readHash(tx, selector);
        if (current.result !== 0)
          throw new StuError(
            'DEVICE_STATUS',
            'Cannot compare a ROM slot without a valid device hash; use explicit upload for a new slot',
            { status: current.result },
          );
        if (current.hash.every((byte, i) => byte === expected[i])) return false;
        await transferImage(
          this.device,
          tx,
          snapshot,
          ReportId.RomStartImageData,
          payload,
          options,
        );
        const stored = await this.readHash(tx, selector);
        if (stored.result !== 0 || !stored.hash.every((byte, i) => byte === expected[i]))
          throw new StuError('DEVICE_STATUS', 'ROM image hash verification failed');
        return true;
      },
      { timeoutMs: 120_000, ...options },
    );
  }
  display(slot: RomSlot, options: StoredImageDisplayOptions = {}): Promise<void> {
    const payload = encodeRomSlot(slot);
    const expectedHash = options.expectedHash ? new Uint8Array(options.expectedHash) : undefined;
    if (expectedHash) invariant(expectedHash.length === 16, 'ROM hash must be 16 bytes');
    this.device.requireReport(ReportId.RomImageDisplay);
    return this.device.run(
      'display ROM image',
      async (tx) => {
        if (expectedHash) {
          const selector = new Uint8Array(19);
          selector.set(payload);
          const stored = await this.readHash(tx, selector);
          if (stored.result !== 0 || !stored.hash.every((byte, i) => byte === expectedHash[i]))
            throw new StuError('DEVICE_STATUS', 'Stored image is missing or has changed', {
              status: stored.result,
            });
        }
        await this.device.waitStatus(tx, [0]);
        await this.device.write(tx, ReportId.RomImageDisplay, payload);
        await this.device.waitStatus(tx, [0], true);
      },
      options,
    );
  }
  delete(slot: RomSlot, options?: OperationOptions): Promise<void> {
    const payload = encodeRomSlot(slot);
    payload[0]! += 5;
    return this.deletePayload(payload, options);
  }
  deleteAll(kind?: RomSlot['kind'], options?: OperationOptions): Promise<void> {
    const mode = kind ? encodeRomSlot({ kind, number: 1 })[0]! : 0;
    return this.deletePayload(Uint8Array.of(mode, 0), options);
  }
  private deletePayload(payload: Uint8Array, options?: OperationOptions): Promise<void> {
    return this.device.run(
      'delete ROM images',
      async (tx) => {
        await this.device.waitStatus(tx, [0]);
        await this.device.write(tx, ReportId.RomImageDelete, payload);
        await this.device.waitStatus(tx, [0], true);
      },
      options,
    );
  }
  getCurrentArea(options?: OperationOptions): Promise<ReturnType<typeof decodeRectangle>> {
    return this.device.run(
      'read current image area',
      async (tx) => decodeRectangle(await this.device.read(tx, ReportId.CurrentImageArea)),
      options,
    );
  }
}
