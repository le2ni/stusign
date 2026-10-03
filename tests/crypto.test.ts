import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { ecb } from '@noble/ciphers/aes.js';
import {
  createRsaCryptoProvider,
  createLegacyDhCryptoProvider,
  encodeEncryptionCommand,
  signExport,
  verifyExport,
} from '../src/crypto/index.js';
import { MockTransport, penFixture } from '../src/testing/index.js';
import { StuDevice } from '../src/index.js';
import { ReportId } from '../src/protocol/index.js';

const crypto = webcrypto as unknown as Crypto;
const base64 = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

describe('RSA/AES device negotiation', () => {
  it.each(
    ([128, 192, 256] as const).flatMap((aesBits) =>
      [0, 64].map((prefixBytes) => ({ aesBits, prefixBytes })),
    ),
  )(
    'unwraps AES-$aesBits with $prefixBytes leading bytes and checks session IDs',
    async ({ aesBits, prefixBytes }) => {
      const aes = new Uint8Array(aesBits / 8).fill(0x42),
        modulus: number[] = [];
      // The AES key is at the END of Wacom's OAEP plaintext, not necessarily
      // the whole plaintext. Keep the prefix distinct to catch wrong-end slicing.
      const keyBlock = new Uint8Array(prefixBytes + aes.length).fill(0x91);
      keyBlock.set(aes, prefixBytes);
      let exponent = new Uint8Array(),
        encryptedKey = new Uint8Array(),
        selected = 0;
      const commands: Uint8Array[] = [];
      const provider = createRsaCryptoProvider({ crypto, aesBits });
      const session = await provider.negotiate(
        {
          async write(id, payload) {
            expect(id).toBe(0x40);
            commands.push(payload.slice());
            if (payload[0] === 2 && payload[1] === 0) exponent = payload.slice(3, 3 + payload[2]!);
            if (payload[0] === 2 && payload[1] === 1)
              modulus.push(...payload.slice(3, 3 + payload[2]!));
            if (payload[0] === 5) {
              const key = await crypto.subtle.importKey(
                'jwk',
                {
                  kty: 'RSA',
                  n: base64(Uint8Array.from(modulus)),
                  e: base64(exponent),
                  alg: 'RSA-OAEP',
                  ext: true,
                },
                { name: 'RSA-OAEP', hash: 'SHA-1' },
                false,
                ['encrypt'],
              );
              encryptedKey = new Uint8Array(await crypto.subtle.encrypt('RSA-OAEP', key, keyBlock));
            }
            if (payload[0] === 4) selected = payload[2]!;
          },
          async read(id) {
            if (id === 0x50) {
              const status = new Uint8Array(16);
              status.set([(aesBits - 128) / 64, 0x82]);
              return status;
            }
            return encodeEncryptionCommand(
              4,
              2,
              64,
              encryptedKey.slice(selected * 64, selected * 64 + 64),
            );
          },
          async pause() {},
        },
        'rsa-aes',
      );
      expect(commands[0]?.slice(0, 3)).toEqual(Uint8Array.of(1, (aesBits - 128) / 64, 0x82));
      expect(modulus).toHaveLength(256);
      const plaintext = new Uint8Array(16);
      new DataView(plaintext.buffer).setUint32(12, session.protection.sessionId);
      plaintext.set(penFixture({ time: 1, sequence: 1 }).payload);
      const ciphertext = ecb(aes, { disablePadding: true }).encrypt(plaintext);
      expect(session.decrypt(ciphertext)).toEqual(plaintext);

      const transport = new MockTransport();
      const tablet = await StuDevice.open(transport, {
        cryptoProvider: {
          async negotiate() {
            return session;
          },
        },
      });
      const recording = tablet.capture.create({ encryption: 'required' });
      await recording.start();
      transport.emit(0x33, ciphertext);
      const signature = await recording.finish();
      expect(signature.samples).toHaveLength(1);
      expect(signature.metadata.protection.kind).toBe('rsa-aes');
      expect(() => session.decrypt(ciphertext)).toThrow(/disposed/);
      await tablet.close();
    },
  );
  it.each([31, 96])(
    'clears all %i unwrapped bytes even when the key is too short',
    async (length) => {
      const unwrapped = new Uint8Array(length).fill(0x42);
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValueOnce(unwrapped.buffer);
      try {
        const negotiated = createRsaCryptoProvider({ crypto }).negotiate(
          {
            async write() {},
            async read(id) {
              if (id === ReportId.EncryptionStatus) {
                const status = new Uint8Array(16);
                status.set([2, 0x82]);
                return status;
              }
              return encodeEncryptionCommand(4, 2, 64);
            },
            async pause() {},
          },
          'rsa-aes',
        );
        if (length < 32) {
          await expect(negotiated).rejects.toMatchObject({
            code: 'ENCRYPTION',
            message: 'Session key block is too short',
          });
        } else {
          const session = await negotiated;
          const plaintext = new Uint8Array(16).fill(7);
          const ciphertext = ecb(new Uint8Array(32).fill(0x42), { disablePadding: true }).encrypt(
            plaintext,
          );
          expect(session.decrypt(ciphertext)).toEqual(plaintext);
          session.dispose();
          expect(() => session.decrypt(ciphertext)).toThrow(/disposed/);
        }
        expect(decrypt).toHaveBeenCalledOnce();
        expect(unwrapped.every((byte) => byte === 0)).toBe(true);
      } finally {
        decrypt.mockRestore();
      }
    },
  );
  it('rejects device parameter failure without starting capture', async () => {
    const provider = createRsaCryptoProvider({ crypto });
    await expect(
      provider.negotiate(
        {
          async write() {},
          async read() {
            return new Uint8Array(16).fill(255);
          },
          async pause() {},
        },
        'rsa-aes',
      ),
    ).rejects.toMatchObject({ code: 'ENCRYPTION' });
  });
  it('rejects incorrect encrypted session IDs in the input path', async () => {
    const key = new Uint8Array(32),
      transport = new MockTransport();
    const tablet = await StuDevice.open(transport, {
      cryptoProvider: {
        async negotiate() {
          return {
            protection: { kind: 'rsa-aes', sessionId: 123, keyBits: 256 },
            decrypt(bytes) {
              return ecb(key, { disablePadding: true }).decrypt(bytes);
            },
            dispose() {
              key.fill(0);
            },
          };
        },
      },
    });
    const recording = tablet.capture.create({ encryption: 'required' });
    await recording.start();
    transport.emit(
      ReportId.PenDataTimeCountSequenceEncrypted,
      ecb(key, { disablePadding: true }).encrypt(new Uint8Array(16)),
    );
    await expect(recording.finish()).rejects.toMatchObject({ code: 'ENCRYPTION' });
    await recording.cancel();
    await tablet.close();
  });
});

