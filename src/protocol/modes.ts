import { boolean, integer, invariant, StuError } from '../errors.js';
import type { DeviceEvent } from '../types.js';
import { bytes, view } from './binary.js';
import type { Bytes } from './binary.js';

export type OperationMode =
  | { readonly kind: 'normal' }
  | {
      readonly kind: 'pinpad';
      readonly screen: number;
      readonly bypass: boolean;
      readonly minDigits: number;
      readonly maxDigits: number;
      readonly masked: boolean;
      readonly afterEnter?: number;
      readonly afterCancel?: number;
    }
  | { readonly kind: 'keypad'; readonly screen: number; readonly afterSelect?: number }
  | {
      readonly kind: 'signature';
      readonly screen: number;
      readonly keys: readonly [number, number, number];
      readonly afterEnter?: number;
      readonly afterCancel?: number;
    }
  | {
      readonly kind: 'slideshow';
      readonly slides: readonly number[];
      readonly intervalMs: number;
      readonly single?: number;
    };

const modeIds = { pinpad: 1, slideshow: 2, keypad: 3, signature: 4, message: 5 } as const;
const message = (value: number | undefined): number => integer(value ?? 0, 0, 6, 'message slot');

export function encodeOperationMode(mode: OperationMode): Uint8Array {
  const out = new Uint8Array(12);
  switch (mode.kind) {
    case 'normal':
      break;
    case 'pinpad':
      out.set([
        1,
        integer(mode.screen, 1, 3, 'screen'),
        Number(boolean(mode.bypass, 'bypass')),
        integer(mode.minDigits, 0, 12, 'minDigits'),
        integer(mode.maxDigits, 1, 12, 'maxDigits'),
        Number(boolean(mode.masked, 'masked')),
        message(mode.afterEnter),
        message(mode.afterCancel),
      ]);
      invariant(mode.minDigits <= mode.maxDigits, 'Minimum PIN length exceeds maximum');
      break;
    case 'keypad':
      out.set([3, integer(mode.screen, 1, 3, 'screen'), message(mode.afterSelect)]);
      break;
    case 'signature':
      invariant(mode.keys.length === 3, 'Signature mode needs three key definitions');
      out.set([
        4,
        integer(mode.screen, 1, 3, 'screen'),
        ...mode.keys.map((key) => integer(key, 0, 255, 'key definition')),
        message(mode.afterEnter),
        message(mode.afterCancel),
      ]);
      break;
    case 'slideshow':
      integer(mode.slides.length, 1, 10, 'slide count');
      out[0] = 2;
      out[1] = mode.single === undefined ? 0 : integer(mode.single, 1, 10, 'single slide');
      out[2] = mode.slides.length;
      mode.slides.forEach((slide, index) => {
        out[3 + (index >> 1)]! |= integer(slide, 1, 10, 'slide') << (index % 2 ? 0 : 4);
      });
      new DataView(out.buffer).setUint32(8, integer(mode.intervalMs, 2000, 120000, 'intervalMs'));
      break;
    default:
      throw new StuError('INVALID_ARGUMENT', 'Unknown operation mode');
  }
  return out;
}

export function decodeOperationMode(payload: Bytes): OperationMode {
  const d = view(payload, 12),
    b = bytes(payload);
  switch (b[0]) {
    case 0:
      return { kind: 'normal' };
    case 1:
      return {
        kind: 'pinpad',
        screen: b[1]!,
        bypass: !!b[2],
        minDigits: b[3]!,
        maxDigits: b[4]!,
        masked: !!b[5],
        afterEnter: b[6]!,
        afterCancel: b[7]!,
      };
    case 2: {
      const count = b[2]!;
      if (count > 10) throw new StuError('MALFORMED_REPORT', 'Invalid slideshow count');
      return {
        kind: 'slideshow',
        slides: Array.from(
          { length: count },
          (_, i) => (b[3 + (i >> 1)]! >>> (i % 2 ? 0 : 4)) & 15,
        ),
        intervalMs: d.getUint32(8),
        ...(b[1] ? { single: b[1] } : {}),
      };
    }
    case 3:
      return { kind: 'keypad', screen: b[1]!, afterSelect: b[2]! };
    case 4:
      return {
        kind: 'signature',
        screen: b[1]!,
        keys: [b[2]!, b[3]!, b[4]!],
        afterEnter: b[5]!,
        afterCancel: b[6]!,
      };
    default:
      throw new StuError('MALFORMED_REPORT', 'Unknown operation mode');
  }
}

