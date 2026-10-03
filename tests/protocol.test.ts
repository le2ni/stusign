import { describe, expect, it } from 'vitest';
import { unzlibSync } from 'fflate';
import {
  ReportId,
  reportDefinitions,
  decodeInformation,
  decodeCapability,
  decodeStatus,
  decodePen,
  decodeEncryptedPen,
  encodeImageBlock,
  encodeRectangle,
  decodeRectangle,
  background24,
  inkStyle24,
  backlight,
  uid,
  encodeImage,
  encodeOperationMode,
  decodeOperationMode,
  encodeRomDescriptor,
  decodeEvent,
} from '../src/protocol/index.js';

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.replace(/\s/g, '').match(/../g) ?? [], (byte) => parseInt(byte, 16));
const context = { pressureMax: 4095, receivedAt: 123, sessionEpoch: 1 };

describe('wire layouts', () => {
  it('accounts for every public report exactly once', () => {
    expect(reportDefinitions).toHaveLength(57);
    expect(new Set(reportDefinitions.map((report) => report.id)).size).toBe(57);
    expect(reportDefinitions.find((report) => report.name === 'RomImageOccupancy')?.layout).toBe(
      'unverified',
    );
  });
  it('decodes model and firmware at the SDK offsets, including sliced views', () => {
    const bytes = hex('ffff 5354552d3534300000 010203 04050607 aaaa');
    const info = decodeInformation(new DataView(bytes.buffer, 2, 16));
    expect(info).toEqual({
      modelName: 'STU-540',
      firmwareMajor: 1,
      firmwareMinor: 2,
      secureIc: 3,
      secureIcVersion: [4, 5, 6, 7],
    });
  });
  it('decodes extended and older capability layouts', () => {
    const capability = decodeCapability(hex('1f40 12c0 03ff 0320 01e0 c8 09ec 0a 0000'));
    expect(capability).toEqual({
      tabletMaxX: 8000,
      tabletMaxY: 4800,
      pressureMax: 1023,
      screenWidth: 800,
      screenHeight: 480,
      maxReportRate: 200,
      resolution: 2540,
      encodingFlags: 10,
    });
    expect(decodeCapability(hex('1f40 12c0 03ff 0320 01e0')).encodingFlags).toBe(0);
    expect(() => decodeCapability(new Uint8Array(12))).toThrow();
    expect(() => decodeCapability(new Uint8Array(16))).toThrow();
  });
  it('uses the appropriate byte order per field', () => {
    expect(decodeStatus(hex('02 15 1234'))).toEqual({
      status: 2,
      lastResult: 21,
      statusWord: 0x1234,
    });
    expect(backlight.encode(0x8003)).toEqual(hex('0380'));
    expect(uid.encode(0x12345678)).toEqual(hex('12345678'));
    expect(background24.encode(0xff8040)).toEqual(hex('4080ff'));
    expect(inkStyle24.encode({ color: 0xff8040, thickness: 2 })).toEqual(hex('4080ff02'));
    expect(encodeRectangle({ x: 1, y: 2, width: 799, height: 478 })).toEqual(
      hex('0100 0200 2003 e001'),
    );
    expect(decodeRectangle(hex('0100 0200 2003 e001'))).toEqual({
      x: 1,
      y: 2,
      width: 799,
      height: 478,
    });
  });
  it('preserves all 12 pressure bits and the three switches', () => {
    const pen = decodePen(1, hex('9abc 1234 5678'), context);
    expect(pen.pressure).toBe(0xabc);
    expect(pen.x).toBe(0x1234);
    expect(pen.y).toBe(0x5678);
    expect(pen.touching).toBe(true);
    expect(pen.inProximity).toBe(true);
    expect(pen.switches).toBe(1);
    expect(pen).not.toHaveProperty('deviceTime');
    expect(decodePen(0x34, hex('9001 0001 0002 ffff fffe'), context)).toMatchObject({
      deviceTime: 65535,
      sequence: 65534,
    });
    expect(
      decodePen(0x30, hex('9001 0001 0002 abcd'), { ...context, optionMode: 2 }),
    ).toMatchObject({ sequence: 0xabcd, option: 0xabcd });
  });
  it('validates encrypted session IDs before exposing either packed sample', () => {
    const raw = hex('12345678 9001 0002 0003 8000 0004 0005');
    expect(decodeEncryptedPen(0x10, raw, 0x12345678, context).map((sample) => sample.x)).toEqual([
      2, 4,
    ]);
    expect(() => decodeEncryptedPen(0x10, raw, 0x87654321, context)).toThrow(/session/);
  });
  it.each([0, 1, 2, 3, 4, 5, 7, 100])('rejects malformed basic pen length %i', (length) => {
    expect(() => decodePen(1, new Uint8Array(length), context)).toThrow();
  });
  it('declares the actual final block length, separately from wire padding', () => {
    expect(encodeImageBlock(hex('abcd'), 5)).toEqual(hex('0200abcd000000'));
    expect(() => encodeImageBlock(hex('abcd'), 1)).toThrow();
  });
});

