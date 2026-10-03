import { zlibSync } from 'fflate';
import { integer, invariant } from '../errors.js';
import type { Rectangle } from '../types.js';
import { validateRectangle } from './binary.js';
import { EncodingMode } from './catalogue.js';

export type ImageFormat = 'mono' | 'mono-zlib' | 'rgb565' | 'bgr24';
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}
export interface EncodedImage {
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
  readonly encoding: number;
  readonly data: Uint8Array;
}
export interface ImageOptions {
  readonly format: ImageFormat;
  readonly background?: number;
  readonly threshold?: number;
  readonly crop?: Rectangle;
}

export function imageEncoding(format: ImageFormat): number {
  const modes = {
    mono: EncodingMode.Mono,
    'mono-zlib': EncodingMode.MonoZlib,
    rgb565: EncodingMode.Rgb565,
    bgr24: EncodingMode.Bgr24,
  };
  invariant(Object.hasOwn(modes, format), 'Invalid image format');
  return modes[format];
}

export function imageByteLength(
  width: number,
  height: number,
  format: Exclude<ImageFormat, 'mono-zlib'>,
): number {
  integer(width, 1, 65535, 'width');
  integer(height, 1, 65535, 'height');
  invariant(
    format === 'mono' || format === 'rgb565' || format === 'bgr24',
    'Invalid uncompressed image format',
  );
  return (
    (format === 'mono' ? Math.ceil(width / 8) : width * (format === 'rgb565' ? 2 : 3)) * height
  );
}

/** Top-down rows; mono is MSB-first, white=1, each row padded white to a byte. */
export function encodeImage(image: RgbaImage, options: ImageOptions): EncodedImage {
  integer(image.width, 1, 65535, 'width');
  integer(image.height, 1, 65535, 'height');
  invariant(
    image.data.length === image.width * image.height * 4,
    'RGBA buffer length does not match dimensions',
  );
  const rect = options.crop ?? { x: 0, y: 0, width: image.width, height: image.height };
  validateRectangle(rect, image.width, image.height);
  const format = options.format,
    encoding = imageEncoding(format);
  const background = integer(options.background ?? 0xffffff, 0, 0xffffff, 'background');
  const threshold = integer(options.threshold ?? 128, 0, 255, 'threshold');
  const rawFormat = format === 'mono-zlib' ? 'mono' : format;
  const size = imageByteLength(rect.width, rect.height, rawFormat);
  invariant(size <= 64 * 1024 * 1024, 'Image exceeds the 64 MiB allocation limit');
  let data = new Uint8Array(size);
  if (rawFormat === 'mono') data.fill(255);
  const bg = [background >>> 16, (background >>> 8) & 255, background & 255];
  let output = 0;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const offset = ((rect.y + y) * image.width + rect.x + x) * 4;
      const alpha = image.data[offset + 3]! / 255;
      const channel = (i: number): number =>
        Math.round(image.data[offset + i]! * alpha + bg[i]! * (1 - alpha));
      const r = channel(0),
        g = channel(1),
        b = channel(2);
      if (rawFormat === 'mono') {
        if ((299 * r + 587 * g + 114 * b) / 1000 < threshold)
          data[y * Math.ceil(rect.width / 8) + (x >> 3)]! &= ~(128 >>> (x % 8));
      } else if (rawFormat === 'rgb565') {
        const pixel = ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3);
        data[output++] = pixel >>> 8;
        data[output++] = pixel & 255;
      } else {
        data[output++] = b;
        data[output++] = g;
        data[output++] = r;
      }
    }
  }
  if (format === 'mono-zlib') data = zlibSync(data);
  return Object.freeze({ width: rect.width, height: rect.height, format, encoding, data });
}

export function rgbTo565(color: number): number {
  integer(color, 0, 0xffffff, 'RGB color');
  return ((color >>> 8) & 0xf800) | ((color >>> 5) & 0x07e0) | ((color >>> 3) & 0x001f);
}
