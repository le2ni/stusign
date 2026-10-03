import { integer, invariant } from '../errors.js';
import type { OperationOptions, Rectangle } from '../types.js';
import { ReportId, EncodingFlag } from '../protocol/catalogue.js';
import { decodeStatus, encodeImageArea, encodeImageBlock } from '../protocol/codecs.js';
import { StuError } from '../errors.js';
import { encodeImage, imageByteLength, imageEncoding } from '../protocol/images.js';
import type { EncodedImage, ImageFormat, ImageOptions, RgbaImage } from '../protocol/images.js';
import { validateRectangle } from '../protocol/binary.js';
import { getModelProfile } from '../profiles/index.js';
import type { DeviceContext } from './context.js';
import type { Transaction } from './scheduler.js';

export interface UploadOptions extends OperationOptions {
  readonly area?: Rectangle;
  readonly onProgress?: (progress: { readonly sent: number; readonly total: number }) => void;
}

export function supportedFormats(device: DeviceContext): readonly ImageFormat[] {
  const flags = device.capability.encodingFlags;
  if (!flags) return getModelProfile(device.identity.modelName)?.formats ?? ['mono'];
  const formats: ImageFormat[] = [];
  if (flags & EncodingFlag.Mono) {
    formats.push('mono');
    if (flags & EncodingFlag.Zlib) formats.push('mono-zlib');
  }
  if (flags & EncodingFlag.Rgb565) formats.push('rgb565');
  if (flags & EncodingFlag.Bgr24) formats.push('bgr24');
  return formats;
}

export function validateImage(device: DeviceContext, image: EncodedImage): void {
  integer(image.width, 1, device.capability.screenWidth, 'image width');
  integer(image.height, 1, device.capability.screenHeight, 'image height');
  invariant(
    supportedFormats(device).includes(image.format),
    'Image encoding is not advertised by this device',
  );
  invariant(
    image.encoding === imageEncoding(image.format),
    'Image encoding does not match its format',
  );
  invariant(
    image.data.length > 0 && image.data.length <= 64 * 1024 * 1024,
    'Invalid encoded image size',
  );
  if (image.format !== 'mono-zlib')
    invariant(
      image.data.length === imageByteLength(image.width, image.height, image.format),
      'Encoded image length does not match dimensions',
    );
}

/** Caller owns the transaction. Cleanup retains the lane even after cancellation. */
export async function transferImage(
  device: DeviceContext,
  tx: Transaction,
  image: EncodedImage,
  startId: number,
  startPayload: Uint8Array,
  options: UploadOptions,
): Promise<void> {
  const capacity = (device.transport.limits.featureReports.get(ReportId.ImageDataBlock) ?? 0) - 2;
  integer(capacity, 1, 65535, 'descriptor image capacity');
  device.requireReport(startId);
  device.requireReport(ReportId.EndImageData);
  await device.waitStatus(tx, [0]);
  let started = false;
  try {
    started = true;
    await device.write(tx, startId, startPayload);
    await device.waitStatus(tx, [1], true);
    for (let offset = 0; offset < image.data.length; offset += capacity) {
      const block = image.data.subarray(offset, offset + capacity);
      await device.write(tx, ReportId.ImageDataBlock, encodeImageBlock(block, capacity));
      if (options.onProgress) {
        try {
          options.onProgress(
            Object.freeze({ sent: offset + block.length, total: image.data.length }),
          );
        } catch {
          /* UI callbacks cannot corrupt transfers. */
        }
      }
    }
    await device.write(tx, ReportId.EndImageData, Uint8Array.of(0));
    await device.waitStatus(tx, [0], true);
    started = false;
  } catch (error) {
    if (started) {
      try {
        await device.transport.writeReport(ReportId.EndImageData, Uint8Array.of(1));
        const recovered = decodeStatus(await device.transport.readReport(ReportId.Status));
        if (recovered.status !== 0 || recovered.lastResult !== 0)
          throw new StuError('INVALID_STATE', 'Image transfer recovery requires reconnect');
      } catch (cleanupError) {
        device.fault(cleanupError);
      }
    }
    throw error;
  }
}

export class Display {
  constructor(private readonly device: DeviceContext) {}
  get formats(): readonly ImageFormat[] {
    return Object.freeze([...supportedFormats(this.device)]);
  }
  clear(area?: Rectangle, options?: OperationOptions): Promise<void> {
    if (area)
      validateRectangle(
        area,
        this.device.capability.screenWidth,
        this.device.capability.screenHeight,
      );
    const id = area ? ReportId.ClearScreenArea : ReportId.ClearScreen;
    const payload = area ? encodeImageArea(0, area) : Uint8Array.of(0);
    return this.device.run(
      'clear display',
      async (tx) => {
        await this.device.waitStatus(tx, [0]);
        await this.device.write(tx, id, payload);
        await this.device.status(tx, true);
      },
      options,
    );
  }
  writeImage(
    image: RgbaImage,
    options: UploadOptions &
      Omit<ImageOptions, 'format'> & { readonly format?: ImageFormat | 'auto' } = {},
  ): Promise<void> {
    const formats = this.formats;
    const format =
      options.format && options.format !== 'auto'
        ? options.format
        : formats.includes('bgr24')
          ? 'bgr24'
          : formats.includes('rgb565')
            ? 'rgb565'
            : 'mono';
    return this.writeEncodedImage(encodeImage(image, { ...options, format }), options);
  }
  writeEncodedImage(image: EncodedImage, options: UploadOptions = {}): Promise<void> {
    validateImage(this.device, image);
    if (options.area) {
      validateRectangle(
        options.area,
        this.device.capability.screenWidth,
        this.device.capability.screenHeight,
      );
      invariant(
        image.width === options.area.width && image.height === options.area.height,
        'Partial image dimensions do not match the target area',
      );
    } else
      invariant(
        image.width === this.device.capability.screenWidth &&
          image.height === this.device.capability.screenHeight,
        'Full image dimensions do not match the display',
      );
    // Snapshot queued inputs: the caller may reuse its image after this call.
    const snapshot = { ...image, data: new Uint8Array(image.data) };
    const startId = options.area ? ReportId.StartImageDataArea : ReportId.StartImageData;
    const payload = options.area
      ? encodeImageArea(image.encoding, options.area)
      : Uint8Array.of(image.encoding);
    return this.device.run(
      'upload image',
      (tx) => transferImage(this.device, tx, snapshot, startId, payload, options),
      { timeoutMs: 120_000, ...options },
    );
  }
}
