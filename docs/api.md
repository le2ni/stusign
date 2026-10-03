# API reference

This reference covers the supported public API of the 0.1 series. Imports are ESM. TypeScript declarations shipped with each entry point define exact parameter and result types. Symbols marked `@internal` are implementation details, even when visible in generated declarations.

## Device and lifecycle — `stusign`

`StuDevice.open(transport, options?)` takes a `ReportTransport`, opens it, reads identity/capabilities, checks readiness and applies optional startup appearance. It resolves to a new `StuDevice`. A transport can belong to only one connection.

| Option              | Default        | Meaning                                                                                        |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `timeoutMs`         | 30000 for open | Opening deadline; also forwarded as the timeout of each optional startup operation             |
| `signal`            | none           | Structural `AbortSignal` compatible cancellation                                               |
| `readyStabilityMs`  | 500            | Continuous ready interval, 0–30000 ms; 0 checks immediately                                    |
| `cryptoProvider`    | none           | Provider used when a recording requires encryption                                             |
| `startupBackground` | none           | RGB integer 0–0xffffff; set and verify volatile background; clear if there is no startup image |
| `startupImage`      | none           | Upload or stored-image recall before open resolves; no implicit ROM provisioning               |

`StartupImage` is `{ source: 'upload', image, format? }` or `{ source: 'stored', slot, expectedHash? }`. Image data and stored hashes are snapshotted before asynchronous work.

| Member                                      | Result / behavior                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `identity`                                  | `DeviceInformation`: model name, firmware and security IC versions                                    |
| `capability`                                | `Capability`: sensor maxima, pressure maximum, display dimensions and optional report/encoding limits |
| `state`                                     | `DeviceState`: opening, open, closing, closed or faulted                                              |
| `protection`                                | Current plaintext, RSA/AES or DH/AES protection metadata                                              |
| `sessionEpoch`                              | Connection identifier for sample grouping; not a device identity                                      |
| `transport`                                 | Underlying normalized transport; avoid direct I/O while device services own it                        |
| `support(reportId)`                         | Descriptor presence, absence, or unknown public report ID                                             |
| `getStatus(options?)`                       | `{ status, lastResult, statusWord }`                                                                  |
| `on(listener)`                              | Subscribe to `DeviceEvent`; returns unsubscribe                                                       |
| `onError(listener)`                         | Input/provider/application-listener errors; returns unsubscribe                                       |
| `stream(options?)`                          | Bounded async event iterator                                                                          |
| `reset('software' \| 'hardware', options?)` | Reset then invalidate this connection; close and reopen                                               |
| `close()`, `dispose()`                      | Idempotent asynchronous teardown; await it before reopening                                           |

Most service methods accept `OperationOptions = { signal?, timeoutMs? }` as their final parameter. The default service deadline is 15000 ms including queue time; image transactions default to 120000 ms; starting capture defaults to 30000 ms. Use 300000 ms for slow full-color serial transfers. Invalid arguments may throw synchronously; put both calls and awaits inside error handling.

## Settings — `tablet.settings`

| Methods                                                 | Values / notes                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `getInking()`, `setInking(enabled)`                     | Automatic tablet ink; boolean                                                                        |
| `getRenderingMode()`, `setRenderingMode(mode)`          | Wire mode 0 or 1                                                                                     |
| `getReportRate()`, `setReportRate(rate)`                | Positive integer bounded by advertised maximum; set while ready                                      |
| `getPenDataOptionMode()`, `setPenDataOptionMode(mode)`  | 0 none, 1 time, 2 sequence, 3 timed/sequence report where supported; synchronizes decoder state      |
| `getInkThreshold()`, `setInkThreshold({ on, off })`     | Pressure thresholds with off ≤ on                                                                    |
| `getHandwritingArea()`, `setHandwritingArea(rectangle)` | Pixel rectangle `{ x, y, width, height }` within screen                                              |
| `getInkStyle()`, `setInkStyle({ color, thickness })`    | Setter RGB 0–0xffffff; getter returns color and rgb24/rgb565 format; monochrome models require black |
| `getBackground()`, `setBackground(color)`               | Volatile clear-screen color; RGB setter, packed color plus format getter                             |
| `getBacklight()`, `setBacklight({ level, persist? })`   | Getter is raw uint16; level 0–3 or 'off'. STU-520 requires persist: true and cannot use 'off'        |
| `getContrast()`, `setContrast(value)`                   | Raw uint16; meaningful range depends on device                                                       |
| `getBootScreen()`, `setBootScreen(enabled)`             | Firmware boot-screen enable flag                                                                     |
| `getUid()`, `setUid(value)`                             | uint32 application UID; setter changes persistent device configuration                               |
| `getDefaultMode()`, `setDefaultMode('hid' \| 'serial')` | Getter wire value; persistent transport selection, may require hardware reset                        |
| `getSerial(kind?, options?)`                            | ASCII extended serial by default; kind 'extended' or 'uid2'                                          |

