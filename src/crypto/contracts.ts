import type { Protection } from '../types.js';

export interface EncryptionIo {
  read(id: number): Promise<Uint8Array>;
  write(id: number, data: Uint8Array): Promise<void>;
  pause(ms: number): Promise<void>;
}
export interface EncryptionSession {
  readonly protection: Extract<Protection, { kind: 'rsa-aes' | 'dh-aes' }>;
  /** Only device-mandated AES blocks; does not authenticate arbitrary messages. */
  decrypt(ciphertext: Uint8Array): Uint8Array;
  dispose(): void;
}
export interface CryptoProvider {
  negotiate(io: EncryptionIo, generation: 'rsa-aes' | 'dh-aes'): Promise<EncryptionSession>;
}