describe('image encoders', () => {
  const image = {
    width: 3,
    height: 1,
    data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255),
  };
  it('encodes BGR24 primary colors', () => {
    expect(encodeImage(image, { format: 'bgr24' }).data).toEqual(hex('0000ff00ff00ff0000'));
  });
  it('encodes big-endian RGB565 primary colors', () => {
    expect(encodeImage(image, { format: 'rgb565' }).data).toEqual(hex('f80007e0001f'));
  });
  it('pads each odd-width monochrome row with white pixels', () => {
    const pixels = new Uint8Array(9 * 2 * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    const mono = encodeImage({ width: 9, height: 2, data: pixels }, { format: 'mono' });
    expect(mono.data).toEqual(hex('007f007f'));
    expect(
      unzlibSync(encodeImage({ width: 9, height: 2, data: pixels }, { format: 'mono-zlib' }).data),
    ).toEqual(mono.data);
  });
  it('composites alpha before encoding and crops without stride corruption', () => {
    expect(
      encodeImage({ width: 1, height: 1, data: new Uint8Array(4) }, { format: 'bgr24' }).data,
    ).toEqual(hex('ffffff'));
    expect(
      encodeImage(image, { format: 'bgr24', crop: { x: 1, y: 0, width: 1, height: 1 } }).data,
    ).toEqual(hex('00ff00'));
    expect(() =>
      encodeImage(image, { format: 'mono', crop: { x: 2, y: 0, width: 2, height: 1 } }),
    ).toThrow();
  });
});

describe('ROM and mode layouts', () => {
  it('encodes signature and PIN mode fields with padding', () => {
    expect(
      encodeOperationMode({
        kind: 'signature',
        screen: 2,
        keys: [1, 2, 3],
        afterEnter: 4,
        afterCancel: 5,
      }),
    ).toEqual(hex('040201020304050000000000'));
    expect(
      encodeOperationMode({
        kind: 'pinpad',
        screen: 1,
        bypass: false,
        minDigits: 4,
        maxDigits: 8,
        masked: true,
      }),
    ).toEqual(hex('010100040801000000000000'));
    expect(() =>
      encodeOperationMode({
        kind: 'pinpad',
        screen: 1,
        bypass: false,
        minDigits: 9,
        maxDigits: 8,
        masked: true,
      }),
    ).toThrow();
  });
  it('packs slideshow nibbles and a big-endian millisecond interval', () => {
    const mode = { kind: 'slideshow', slides: [1, 2, 3], intervalMs: 2000 } as const;
    const wire = hex('0200031230000000000007d0');
    expect(encodeOperationMode(mode)).toEqual(wire);
    expect(decodeOperationMode(wire)).toEqual(mode);
  });
  it('encodes ROM key enable masks', () => {
    expect(
      encodeRomDescriptor(
        { kind: 'signature', number: 3, pressed: true, enabledKeys: [true, false, true] },
        4,
      ),
    ).toEqual(hex('040483050000'));
    expect(
      encodeRomDescriptor(
        {
          kind: 'keypad',
          number: 1,
          layout: 2,
          enabledKeys: [true, false, false, false, false, false, false, true, true],
        },
        4,
      ),
    ).toEqual(hex('040301020181'));
  });
  it('decodes PIN nibbles and signature/keypad results', () => {
    expect(decodeEvent(hex('0100 1234 abcfffffff'))).toMatchObject({
      type: 'pinpad',
      value: '1234*#.',
    });
    expect(decodeEvent(hex('030207000000000000'))).toMatchObject({
      type: 'keypad',
      screen: 2,
      key: 7,
    });
    expect(decodeEvent(hex('040300000000000000'))).toMatchObject({ type: 'signature', key: 3 });
    expect(() => decodeEvent(new Uint8Array(9))).toThrow();
  });
});