The options argument follows the setting value, or is first for parameterless getters. Settings are model-dependent; check `support(ReportId.…)` and handle `UNSUPPORTED_FEATURE` / `DEVICE_STATUS`. Read the option mode before interpreting existing optional pen reports, or explicitly set the mode before capture. RGB565 readback is quantized and cannot equal every original RGB24 value.

## Display — `tablet.display`

- `formats`: advertised `ImageFormat[]` — 'mono', 'mono-zlib', 'rgb565', 'bgr24'.
- `clear(area?, options?)`: clear all or a pixel rectangle using the configured background.
- `writeImage(image, options?)`: encode `RgbaImage = { width, height, data }` and upload.
- `writeEncodedImage(image, options?)`: upload `EncodedImage = { width, height, format, encoding, data }`.

`UploadOptions` includes `area`, `signal`, `timeoutMs`, and `onProgress({ sent, total })`. `writeImage` additionally accepts `format` (default 'auto'), `threshold`, `background`, and the image encoder's crop option. The auto choice prefers BGR24, then RGB565, then mono. Full images must equal screen dimensions; partial image dimensions equal their area. See [image encoding](getting-started.md#images).

An upload serializes start, all blocks, commit and recovery. Cancellation abandons the transfer. Progress callback exceptions are isolated. Display operations do not erase canonical recordings; display writes are not permitted during encrypted capture.

## Persistent images — `tablet.rom`

| Method                                                              | Behavior                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `storeImage(slot, rgbaImage, options?)`                             | Full-screen BGR24 image; check occupancy, upload, read hash; return `StoredImageReference` |
| `getHash(slot, options?)`                                           | Select/read `{ mode, number, pressed, result, hash }`; 0 present, 1 absent                 |
| `display(slot, { expectedHash?, ...options }?)`                     | Recall immediately; optional hash guard prevents displaying a replaced image               |
| `upload(descriptor, encodedImage, options?)`                        | Advanced explicit provisioning; can overwrite; no occupancy guard                          |
| `uploadIfChanged(descriptor, encodedImage, expectedHash, options?)` | Skip if current hash equals expected; otherwise upload and verify; return whether uploaded |
| `delete(slot, options?)`                                            | Permanently delete one image                                                               |
| `deleteAll(kind?, options?)`                                        | Permanently delete a kind, or all images if omitted                                        |
| `getCurrentArea(options?)`                                          | Read current image rectangle                                                               |

`StoredImageSlot` permits slideshow 1–10 or message 1–6. `StoreImageOptions` adds `overwrite?: boolean` (default false) and `background?: number` to upload options, without an area. `StoredImageReference = { slot, hash: Uint8Array }` identifies the stored image; its 16-byte device hash is not an authenticity proof.

`RomSlot` also supports signature, keypad and pinpad slots 1–3 and their `pressed` variants. `RomDescriptor` adds three `enabledKeys` booleans for signature images; `layout` and nine `enabledKeys` for keypad; `layout` and `keyFeedback` for PIN images. These advanced layouts require firmware qualification.

`uploadIfChanged` requires a valid previously determined **device** hash; it does not compute the MD5 of an arbitrary source PNG and does not provision missing slots. Prefer `storeImage` for ordinary welcome screens. See [persistent image workflows](stored-images.md).

## Autonomous modes — `tablet.modes`

`get(options?)` returns `OperationMode`. `set(mode, options?)` accepts:

