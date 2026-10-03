import { integer, invariant, StuError } from '../errors.js';
import type { Rectangle, PenSample } from '../types.js';
import { ascii, bytes, concat, decodeRectangle, encodeRectangle, view } from './binary.js';
import type { Bytes } from './binary.js';
import { ReportId } from './catalogue.js';

export interface Codec<T> {
  readonly id: number;
  decode(payload: Bytes): T;
  encode(value: T): Uint8Array;
}

function scalar(
  id: number,
  size: 1 | 2 | 4,
  littleEndian = false,
  maximum = 2 ** (size * 8) - 1,
): Codec<number> {
  return {
    id,
    decode(payload) {
      const d = view(payload, size);
      return size === 1
        ? d.getUint8(0)
        : size === 2
          ? d.getUint16(0, littleEndian)
          : d.getUint32(0, littleEndian);
    },
    encode(value) {
      integer(value, 0, maximum, 'value');
      const data = new Uint8Array(size),
        d = new DataView(data.buffer);
      if (size === 1) d.setUint8(0, value);
      else if (size === 2) d.setUint16(0, value, littleEndian);
      else d.setUint32(0, value, littleEndian);
      return data;
    },
  };
}

export interface DeviceInformation {
  readonly modelName: string;
  readonly firmwareMajor: number;
  readonly firmwareMinor: number;
  readonly secureIc: number;
  readonly secureIcVersion: readonly number[];
}

export interface Capability {
  readonly tabletMaxX: number;
  readonly tabletMaxY: number;
  readonly pressureMax: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly maxReportRate: number;
  readonly resolution: number;
  readonly encodingFlags: number;
}

export interface DeviceStatus {
  readonly status: number;
  readonly lastResult: number;
  readonly statusWord: number;
}

export function decodeInformation(payload: Bytes): DeviceInformation {
  const d = view(payload, 16);
  return Object.freeze({
    modelName: ascii(bytes(payload).subarray(0, 9)),
    firmwareMajor: d.getUint8(9),
    firmwareMinor: d.getUint8(10),
    secureIc: d.getUint8(11),
    secureIcVersion: Object.freeze(Array.from(bytes(payload).subarray(12, 16))),
  });
}

export function decodeCapability(payload: Bytes): Capability {
  // Older devices expose ten bytes; later reports add rate, resolution and encodings.
  const d = view(payload, 10, 16);
  if (![10, 16].includes(payload.byteLength))
    throw new StuError('MALFORMED_REPORT', 'Unsupported capability report length');
  const result = {
    tabletMaxX: d.getUint16(0),
    tabletMaxY: d.getUint16(2),
    pressureMax: d.getUint16(4),
    screenWidth: d.getUint16(6),
    screenHeight: d.getUint16(8),
    maxReportRate: d.byteLength === 16 ? d.getUint8(10) : 0,
    resolution: d.byteLength === 16 ? d.getUint16(11) : 0,
    encodingFlags: d.byteLength === 16 ? d.getUint8(13) : 0,
  };
  if (
    !result.tabletMaxX ||
    !result.tabletMaxY ||
    !result.pressureMax ||
    !result.screenWidth ||
    !result.screenHeight
  ) {
    throw new StuError(
      'MALFORMED_REPORT',
      'Device reported zero coordinate, pressure, or display limits',
    );
  }
  return Object.freeze(result);
}

export function decodeStatus(payload: Bytes): DeviceStatus {
  const d = view(payload, 4);
  return Object.freeze({
    status: d.getUint8(0),
    lastResult: d.getUint8(1),
    statusWord: d.getUint16(2),
  });
}

export function decodeHidInformation(payload: Bytes): {
  vendorId: number;
  productId: number;
  version: number;
} {
  const d = view(payload, 8);
  return { vendorId: d.getUint16(0), productId: d.getUint16(2), version: d.getUint16(4) };
}

export const uid = scalar(ReportId.Uid, 4);
export const reportRate = scalar(ReportId.ReportRate, 1);
export const renderingMode = scalar(ReportId.RenderingMode, 1, false, 1);
export const inkingMode = scalar(ReportId.InkingMode, 1, false, 1);
export const backlight = scalar(ReportId.BacklightBrightness, 2, true);
export const contrast = scalar(ReportId.ScreenContrast, 2, true);
export const bootScreen = scalar(ReportId.BootScreen, 1, false, 1);
export const penDataOptionMode = scalar(ReportId.PenDataOptionMode, 1, false, 3);
export const background16 = scalar(ReportId.BackgroundColor, 2, true);

export const defaultMode: Codec<number> = {
  id: ReportId.DefaultMode,
  decode(payload) {
    return view(payload, 2).getUint8(0);
  },
  encode(value) {
    return Uint8Array.of(integer(value, 1, 2, 'default mode'), 0);
  },
};

export interface InkThreshold {
  readonly on: number;
  readonly off: number;
}
export const inkThreshold: Codec<InkThreshold> = {
  id: ReportId.InkThreshold,
  decode(payload) {
    const d = view(payload, 4);
    return { on: d.getUint16(0, true), off: d.getUint16(2, true) };
  },
  encode(value) {
    integer(value.on, 0, 65535, 'on threshold');
    integer(value.off, 0, value.on, 'off threshold');
    const result = new Uint8Array(4),
      d = new DataView(result.buffer);
    d.setUint16(0, value.on, true);
    d.setUint16(2, value.off, true);
    return result;
  },
};