export interface RomSlot {
  readonly kind: keyof typeof modeIds;
  readonly number: number;
  readonly pressed?: boolean;
}

export type RomDescriptor = RomSlot &
  (
    | { readonly kind: 'slideshow' | 'message' }
    | { readonly kind: 'signature'; readonly enabledKeys: readonly [boolean, boolean, boolean] }
    | { readonly kind: 'keypad'; readonly layout: number; readonly enabledKeys: readonly boolean[] }
    | { readonly kind: 'pinpad'; readonly layout: number; readonly keyFeedback: number }
  );

export function encodeRomSlot(slot: RomSlot): Uint8Array {
  invariant(Object.hasOwn(modeIds, slot.kind), 'Invalid ROM image kind');
  if (slot.pressed !== undefined) boolean(slot.pressed, 'pressed');
  const max = slot.kind === 'slideshow' ? 10 : slot.kind === 'message' ? 6 : 3;
  integer(slot.number, 1, max, 'ROM image number');
  invariant(
    !slot.pressed || !['slideshow', 'message'].includes(slot.kind),
    'This slot has no pressed image',
  );
  return Uint8Array.of(modeIds[slot.kind], slot.number | (slot.pressed ? 0x80 : 0));
}

export function encodeRomDescriptor(descriptor: RomDescriptor, encoding: number): Uint8Array {
  const slot = encodeRomSlot(descriptor),
    out = new Uint8Array(6);
  out[0] = integer(encoding, 0, 4, 'encoding');
  out.set(slot, 1);
  switch (descriptor.kind) {
    case 'signature':
      invariant(descriptor.enabledKeys.length === 3, 'Signature requires three key flags');
      descriptor.enabledKeys.forEach((enabled, i) => {
        if (boolean(enabled, 'enabled key')) out[3]! |= 1 << i;
      });
      break;
    case 'keypad':
      integer(descriptor.layout, 0, 255, 'layout');
      invariant(descriptor.enabledKeys.length === 9, 'Keypad requires nine key flags');
      out[3] = descriptor.layout;
      descriptor.enabledKeys.forEach((enabled, i) => {
        if (boolean(enabled, 'enabled key')) out[i === 8 ? 4 : 5]! |= 1 << (i % 8);
      });
      break;
    case 'pinpad':
      out[3] = integer(descriptor.layout, 0, 255, 'layout');
      out[4] = integer(descriptor.keyFeedback, 0, 255, 'keyFeedback');
      break;
  }
  return out;
}

export interface RomImageHash {
  readonly mode: number;
  readonly number: number;
  readonly pressed: boolean;
  readonly result: number;
  readonly hash: Uint8Array;
}
export function decodeRomHash(payload: Bytes): RomImageHash {
  const d = view(payload, 19);
  return {
    mode: d.getUint8(0),
    number: d.getUint8(1) & 127,
    pressed: !!(d.getUint8(1) & 128),
    result: d.getUint8(2),
    hash: new Uint8Array(bytes(payload).subarray(3)),
  };
}

export function decodeEvent(payload: Bytes, encrypted = false): DeviceEvent {
  view(payload, 9);
  const b = bytes(payload);
  switch (b[0]) {
    case 1: {
      let value = '';
      for (let i = 0; i < 13; i++) {
        const digit = (b[2 + (i >> 1)]! >>> (i % 2 ? 0 : 4)) & 15;
        if (digit === 15) break;
        if (digit > 12) throw new StuError('MALFORMED_REPORT', 'Invalid PIN character');
        value += '0123456789*#.'[digit];
      }
      return Object.freeze({ type: 'pinpad', key: b[1]!, value, encrypted });
    }
    case 3:
      return Object.freeze({ type: 'keypad', screen: b[1]!, key: b[2]!, encrypted });
    case 4:
      return Object.freeze({ type: 'signature', key: b[1]!, encrypted });
    default:
      throw new StuError('MALFORMED_REPORT', 'Unknown event mode');
  }
}
