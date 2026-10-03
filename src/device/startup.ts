import { invariant, StuError } from '../errors.js';
import type { RomSlot } from '../protocol/modes.js';
import { encodeRomSlot } from '../protocol/modes.js';
import type { RgbaImage, ImageFormat } from '../protocol/images.js';

/** Application connection behavior; does not change firmware power-on configuration. */
export type StartupImage =
  | {
      readonly source: 'upload';
      readonly image: RgbaImage;
      readonly format?: ImageFormat | 'auto';
    }
  | {
      readonly source: 'stored';
      readonly slot: RomSlot;
      readonly expectedHash?: Uint8Array;
    };

export function snapshotStartupImage(startup: StartupImage | undefined): StartupImage | undefined {
  if (!startup) return undefined;
  if (startup.source === 'upload') {
    const { width, height, data } = startup.image;
    invariant(
      Number.isSafeInteger(width) &&
        width > 0 &&
        Number.isSafeInteger(height) &&
        height > 0 &&
        width * height * 4 <= 64 * 1024 * 1024 &&
        data.length === width * height * 4,
      'Invalid startup image dimensions or RGBA buffer',
    );
    return { ...startup, image: { width, height, data: new Uint8Array(data) } };
  }
  if (startup.source === 'stored') {
    encodeRomSlot(startup.slot);
    if (startup.expectedHash)
      invariant(startup.expectedHash.length === 16, 'ROM hash must be 16 bytes');
    return {
      source: 'stored',
      slot: { ...startup.slot },
      ...(startup.expectedHash ? { expectedHash: new Uint8Array(startup.expectedHash) } : {}),
    };
  }
  throw new StuError('INVALID_ARGUMENT', 'Unknown startup image source');
}
