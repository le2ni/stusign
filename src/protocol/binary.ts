import { StuError, integer } from '../errors.js';
import type { Rectangle } from '../types.js';

export type Bytes = Uint8Array | DataView;

export function bytes(value: Bytes): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function view(value: Bytes, minimum: number, maximum = minimum): DataView {
  if (value.byteLength < minimum || value.byteLength > maximum) {
    throw new StuError(
      'MALFORMED_REPORT',
      `Expected ${minimum === maximum ? minimum : `${minimum}–${maximum}`} payload bytes; received ${value.byteLength}`,
    );
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
}

export function ascii(value: Bytes): string {
  let text = '';
  for (const c of bytes(value)) {
    if (!c) break;
    text += String.fromCharCode(c);
  }
  return text;
}

export function validateRectangle(rect: Rectangle, width = 65535, height = 65535): void {
  integer(rect.x, 0, width - 1, 'x');
  integer(rect.y, 0, height - 1, 'y');
  integer(rect.width, 1, width - rect.x, 'width');
  integer(rect.height, 1, height - rect.y, 'height');
}

export function encodeRectangle(rect: Rectangle): Uint8Array {
  validateRectangle(rect);
  const result = new Uint8Array(8);
  const data = new DataView(result.buffer);
  data.setUint16(0, rect.x, true);
  data.setUint16(2, rect.y, true);
  data.setUint16(4, rect.x + rect.width, true);
  data.setUint16(6, rect.y + rect.height, true);
  return result;
}

export function decodeRectangle(value: Bytes): Rectangle {
  const data = view(value, 8);
  const x = data.getUint16(0, true),
    y = data.getUint16(2, true);
  const width = data.getUint16(4, true) - x,
    height = data.getUint16(6, true) - y;
  if (width < 0 || height < 0) throw new StuError('MALFORMED_REPORT', 'Inverted rectangle');
  return Object.freeze({ x, y, width, height });
}

export function concat(...values: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(values.reduce((n, value) => n + value.length, 0));
  let offset = 0;
  for (const value of values) {
    out.set(value, offset);
    offset += value.length;
  }
  return out;
}
