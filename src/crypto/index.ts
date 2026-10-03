import { ecb } from '@noble/ciphers/aes.js';
import { invariant, integer, StuError } from '../errors.js';
import { ReportId } from '../protocol/catalogue.js';
import { view } from '../protocol/binary.js';
import type { CryptoProvider, EncryptionIo, EncryptionSession } from './contracts.js';

export type { CryptoProvider, EncryptionIo, EncryptionSession } from './contracts.js';
export { signExport, verifyExport } from './signing.js';
export type { SignedExport, ExportSignerOptions } from './signing.js';

export interface EncryptionStatus {
  readonly symmetricKeyType: number;
  readonly padding: number;
  readonly asymmetricKeyType: number;
  readonly exponent: number;
  readonly modulus: number;
  readonly cipher: number;
  readonly lastResult: number;
  readonly flags: number;
}
export function decodeEncryptionStatus(payload: Uint8Array): EncryptionStatus {
  const d = view(payload, 16);
  return {
    symmetricKeyType: d.getUint8(0),
    padding: d.getUint8(1) >>> 6,
    asymmetricKeyType: d.getUint8(1) & 63,
    exponent: d.getUint8(3),
    modulus: d.getUint8(4),
    cipher: d.getUint8(5),
    lastResult: d.getUint8(6),
    flags: d.getUint8(7),
  };
}

export function encodeEncryptionCommand(
  command: number,
  parameter: number,
  lengthOrIndex: number,
  data: Uint8Array = new Uint8Array(),
): Uint8Array {
  integer(command, 1, 5, 'encryption command');
  integer(parameter, 0, 255, 'parameter');
  integer(lengthOrIndex, 0, 255, 'length/index');
  invariant(data.length <= 64, 'Encryption parameter block exceeds 64 bytes');
  const result = new Uint8Array(67);
  result.set([command, parameter, lengthOrIndex]);
  result.set(data, 3);
  return result;
}

function randomSessionId(crypto: Crypto): number {
  return new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0);
}
function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
    char.charCodeAt(0),
  );
}

function aesSession(
  key: Uint8Array,
  protection: EncryptionSession['protection'],
): EncryptionSession {
  let disposed = false;
  return {
    protection: Object.freeze(protection),
    decrypt(ciphertext) {
      if (disposed) throw new StuError('ENCRYPTION', 'Encryption session is disposed');
      if (ciphertext.length !== 16)
        throw new StuError('MALFORMED_REPORT', 'Expected one encrypted STU block');
      return ecb(key, { disablePadding: true }).decrypt(ciphertext);
    },
    dispose() {
      disposed = true;
      key.fill(0);
    },
  };
}

export interface RsaCryptoOptions {
  readonly rsaBits?: 1024 | 1536 | 2048;
  readonly aesBits?: 128 | 192 | 256;
  readonly crypto?: Crypto;
}