| kind      | Fields                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------- |
| normal    | No other fields                                                                                |
| slideshow | slides: 1–10 indexes (each 1–10), intervalMs: 2000–120000, optional single: 1–10               |
| signature | screen: 1–3, keys: three wire key definitions, optional afterEnter/afterCancel message slots   |
| keypad    | screen: 1–3, optional afterSelect message slot                                                 |
| pinpad    | screen: 1–3, bypass, minDigits: 0–12, maxDigits: 1–12, masked, optional afterEnter/afterCancel |

Message 0 means none; otherwise 1–6. Provision matching ROM layouts before selecting their mode. Normal restores host-controlled operation. Operating-mode persistence across power loss is not qualified.

## Recording and signatures — `stusign` / `stusign/capture`

`tablet.capture.create({ encryption, maxSamples? })` returns `Recording`. Choose 'required' or 'none' explicitly; maximum samples defaults to 100000 (valid range 1–10000000). One recording owns a device at a time.

| Recording member       | Behavior                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `state`, `sampleCount` | Typed lifecycle state and retained sample count                                    |
| `start(options?)`      | Acquire capture and optional encryption                                            |
| `finish(options?)`     | End capture and return immutable `Signature`; duplicate calls share completion     |
| `cancel(options?)`     | End capture and discard samples; cancellation wins over an unfinished start/finish |
| `dispose()`            | Cancel active capture or clear the finished recorder's retained samples            |

Capture overflow and malformed input fail the recording, fault the device and release encryption keys. No partial success is returned. Finished signatures are independent of recorder disposal.

`Signature` exposes immutable `samples`, `metadata`, `loss`; `hasInk`, `complete`, `durationMs`, `contactSamples`, `strokes`, `bounds` and `timeline`. A gap splits strokes. Without sequence information, loss may be undetectable; `complete` only means no detected loss.

- `toSVG(options?)`: deterministic SVG; width, height, strokeWidth, color, background, rotation (0/90/180/270).
- `toJSON({ includeDeviceIdentity? }?)`: format 'stusign.recording', version 1; raw samples deliberately included.
- `Signature.fromJSON(value, maxSamples?)`: validate external recording data; default import limit 1000000.
- `replay({ speed?, immediate?, signal? }?)`: async samples, default speed 1; preserves order, optional host-timing waits.
- `new Recorder(maxSamples?)`: independent bounded recorder with `push`, `finish(metadata)`, `clear`, `count`.
- `transformPoint(point, dimensions, { width, height, rotation?, offsetX?, offsetY? })`: map sensor coordinates to a view.
- `buildTimeline(samples)`, `replaySamples(samples, options?)`: lower-level capture helpers. Device ticks keep their original units; host timestamps use milliseconds.

`PenSample` includes x/y, pressure, pressureNormalized, inProximity, touching, switches, receivedAt, reportId, sessionEpoch, encrypted and optional deviceTime/sequence/option. Samples are biometric data; use [security semantics](security.md).

## Events and streams

`DeviceEvent` is a discriminated union:

| type           | Payload                                      |
| -------------- | -------------------------------------------- |
| pen            | sample                                       |
| signature      | key, encrypted                               |
| keypad         | screen, key, encrypted                       |
| pinpad         | key, value, encrypted — never log PIN values |
| unknown-report | reportId, byteLength only                    |
| error          | error                                        |
| disconnect     | reason                                       |

`stream({ maxBuffered?, types?, signal? })` defaults to 256 buffered events (maximum 100000). Overflow rejects the iterator. Consume with `for await`; breaking the loop unsubscribes. Closing/faulting the device ends all streams, even streams filtering out disconnect events. UI callback errors go to `onError` and do not alter the recorder.

## Transports

Both managers implement `requestDevice()` (transport or null on cancellation), `getAuthorizedDevices()` (no chooser/open), and `onConnection(listener)` (returns unsubscribe). Construct managers only where the browser API is available.

### `stusign/webhid`

`createWebHidManager({ hid?, featureReportPrefix? }?)` supports injection of a structural `HidApi`; prefix is 'auto' by default, 'included' or 'excluded' for nonstandard hosts. Chooser filters known Wacom STU USB product IDs.

