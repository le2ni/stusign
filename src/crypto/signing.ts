import { invariant } from '../errors.js';

export interface SignedExport {
  readonly format: 'stusign.signed-export';
  readonly version: 1;
  readonly algorithm: 'ECDSA-P256-SHA256';
  readonly keyId: string;
  readonly contentType: string;
  readonly contentDigest: string;
  readonly rawDataDigest?: string;
  readonly documentDigest?: string;
  readonly signature: string;
}
export interface ExportSignerOptions {
  readonly keyId: string;
  readonly contentType: string;
  readonly rawData?: Uint8Array;
  readonly document?: Uint8Array;
  readonly crypto?: Crypto;
}

const hex = (data: ArrayBuffer): string =>
  Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (crypto: Crypto, data: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
function signingBytes(envelope: Omit<SignedExport, 'signature'>): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      envelope.format,
      envelope.version,
      envelope.algorithm,
      envelope.keyId,
      envelope.contentType,
      envelope.contentDigest,
      envelope.rawDataDigest ?? null,
      envelope.documentDigest ?? null,
    ]),
  );
}
function checkKey(key: CryptoKey): void {
  invariant(
    key.algorithm.name === 'ECDSA' && (key.algorithm as EcKeyAlgorithm).namedCurve === 'P-256',
    'Expected a P-256 signing key',
  );
}

function isEnvelope(
  value: Record<string, unknown>,
): value is Record<string, unknown> & SignedExport {
  const digestPattern = /^[0-9a-f]{64}$/;
  return (
    value.format === 'stusign.signed-export' &&
    value.version === 1 &&
    value.algorithm === 'ECDSA-P256-SHA256' &&
    typeof value.keyId === 'string' &&
    value.keyId.length > 0 &&
    value.keyId.length <= 512 &&
    typeof value.contentType === 'string' &&
    value.contentType.length > 0 &&
    value.contentType.length <= 256 &&
    typeof value.contentDigest === 'string' &&
    digestPattern.test(value.contentDigest) &&
    (value.rawDataDigest === undefined ||
      (typeof value.rawDataDigest === 'string' && digestPattern.test(value.rawDataDigest))) &&
    (value.documentDigest === undefined ||
      (typeof value.documentDigest === 'string' && digestPattern.test(value.documentDigest))) &&
    typeof value.signature === 'string' &&
    /^[0-9a-f]{128}$/.test(value.signature)
  );
}

export async function signExport(
  content: Uint8Array,
  privateKey: CryptoKey,
  options: ExportSignerOptions,
): Promise<SignedExport> {
  checkKey(privateKey);
  invariant(
    options.keyId.length > 0 &&
      options.keyId.length <= 512 &&
      options.contentType.length > 0 &&
      options.contentType.length <= 256,
    'Invalid signing metadata',
  );
  const crypto = options.crypto ?? globalThis.crypto;
  const rawData = options.rawData ? new Uint8Array(options.rawData) : undefined;
  const document = options.document ? new Uint8Array(options.document) : undefined;
  const envelope: Omit<SignedExport, 'signature'> = {
    format: 'stusign.signed-export',
    version: 1,
    algorithm: 'ECDSA-P256-SHA256',
    keyId: options.keyId,
    contentType: options.contentType,
    contentDigest: await digest(crypto, content),
    ...(rawData ? { rawDataDigest: await digest(crypto, rawData) } : {}),
    ...(document ? { documentDigest: await digest(crypto, document) } : {}),
  };
  const signature = hex(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      signingBytes(envelope),
    ),
  );
  return Object.freeze({ ...envelope, signature });
}

/** The caller supplies the trusted key; an envelope never supplies its own trust. */
export async function verifyExport(
  content: Uint8Array,
  value: unknown,
  publicKey: CryptoKey,
  options: {
    readonly rawData?: Uint8Array;
    readonly document?: Uint8Array;
    readonly crypto?: Crypto;
  } = {},
): Promise<boolean> {
  checkKey(publicKey);
  const crypto = options.crypto ?? globalThis.crypto;
  if (value === null || typeof value !== 'object') return false;
  // Snapshot untrusted metadata before any asynchronous hashing or verification.
  const envelope: Record<string, unknown> = { ...value };
  if (!isEnvelope(envelope)) return false;
  const rawData = options.rawData ? new Uint8Array(options.rawData) : undefined;
  const document = options.document ? new Uint8Array(options.document) : undefined;
  if (envelope.contentDigest !== (await digest(crypto, content))) return false;
  if (
    Boolean(envelope.rawDataDigest) !== Boolean(rawData) ||
    Boolean(envelope.documentDigest) !== Boolean(document)
  )
    return false;
  if (rawData && envelope.rawDataDigest !== (await digest(crypto, rawData))) return false;
  if (document && envelope.documentDigest !== (await digest(crypto, document))) return false;
  const signature = Uint8Array.from(envelope.signature.match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    signingBytes(envelope),
  );
}