/** RSA-OAEP/SHA-1 is mandated by this device protocol. No plaintext downgrade. */
export function createRsaCryptoProvider(options: RsaCryptoOptions = {}): CryptoProvider {
  return {
    async negotiate(io, generation) {
      if (generation !== 'rsa-aes')
        throw new StuError(
          'UNSUPPORTED_FEATURE',
          'This provider supports RSA-generation STU devices',
        );
      const crypto = options.crypto ?? globalThis.crypto;
      if (!crypto?.subtle) throw new StuError('ENCRYPTION', 'Web Crypto is unavailable');
      const rsaBits = options.rsaBits ?? 2048,
        aesBits = options.aesBits ?? 256;
      invariant(
        [1024, 1536, 2048].includes(rsaBits) && [128, 192, 256].includes(aesBits),
        'Unsupported device key size',
      );
      let key: Uint8Array | undefined;
      try {
        const pair = await crypto.subtle.generateKey(
          {
            name: 'RSA-OAEP',
            modulusLength: rsaBits,
            publicExponent: Uint8Array.of(1, 0, 1),
            hash: 'SHA-1',
          },
          true,
          ['encrypt', 'decrypt'],
        );
        const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
        if (!jwk.n || !jwk.e) throw new StuError('ENCRYPTION', 'RSA public key is incomplete');
        const exponent = decodeBase64Url(jwk.e),
          modulus = decodeBase64Url(jwk.n);
        const symmetric = (aesBits - 128) / 64,
          asymmetric = (rsaBits - 1024) / 512;
        await io.write(
          ReportId.EncryptionCommand,
          encodeEncryptionCommand(1, symmetric, 0x80 | asymmetric),
        );
        await io.write(
          ReportId.EncryptionCommand,
          encodeEncryptionCommand(2, 0, exponent.length, exponent),
        );
        for (let offset = 0; offset < modulus.length; offset += 64) {
          const block = modulus.slice(offset, offset + 64);
          await io.write(
            ReportId.EncryptionCommand,
            encodeEncryptionCommand(2, 1, block.length, block),
          );
        }
        const ready = decodeEncryptionStatus(await io.read(ReportId.EncryptionStatus));
        if (
          ready.exponent !== 0 ||
          ready.modulus !== 0 ||
          ready.lastResult !== 0 ||
          ready.symmetricKeyType !== symmetric ||
          ready.padding !== 2 ||
          ready.asymmetricKeyType !== asymmetric
        )
          throw new StuError('ENCRYPTION', 'Device rejected RSA parameters');
        await io.write(ReportId.EncryptionCommand, encodeEncryptionCommand(5, 0, 0));
        for (let attempts = 0; ; attempts++) {
          const status = decodeEncryptionStatus(await io.read(ReportId.EncryptionStatus));
          if (status.lastResult !== 0)
            throw new StuError('ENCRYPTION', 'Device key generation failed');
          if (status.cipher === 0) break;
          if (status.cipher !== 0xfa || attempts >= 199)
            throw new StuError('ENCRYPTION', 'Device did not finish key generation');
          await io.pause(25);
        }
        const ciphertext = new Uint8Array(rsaBits / 8);
        for (let offset = 0, index = 0; offset < ciphertext.length; index++) {
          await io.write(ReportId.EncryptionCommand, encodeEncryptionCommand(4, 2, index));
          const reply = await io.read(ReportId.EncryptionCommand);
          view(reply, 67);
          const length = reply[2]!;
          if (
            reply[0] !== 4 ||
            reply[1] !== 2 ||
            length < 1 ||
            length > 64 ||
            offset + length > ciphertext.length
          )
            throw new StuError('ENCRYPTION', 'Invalid encrypted-key response');
          ciphertext.set(reply.subarray(3, 3 + length), offset);
          offset += length;
        }
        const unwrapped = new Uint8Array(
          await crypto.subtle.decrypt('RSA-OAEP', pair.privateKey, ciphertext),
        );
        try {
          const keyBytes = aesBits / 8;
          if (unwrapped.length < keyBytes)
            throw new StuError('ENCRYPTION', 'Session key block is too short');
          // Wacom's native sample takes the final keyBytes of the OAEP plaintext;
          // firmware may include leading bytes before the AES key.
          key = unwrapped.slice(-keyBytes);
        } finally {
          unwrapped.fill(0);
        }
        const session = aesSession(key, {
          kind: 'rsa-aes',
          keyBits: aesBits,
          sessionId: randomSessionId(crypto),
        });
        key = undefined;
        return session;
      } catch (cause) {
        key?.fill(0);
        if (cause instanceof StuError) throw cause;
        throw new StuError('ENCRYPTION', 'RSA session negotiation failed', { cause });
      }
    },
  };
}

/** Inject a reviewed DH primitive for the device's nonstandard 128-bit group. */
export interface LegacyDhBackend {
  create(
    prime: Uint8Array,
    generator: Uint8Array,
  ): Promise<{
    readonly publicKey: Uint8Array;
    derive(peerPublicKey: Uint8Array): Promise<Uint8Array>;
    dispose(): void;
  }>;
}

export function createLegacyDhCryptoProvider(
  backend: LegacyDhBackend,
  crypto: Crypto = globalThis.crypto,
): CryptoProvider {
  return {
    async negotiate(io, generation) {
      if (generation !== 'dh-aes')
        throw new StuError(
          'UNSUPPORTED_FEATURE',
          'This provider supports DH-generation STU devices',
        );
      const prime = await io.read(ReportId.DHprime),
        generator = await io.read(ReportId.DHbase);
      view(prime, 16);
      view(generator, 2);
      if (prime.every((byte) => byte === 0))
        throw new StuError('UNSUPPORTED_FEATURE', 'Device encryption is disabled');
      const exchange = await backend.create(prime, generator);
      try {
        view(exchange.publicKey, 16);
        await io.write(ReportId.HostPublicKey, exchange.publicKey);
        let peer: Uint8Array | undefined;
        for (let i = 0; i < 200; i++) {
          const status = await io.read(ReportId.Status);
          view(status, 4);
          if (status[1] !== 0) throw new StuError('ENCRYPTION', 'Device rejected DH key');
          if (status[0] === 0) {
            peer = await io.read(ReportId.DevicePublicKey);
            break;
          }
          await io.pause(25);
        }
        if (!peer) throw new StuError('ENCRYPTION', 'Device DH calculation did not finish');
        view(peer, 16);
        const key = await exchange.derive(peer);
        try {
          invariant(key.length === 16, 'Legacy DH backend must derive a 16-byte key');
          return aesSession(new Uint8Array(key), {
            kind: 'dh-aes',
            keyBits: 128,
            sessionId: randomSessionId(crypto),
          });
        } finally {
          key.fill(0);
        }
      } finally {
        exchange.dispose();
      }
    },
  };
}