describe('signed exports', () => {
  it('snapshots associated buffers before asynchronous signing and verification', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const original = {
      content: Buffer.from([1]),
      rawData: Buffer.from([2]),
      document: Buffer.from([3]),
    };
    const input = {
      content: Buffer.from([1]),
      rawData: Buffer.from([2]),
      document: Buffer.from([3]),
    };
    const signing = signExport(input.content, pair.privateKey, {
      keyId: 'snapshot-test',
      contentType: 'image/svg+xml',
      rawData: input.rawData,
      document: input.document,
      crypto,
    });
    input.content.fill(9);
    input.rawData.fill(9);
    input.document.fill(9);
    const envelope = await signing;
    const verifying = verifyExport(original.content, envelope, pair.publicKey, {
      rawData: original.rawData,
      document: original.document,
      crypto,
    });
    original.content.fill(8);
    original.rawData.fill(8);
    original.document.fill(8);
    expect(await verifying).toBe(true);
  });
  it('rejects malformed envelopes and snapshots verification metadata', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const content = Uint8Array.of(1),
      envelope = await signExport(content, pair.privateKey, {
        keyId: 'key',
        contentType: 'image/svg+xml',
        crypto,
      });
    for (const invalid of [
      null,
      [],
      {},
      { ...envelope, contentDigest: null },
      { ...envelope, signature: [] },
      { ...envelope, rawDataDigest: '' },
    ]) {
      expect(await verifyExport(content, invalid, pair.publicKey, { crypto })).toBe(false);
    }
    const mutable = { ...envelope };
    const verifying = verifyExport(content, mutable, pair.publicKey, { crypto });
    mutable.keyId = 'changed';
    expect(await verifying).toBe(true);
  });
  it('binds the exact bytes, metadata, raw recording and document to a trusted key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const content = Uint8Array.of(1, 2, 3),
      rawData = Uint8Array.of(4),
      document = Uint8Array.of(5);
    const envelope = await signExport(content, pair.privateKey, {
      keyId: 'test-key',
      contentType: 'image/svg+xml',
      rawData,
      document,
      crypto,
    });
    expect(
      await verifyExport(content, envelope, pair.publicKey, { rawData, document, crypto }),
    ).toBe(true);
    expect(
      await verifyExport(Uint8Array.of(1, 2, 4), envelope, pair.publicKey, {
        rawData,
        document,
        crypto,
      }),
    ).toBe(false);
    expect(
      await verifyExport(content, { ...envelope, keyId: 'different' }, pair.publicKey, {
        rawData,
        document,
        crypto,
      }),
    ).toBe(false);
    expect(await verifyExport(content, envelope, pair.publicKey, { crypto })).toBe(false);
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    expect(
      await verifyExport(content, envelope, other.publicKey, { rawData, document, crypto }),
    ).toBe(false);
  });
});

describe('legacy DH protocol adapter', () => {
  it.each(['Uint8Array', 'Buffer'])(
    'uses a %s backend secret and retains a private AES copy when clearing it',
    async (kind) => {
      const secret = kind === 'Buffer' ? Buffer.alloc(16, 7) : new Uint8Array(16).fill(7),
        dispose = vi.fn(),
        writes: number[] = [];
      const provider = createLegacyDhCryptoProvider(
        {
          async create(prime, generator) {
            expect(prime).toHaveLength(16);
            expect(generator).toEqual(Uint8Array.of(0, 2));
            return {
              publicKey: new Uint8Array(16).fill(2),
              async derive(peer) {
                expect(peer[0]).toBe(3);
                return secret;
              },
              dispose,
            };
          },
        },
        crypto,
      );
      const session = await provider.negotiate(
        {
          async read(id) {
            if (id === ReportId.DHprime) return new Uint8Array(16).fill(1);
            if (id === ReportId.DHbase) return Uint8Array.of(0, 2);
            if (id === ReportId.Status) return new Uint8Array(4);
            return new Uint8Array(16).fill(3);
          },
          async write(id) {
            writes.push(id);
          },
          async pause() {},
        },
        'dh-aes',
      );
      expect(secret.every((byte) => byte === 0)).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(writes).toEqual([ReportId.HostPublicKey]);
      const plaintext = new Uint8Array(16).fill(8),
        encrypted = ecb(new Uint8Array(16).fill(7), { disablePadding: true }).encrypt(plaintext);
      expect(session.decrypt(encrypted)).toEqual(plaintext);
      session.dispose();
      expect(() => session.decrypt(encrypted)).toThrow(/disposed/);
    },
  );
});
