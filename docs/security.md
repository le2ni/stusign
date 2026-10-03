# Security and data semantics

## Capture protection

Every recording chooses `encryption: 'required'` or `'none'`. Required encryption never falls back to plaintext. The RSA provider uses freshly generated host keys, requests device-generated AES material, checks negotiation results and validates session IDs before emitting decrypted samples. Plaintext arriving unexpectedly during an established encrypted stream fails capture. Transition periods during start/end have separate handling.

RSA-OAEP/SHA-1 and AES block decryption are device protocol requirements. They are not a recommendation for encrypting arbitrary application data. Older DH devices require their actual group and a separately supplied reviewed backend. STU-541 TLS cannot be replaced by either of these mechanisms.

A session ID check is not general cryptographic authentication. Sequence gaps identify some loss or replay anomalies when the format carries a counter; formats without counters cannot offer that evidence. The library does not claim full traffic authentication, signer identity verification, legal non-repudiation, or a biometric matching algorithm.

The implementation and dependencies still require independent security review and hardware qualification before production encrypted signing. Dependency-level AES tests do not validate an entire device protocol.

## Lifetimes and failure

Keys belong to one device session and are disposed on end, close, error or disconnect as appropriate. Byte buffers receive best-effort clearing. JavaScript garbage collection, native Web Crypto implementations and copies prevent a guarantee of complete memory zeroization.

WebHID operations cannot be cancelled in flight. Timeout rejects the caller promptly, but the queue stays locked until that call settles. Upload cleanup abandons the image and verifies ready state. If recovery is uncertain, the connection faults. Close bounds its wait and tears down the transport; a closed handle is never reused by the old `StuDevice`.

Malformed input and capture overflow fault the connection, fail the recording and release session keys immediately. Close and open a new connection before resuming work. Cancellation during capture start/finish waits for protocol cleanup and cannot produce a completed signature.

Production consumers should handle `StuError.code` and show a reconnect action after device faults. Do not retry non-idempotent provisioning operations automatically.

## Biometric and PIN data

Raw samples contain coordinates, pressure and potentially timing. `toJSON()` exports those samples intentionally. Visual SVG/PNG exports omit them and omit device identity. `includeDeviceIdentity` is an explicit JSON-export option. Applications choose retention, encryption at rest and access controls.

PIN events are separate from signature samples. The STU-540 harness never logs or exports their values. `MockTransport` records synthetic call data and is for tests, not production diagnostics involving keys or PINs.

## Export signing

Detached export envelopes use application-supplied ECDSA P-256 keys and SHA-256. The signed message includes a format/version identifier, algorithm, key ID, content type, content digest and optional raw/document digests. Verification requires a caller-supplied trusted public key and all associated data named by the envelope.

Export signing and verification snapshot the supplied byte arrays before asynchronous hashing, including raw recording and document data.

Signing does not establish who held the pen. Imported recording metadata, including protection descriptions, is untrusted until an application independently verifies its provenance. No signature key is embedded and accepted as its own trust anchor.

## Persistent changes

ROM upload/deletion, communication defaults, UID, boot settings and hardware reset are explicit APIs. Opening a tablet and reading its capabilities do not change persistent settings. Explicit startup options may change the volatile background or display an image. The hardware baseline avoids destructive or persistent tests; advanced qualification requires deliberate selection of replaceable slots.
