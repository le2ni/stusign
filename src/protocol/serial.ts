import { StuError } from '../errors.js';
import { ReportId } from './catalogue.js';

const MAX_PACKED_BYTES = 0x1fff;
/** Largest complete report (including ID) that fits a CRC-protected serial frame. */
export const MAX_SERIAL_REPORT_BYTES = Math.floor((MAX_PACKED_BYTES * 7) / 8) - 2;

/** CRC-16/ARC, initial zero, over the complete report including its ID. */
export function serialCrc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
  }
  return crc;
}

export function encodeSerialFrame(report: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!report.length || report.length > MAX_SERIAL_REPORT_BYTES)
    throw new StuError('INVALID_ARGUMENT', 'Serial report length is outside the framing limit');
  const bytes = new Uint8Array(report.length + 2);
  bytes.set(report);
  new DataView(bytes.buffer).setUint16(report.length, serialCrc16(report), true);
  const size = Math.ceil((bytes.length * 8) / 7);
  const frame = new Uint8Array(size + 2);
  frame[0] = 0xc0 | (size >>> 7);
  frame[1] = size & 0x7f;
  let accumulator = 0,
    bits = 0,
    offset = 2;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 7) {
      bits -= 7;
      frame[offset++] = (accumulator >>> bits) & 0x7f;
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits) frame[offset] = accumulator << (7 - bits);
  return frame;
}

/** Bounded incremental parser. Accepts checked frames and the device's unchecked ACKs. */
export class SerialFrameParser {
  private readonly packed = new Uint8Array(MAX_PACKED_BYTES);
  private header: number | undefined;
  private size: number | undefined;
  private used = 0;

  reset(): void {
    this.packed.fill(0, 0, this.used);
    this.header = this.size = undefined;
    this.used = 0;
  }

  feed(chunk: Uint8Array): Uint8Array[] {
    const reports: Uint8Array[] = [];
    try {
      for (const byte of chunk) {
        if (this.header === undefined) {
          if (byte & 0x80) this.header = byte;
          continue; // Discard noise before a frame boundary.
        }
        if (byte & 0x80)
          throw new StuError('MALFORMED_REPORT', 'Serial frame was interrupted by a new header');
        if (this.size === undefined) {
          this.size = ((this.header & 0x3f) << 7) | byte;
          if (!this.size) throw new StuError('MALFORMED_REPORT', 'Empty serial frame');
          continue;
        }
        this.packed[this.used++] = byte;
        if (this.used !== this.size) continue;
        const decoded = new Uint8Array(Math.floor((this.size * 7) / 8));
        let accumulator = 0,
          bits = 0,
          offset = 0;
        for (let i = 0; i < this.used; i++) {
          accumulator = (accumulator << 7) | this.packed[i]!;
          bits += 7;
          if (bits >= 8) {
            bits -= 8;
            decoded[offset++] = (accumulator >>> bits) & 0xff;
          }
          accumulator &= (1 << bits) - 1;
        }
        if (accumulator || Math.ceil((decoded.length * 8) / 7) !== this.size)
          throw new StuError('MALFORMED_REPORT', 'Invalid serial frame padding');
        let report = decoded;
        if (this.header & 0x40) {
          if (decoded.length < 3)
            throw new StuError('MALFORMED_REPORT', 'Serial frame is missing its report or CRC');
          report = decoded.slice(0, -2);
          const crc = new DataView(decoded.buffer).getUint16(decoded.length - 2, true);
          if (serialCrc16(report) !== crc)
            throw new StuError('MALFORMED_REPORT', 'Serial frame CRC mismatch');
        }
        if (!report.length) throw new StuError('MALFORMED_REPORT', 'Serial report is empty');
        reports.push(report);
        this.reset();
      }
      return reports;
    } catch (error) {
      this.reset();
      throw error;
    }
  }
}

/**
 * Full 0xff report: 512 bytes, with ID/reserved occupying unused entry zero.
 * Entries 1..255 are big-endian uint16 lengths INCLUDING each report's ID.
 * See Wacom's historical getReportSizeCollection and docs/web-serial.md.
 */
export function decodeSerialReportSizes(report: Uint8Array): ReadonlyMap<number, number> {
  if (report.length !== 512 || report[0] !== ReportId.ReportSizeCollection)
    throw new StuError('MALFORMED_REPORT', 'Expected a 512-byte report-size collection');
  const data = new DataView(report.buffer, report.byteOffset, report.byteLength);
  const sizes = new Map<number, number>();
  for (let id = 1; id < 256; id++) {
    const size = data.getUint16(id * 2);
    if (!size) continue;
    if (size > MAX_SERIAL_REPORT_BYTES)
      throw new StuError('MALFORMED_REPORT', 'Unsupported serial report size', { reportId: id });
    sizes.set(id, size);
  }
  if (
    sizes.get(ReportId.Status) !== 5 ||
    sizes.get(ReportId.Information) !== 17 ||
    ![11, 17].includes(sizes.get(ReportId.Capability) ?? 0) ||
    sizes.get(ReportId.ReportSizeCollection) !== 512
  )
    throw new StuError('MALFORMED_REPORT', 'Serial report-size collection failed STU validation');
  return sizes;
}