`new WebHidTransport(device, options?)` provides `kind`, `limits`, `device`, `open`, `readReport`, `writeReport`, `onInput`, `onDisconnect`, `close`, `forget`. `forget()` closes and revokes browser permission when supported. Utilities: `getHidReportLengths`, `normalizeFeatureReport`, `WACOM_VENDOR_ID`, `STU_PRODUCT_IDS`. See exported structural HID types for non-DOM integrations.

### `stusign/webserial`

`createWebSerialManager({ serial?, filters?, baudRate?, responseTimeoutMs? }?)`. Baud defaults to 128000, response timeout 5000 ms. A filter has usbVendorId and optional usbProductId. Adapter IDs may be FTDI, not Wacom. Selection is unfiltered by default.

`new WebSerialTransport(port, options?)` provides the transport contract, `port`, `identity`, `reportSizes` and `forget()`. Report sizes include the ID; `limits` maps payload lengths excluding it. Non-TLS STU identity and the report-size table are verified when opening. See [framing, recovery and platform limits](web-serial.md).

### Custom transports

Implement the exported DOM-free `ReportTransport` interface: kind, limits, asynchronous open/readReport/writeReport/close, and onInput/onDisconnect returning unsubscribe. Each payload excludes its report ID. Emit a monotonic receivedAt timestamp in milliseconds. Retain exclusive I/O ownership until platform close finishes. Transport implementation and hardware qualification belong to the integrator.

## Browser rendering — `stusign/render`

`drawSignature(context, signature, options?)` renders on a Canvas2D context; `toPNGBlob(signature, options?)` uses a browser canvas; `toSVGBlob(signature, options?)` creates an SVG blob. `imageFromCanvas(canvas)` extracts RGBA from an HTML or OffscreenCanvas. `createObjectURL(blob)` returns `{ url, dispose() }`; dispose revokes the URL once the preview/download no longer needs it.

## Crypto — `stusign/crypto`

`createRsaCryptoProvider({ rsaBits?, aesBits?, crypto? }?)`: RSA defaults 2048 (1024/1536 also accepted); AES defaults 256 (128/192 also accepted). Web Crypto supplies RSA and randomness, `@noble/ciphers` supplies the device's AES block operation.

`createLegacyDhCryptoProvider(backend, crypto?)`: caller supplies a reviewed `LegacyDhBackend`; no arithmetic primitive is bundled. `CryptoProvider`, `EncryptionIo` and `EncryptionSession` define extension contracts. `decodeEncryptionStatus` and `encodeEncryptionCommand` expose protocol-level helpers.

`signExport(content, privateKey, { keyId, contentType, rawData?, document?, crypto? })` produces `SignedExport`. `verifyExport(content, envelope, trustedPublicKey, { rawData?, document?, crypto? }?)` returns a boolean. Keys must be application-owned ECDSA P-256; all associated data named in the envelope must be supplied. See [export signing](security.md#export-signing).

## Low-level protocol — `stusign/protocol`

`tablet.protocol.read(codec, options?)`, `write(codec, value, options?)`, `readRaw(id, options?)`, `writeRaw(id, payload, options?)` share the device queue. They check descriptor capacity and public read/write direction but do not perform high-level state transitions. Read/write raw is not a path to undocumented firmware commands.

Exports include `ReportId`, `reportDefinitions`, `getReportDefinition`, device status/encoding enums, binary readers/writers, all verified report codecs, `encodeImage` and image color helpers, mode/ROM codecs, `serialCrc16`, `encodeSerialFrame`, `SerialFrameParser`, and `decodeSerialReportSizes`. The [support matrix](support-matrix.md#public-report-inventory) identifies unverified layouts. Presence in the enum does not mean a feature is implemented.

## Test support — `stusign/testing`

`MockTransport` implements the report contract with synthetic data and operation logs; `penFixture` creates deterministic pen input; `ReplayTransport` checks scripted operations. These are optional development tools, not hardware emulation evidence or production diagnostic loggers.

## Errors

`StuError` extends Error with a stable `code`, optional operation/reportId/status, and cause. See the README's [error handling summary](../README.md#events-exports-and-errors). Report metadata avoids raw key, pen and PIN bytes; an injected provider or platform error in `cause` remains the caller's responsibility.