export const handwritingArea: Codec<Rectangle> = {
  id: ReportId.HandwritingDisplayArea,
  encode: encodeRectangle,
  decode: decodeRectangle,
};

export const background24: Codec<number> = {
  id: ReportId.BackgroundColor24,
  decode(payload) {
    const d = view(payload, 3);
    return d.getUint8(0) | (d.getUint8(1) << 8) | (d.getUint8(2) << 16);
  },
  encode(value) {
    integer(value, 0, 0xffffff, 'RGB color');
    return Uint8Array.of(value, value >>> 8, value >>> 16);
  },
};

export interface InkStyle {
  readonly color: number;
  readonly thickness: number;
}
function inkStyle(id: number, color: Codec<number>, size: number): Codec<InkStyle> {
  return {
    id,
    decode(payload) {
      const d = view(payload, size + 1);
      return { color: color.decode(bytes(payload).subarray(0, size)), thickness: d.getUint8(size) };
    },
    encode(value) {
      return concat(
        color.encode(value.color),
        Uint8Array.of(integer(value.thickness, 0, 3, 'thickness')),
      );
    },
  };
}
export const inkStyle16 = inkStyle(ReportId.HandwritingThicknessColor, background16, 2);
export const inkStyle24 = inkStyle(ReportId.HandwritingThicknessColor24, background24, 3);

export function encodeImageArea(encoding: number, rectangle: Rectangle): Uint8Array {
  return concat(
    Uint8Array.of(integer(encoding, 0, 255, 'encoding'), 1),
    encodeRectangle(rectangle),
  );
}

export function encodeImageBlock(data: Uint8Array, capacity: number): Uint8Array {
  integer(capacity, 1, 65535, 'block capacity');
  invariant(
    data.byteLength > 0 && data.byteLength <= capacity,
    'Image block exceeds payload capacity',
  );
  const result = new Uint8Array(capacity + 2);
  new DataView(result.buffer).setUint16(0, data.byteLength, true);
  result.set(data, 2);
  return result;
}

export interface PenDecodeContext {
  readonly pressureMax: number;
  readonly receivedAt: number;
  readonly sessionEpoch: number;
  readonly encrypted?: boolean;
  readonly optionMode?: number;
}

export function decodePen(reportId: number, payload: Bytes, context: PenDecodeContext): PenSample {
  const length =
    reportId === ReportId.PenData
      ? 6
      : reportId === ReportId.PenDataOption
        ? 8
        : reportId === ReportId.PenDataTimeCountSequence
          ? 10
          : 0;
  if (!length)
    throw new StuError('UNSUPPORTED_FEATURE', 'Report is not a plaintext pen format', { reportId });
  const d = view(payload, length);
  integer(context.pressureMax, 1, 65535, 'pressure maximum');
  const flags = d.getUint16(0),
    pressure = flags & 0x0fff;
  const optional: { deviceTime?: number; sequence?: number; option?: number } = {};
  if (length === 10) {
    optional.deviceTime = d.getUint16(6);
    optional.sequence = d.getUint16(8);
  }
  if (length === 8) {
    optional.option = d.getUint16(6);
    if (context.optionMode === 1) optional.deviceTime = optional.option;
    if (context.optionMode === 2) optional.sequence = optional.option;
  }
  return Object.freeze({
    x: d.getUint16(2),
    y: d.getUint16(4),
    pressure,
    pressureNormalized: Math.min(1, pressure / context.pressureMax),
    inProximity: !!(flags & 0x8000),
    touching: !!(flags & 0x1000),
    switches: (flags >>> 12) & 7,
    receivedAt: context.receivedAt,
    reportId,
    sessionEpoch: context.sessionEpoch,
    encrypted: context.encrypted ?? false,
    ...optional,
  });
}

/** Decode only AFTER AES decryption; validate the session before releasing any sample. */
export function decodeEncryptedPen(
  reportId: number,
  plaintext: Uint8Array,
  sessionId: number,
  context: PenDecodeContext,
): readonly PenSample[] {
  const d = view(plaintext, reportId === ReportId.PenDataEncryptedOption ? 20 : 16);
  const actualSession = d.getUint32(
    reportId === ReportId.PenDataTimeCountSequenceEncrypted ? 12 : 0,
  );
  if (actualSession !== sessionId)
    throw new StuError('ENCRYPTION', 'Encrypted report belongs to a different session');
  const secure = { ...context, encrypted: true };
  if (reportId === ReportId.PenDataTimeCountSequenceEncrypted) {
    return [
      Object.freeze({
        ...decodePen(ReportId.PenDataTimeCountSequence, plaintext.subarray(0, 10), secure),
        reportId,
      }),
    ];
  }
  if (reportId !== ReportId.PenDataEncrypted && reportId !== ReportId.PenDataEncryptedOption) {
    throw new StuError('UNSUPPORTED_FEATURE', 'Unknown encrypted pen report', { reportId });
  }
  return [4, 10].map((offset, index) => {
    const p =
      reportId === ReportId.PenDataEncryptedOption
        ? concat(
            plaintext.subarray(offset, offset + 6),
            plaintext.subarray(16 + index * 2, 18 + index * 2),
          )
        : plaintext.subarray(offset, offset + 6);
    return Object.freeze({
      ...decodePen(p.length === 8 ? ReportId.PenDataOption : ReportId.PenData, p, secure),
      reportId,
    });
  });
}
