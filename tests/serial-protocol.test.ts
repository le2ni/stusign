import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decodeSerialReportSizes,
  encodeSerialFrame,
  MAX_SERIAL_REPORT_BYTES,
  SerialFrameParser,
  serialCrc16,
} from '../src/protocol/serial.js';

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.split(' ').map((s) => parseInt(s, 16)));

/** Independent full-report table fixture, not produced by the decoder. */
export function reportSizeFixture(entries: Iterable<readonly [number, number]> = []): Uint8Array {
  const report = new Uint8Array(512);
  report[0] = 0xff;
  const data = new DataView(report.buffer);
  for (const [id, size] of entries) data.setUint16(id * 2, size, false);
  for (const [id, size] of [
    [3, 5],
    [8, 17],
    [9, 17],
    [0x80, 2],
    [0x81, 2],
    [0xff, 512],
  ])
    data.setUint16(id! * 2, size!, false);
  return report;
}

describe('STU serial framing', () => {
  it.each([
    ['80 08', 'c0 05 40 02 0c 00 30'],
    ['80 0c', 'c0 05 40 03 0c 1c 28'],
    ['0c 01 00', 'c0 06 06 00 20 0c 0c 4c'],
    ['04 01', 'c0 05 02 00 38 30 00'],
  ])('matches independently established converter vectors for %s', (report, frame) => {
    expect(encodeSerialFrame(bytes(report))).toEqual(bytes(frame));
    expect(new SerialFrameParser().feed(bytes(frame))).toEqual([bytes(report)]);
  });
  it('uses CRC-16/ARC and accepts the observed unchecked acknowledgement', () => {
    expect(serialCrc16(new TextEncoder().encode('123456789'))).toBe(0xbb3d);
    expect(new SerialFrameParser().feed(bytes('80 03 40 40 00'))).toEqual([bytes('81 00')]);
  });
  it('handles every split position, byte-at-a-time reads, coalesced reports and leading noise', () => {
    const wire = bytes('01 02 03 c0 05 40 02 0c 00 30 80 03 40 40 00');
    for (let split = 0; split <= wire.length; split++) {
      const parser = new SerialFrameParser();
      expect([...parser.feed(wire.slice(0, split)), ...parser.feed(wire.slice(split))]).toEqual([
        bytes('80 08'),
        bytes('81 00'),
      ]);
    }
    const parser = new SerialFrameParser();
    expect([...wire].flatMap((byte) => parser.feed(Uint8Array.of(byte)))).toEqual([
      bytes('80 08'),
      bytes('81 00'),
    ]);
  });
  it('bounds frame sizes and preserves binary values across the largest checked frame', () => {
    const report = Uint8Array.from({ length: MAX_SERIAL_REPORT_BYTES }, (_, i) => i % 256);
    const wire = encodeSerialFrame(report);
    expect(wire.length).toBeLessThanOrEqual(8193);
    expect(new SerialFrameParser().feed(wire)).toEqual([report]);
    expect(() => encodeSerialFrame(new Uint8Array(MAX_SERIAL_REPORT_BYTES + 1))).toThrow();
    expect(() => encodeSerialFrame(new Uint8Array())).toThrow();
  });
  it.each([
    'c0 00', // empty frame
    'c0 02 00 00', // missing CRC
    'c0 05 40 02 0d 00 30', // bad CRC
    'c0 05 40 02 0c 00 31', // nonzero padding
    '80 09 00 00 00 00 00 00 00 00 00', // noncanonical extra padding group
    'c0 05 40 c0 05', // new header interrupts a report
  ])('rejects corrupted frames: %s', (frame) => {
    const parser = new SerialFrameParser();
    expect(() => parser.feed(bytes(frame))).toThrow();
    expect(parser.feed(bytes('80 03 40 40 00'))).toEqual([bytes('81 00')]);
  });
  it('holds partial input without emitting a report, and discards it on reset', () => {
    const parser = new SerialFrameParser();
    expect(parser.feed(bytes('c0 05 40'))).toEqual([]);
    parser.reset();
    expect(parser.feed(bytes('80 03 40 40 00'))).toHaveLength(1);
  });
});

describe('serial report-size discovery', () => {
  it('decodes the captured STU-540 firmware 1.8 serial table', () => {
    const report = readFileSync(
      new URL('./fixtures/stu-540-fw1.8-serial-report-sizes.bin', import.meta.url),
    );
    const sizes = decodeSerialReportSizes(report);
    expect(sizes.size).toBe(74);
    expect(sizes.get(0x26)).toBe(2560);
    expect(sizes.get(0x9b)).toBe(3);
    expect(sizes.get(0x34)).toBe(11);
    expect(sizes.get(0xff)).toBe(512);
    // These envelope reports exist even though the tablet omits them from its table.
    expect(sizes.has(0x80)).toBe(false);
    expect(sizes.has(0x81)).toBe(false);
  });
  it('reads 256 big-endian entries including IDs, with entry zero reserved', () => {
    const fixture = reportSizeFixture([
      [0x26, 256],
      [0x34, 11],
      [0x9b, 3],
      [0xa0, 1], // Unknown report with no payload; presence alone does not enable it.
    ]);
    fixture[1] = 123; // unused entry zero must not be treated as a length
    const sizes = decodeSerialReportSizes(fixture);
    expect(sizes.get(0x26)).toBe(256);
    expect(sizes.get(0x34)).toBe(11);
    expect(sizes.get(0xff)).toBe(512);
    expect(sizes.get(0xa0)).toBe(1);
    expect(sizes.has(0)).toBe(false);
    expect(sizes.has(0x42)).toBe(false);
    // Also work with a nonzero buffer offset.
    const backing = new Uint8Array(514);
    backing.set(fixture, 1);
    expect(decodeSerialReportSizes(backing.subarray(1, 513))).toEqual(sizes);
  });
  it('rejects truncation, wrong endianness, missing bootstrap commands and impossible sizes', () => {
    const valid = reportSizeFixture();
    expect(() => decodeSerialReportSizes(valid.slice(1))).toThrow();
    const littleEndian = valid.slice();
    for (let i = 2; i < 512; i += 2) {
      littleEndian[i] = valid[i + 1]!;
      littleEndian[i + 1] = valid[i]!;
    }
    expect(() => decodeSerialReportSizes(littleEndian)).toThrow();
    for (const size of [0, 1, 7166]) {
      const invalid = valid.slice();
      new DataView(invalid.buffer).setUint16(6, size);
      expect(() => decodeSerialReportSizes(invalid)).toThrow();
    }
  });
});
