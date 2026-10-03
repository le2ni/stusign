# Using StuSign

## Connection and lifecycle

Create a WebHID or [Web Serial manager](web-serial.md) inside a supported browser in a secure context. Importing `stusign` on a server is safe; invoking browser transport methods requires the relevant browser API. Availability is checked when creating the manager. For a tablet in USB COM mode, use `createWebSerialManager({ baudRate: 128000 })` from `stusign/webserial` with the same `StuDevice` services below.

```ts
import { StuDevice, StuError } from 'stusign';
import { createWebHidManager } from 'stusign/webhid';

const manager = createWebHidManager();
const authorized = await manager.getAuthorizedDevices();
const tablet = authorized[0] ? await StuDevice.open(authorized[0]) : undefined;
```

If there is no authorized handle, call `manager.requestDevice()` directly from a user gesture. It returns `null` for a cancelled picker. Every open connection needs `close()` in a `finally` block. After an unplug, reset or fault, close the old `StuDevice` and construct a fresh one. Neither recordings nor encryption sessions resume automatically.

`open()` waits for stable firmware readiness before reading metadata or applying startup appearance. It tolerates boot/reset/busy states and transient transport-open/read failures for up to 30 seconds by default. `readyStabilityMs` defaults to 500 ms. Use `0` when reopening an already running tablet: status, identity and capabilities are checked immediately, without an added stability delay; busy states and transient reads still wait/retry. The STU-540 harness uses this immediate check on page load and keeps 1,500 ms of stable readiness for USB reconnects and manual connections. `timeoutMs` overrides the opening deadline (and each optional startup operation's timeout); `signal` cancels the connection attempt. Permission errors and failed writes are not retried.

Use `startupBackground: 0x28664c` to restore a volatile clear-screen color on each connection. Store the chosen RGB value in your application. It is applied and read back before `startupImage`; with no image, the display is cleared to that color. The library does not store browser preferences or make this setting persistent in firmware. See [background restoration](stored-images.md#tablet-background-color).

`manager.onConnection(listener)` reports USB connection/disconnection events for supported STU devices; it returns an unsubscribe function. Applications can use `getAuthorizedDevices()` on page load and connected events to reopen an already permitted device, applying the same `startupImage` option each time. Only open when the application is idle, serialize reconnection attempts, and request a selection if several tablets are authorized. A permission chooser must remain a user action. The [hardware harness](stu-540-hardware-test.md#automatic-authorized-reopening) implements this policy behind **Automatically reopen authorized tablet** and remembers the preference across reloads.

Subscriptions are scoped to the connection:

```ts
const unsubscribe = tablet.on((event) => {
  if (event.type === 'pen') renderPoint(event.sample);
  if (event.type === 'disconnect') showDisconnected();
});
const unsubscribeErrors = tablet.onError(showError);
// Later:
unsubscribe();
unsubscribeErrors();
```

The recorder receives samples before application event callbacks. A failing UI callback is isolated. Capture overflow or malformed input fails the recording; it cannot be finished as a successful signature.

## Authorized reopening

The following policy is for one known HID tablet. It never opens a chooser automatically, serializes page/USB events, checks immediately after page load, waits for boot stability after USB attachment, and returns an asynchronous disposer. Pass the opened device into your application's capture controls. Close it when the signing view is removed. If several devices are authorized, use a manual picker to choose one.

<!-- example: examples/basic/reconnect.ts -->

```ts
import { StuDevice } from 'stusign';
import type { WebHidManager } from 'stusign/webhid';

/** Only use this policy when one previously authorized HID tablet is expected. */
export function watchAuthorizedTablet(
  manager: WebHidManager,
  connected: (tablet: StuDevice) => void,
  reportError: (error: unknown) => void,
): () => Promise<void> {
  let tablet: StuDevice | undefined;
  let stopped = false;
  let queue = Promise.resolve();
  const abort = new AbortController();

  const schedule = (readyStabilityMs: number): void => {
    queue = queue
      .then(async () => {
        if (stopped || tablet?.state === 'open') return;
        await tablet?.close();
        tablet = undefined;
        const handles = await manager.getAuthorizedDevices();
        if (stopped || handles.length !== 1) return; // Use a click-driven chooser otherwise.
        const opened = await StuDevice.open(handles[0]!, {
          readyStabilityMs,
          signal: abort.signal,
        });
        if (stopped) await opened.close();
        else {
          tablet = opened;
          connected(opened);
        }
      })
      .catch((error: unknown) => {
        if (!stopped) reportError(error);
      });
  };

  const unsubscribe = manager.onConnection((event) => {
    if (event.connected) schedule(1500);
  });
  schedule(0); // Page refresh: check readiness immediately.

  return async () => {
    stopped = true;
    unsubscribe();
    abort.abort();
    await queue;
    await tablet?.close();
    tablet = undefined;
  };
}
```

The `connected` callback installs application controls; it should not throw. Call the returned disposer before starting a separate manual connection flow. For serial devices, use a selector based on an explicitly chosen adapter: `getAuthorizedDevices()` can include unrelated serial hardware, and VID/PID alone cannot distinguish two identical adapters. There is no blind background probing or automatic retry of failed provisioning commands.

## Images

```ts
import { imageFromCanvas } from 'stusign/render';
import { encodeImage } from 'stusign/protocol';

await tablet.display.writeImage(imageFromCanvas(backgroundCanvas), {
  format: 'auto',
  timeoutMs: 120_000,
  signal: abortController.signal,
  onProgress: ({ sent, total }) => updateProgress(sent / total),
});

const encoded = encodeImage(rgbaImage, { format: 'mono', threshold: 128 });
await tablet.display.writeEncodedImage(encoded, {
  area: { x: 20, y: 20, width: encoded.width, height: encoded.height },
});
```

RGBA input is top-down. Alpha is composited against white unless `background` is set. Monochrome rows are MSB-first with white padding to a byte. RGB565 image bytes are big-endian; BGR24 bytes are blue, green, red. Monochrome zlib uses `fflate` and is only offered when the device advertises the encoding.

Rectangles use `{ x, y, width, height }`; their wire lower-right coordinates are `x + width`, `y + height`. Endpoints and odd-width partial updates are explicit hardware test items. Host SVG coordinates map the sensor maximum to the output extent without integer rounding.

Upload before starting encrypted capture. The current API rejects display commands while the tablet is in its encrypted capture state, rather than interrupting an active security session implicitly. Cancelling an upload abandons its image transaction. The public promise can reject before a non-abortable HID call has settled; later commands remain queued until cleanup completes.

For images reused across sessions, use `rom.storeImage()` once, then `rom.display()` or the `startupImage` connection option. The [stored welcome-image guide](stored-images.md) covers both upload-on-connect and ROM recall, including overwrite protection, device hashes and browser examples.

## Settings

```ts
await tablet.settings.setInking(true);
await tablet.settings.setRenderingMode(0);
await tablet.settings.setInkStyle({ color: 0x17212b, thickness: 2 });
await tablet.settings.setHandwritingArea({ x: 0, y: 0, width: 800, height: 480 });
await tablet.settings.setBacklight({ level: 2, persist: false });
await tablet.settings.setPenDataOptionMode(3);
```

Query support before optional features. `support()` reports descriptor presence, not physical verification. Brightness, contrast and legal report rates still depend on firmware. STU-520 brightness writes require explicit `persist: true` because that generation persists the setting. Switching default transport mode, changing UID and resets are deliberate provisioning calls.

## ROM and autonomous modes

```ts
const slot = { kind: 'signature', number: 1, pressed: false } as const;
const existing = await tablet.rom.getHash(slot);

// This is a persistent write. Choose a slot whose contents may be replaced.
await tablet.rom.upload({ ...slot, enabledKeys: [true, true, true] }, encodedBackground);
await tablet.rom.display(slot);

await tablet.modes.set({
  kind: 'signature',
  screen: 1,
  keys: [1, 2, 3],
  afterEnter: 0,
  afterCancel: 0,
});
await tablet.modes.set({ kind: 'normal' });
```

Signature key-definition values are wire values. Confirm their ordering against the installed SDK and the tablet's firmware before building a production UI. Keypad enables are set in the ROM image descriptor; operation-mode selection chooses that stored design. PIN results are distinct events and never enter the signature recorder.

`rom.delete(slot)` and `rom.deleteAll(kind?)` modify persistent storage. `rom.uploadIfChanged()` takes an explicit expected device hash: the encoding-dependent relationship between device MD5 hashes and uploaded/compressed bytes has not been physically qualified. It never assumes a PNG's MD5 is the device image hash. Message slots are conservatively limited to six; confirm firmware before increasing this limit.

Conditional upload requires a successful hash query. A nonzero hash result rejects without writing an image. Use an explicit `rom.upload()` to provision a new slot after checking its intended use.

## Exports and replay

`Signature.toSVG()` is deterministic and excludes raw samples and device identifiers. `toJSON()` includes the raw samples deliberately, with device identity excluded unless requested. `Signature.fromJSON()` accepts only the new versioned format and validates sample limits. Imported protection metadata is a claim in a file, not evidence of authenticity.

`signature.contactSamples` filters contact in proximity without changing the raw recording. `signature.timeline` exposes host elapsed milliseconds and unwrapped device-counter ticks when present. Device ticks retain their original units, reset with connection epochs, and assume at most one 16-bit wrap between adjacent samples. The original 16-bit counters remain in `samples`; missing timestamps are never synthesized.

```ts
for await (const sample of signature.replay({ speed: 2, signal: abortController.signal })) {
  updatePreview(sample);
}
```

Replay preserves sample order and uses the recorded host intervals. Pass `immediate: true` to skip waits. Cancellation interrupts pending waits and removes its listeners.

```ts
import { signExport, verifyExport } from 'stusign/crypto';

const bytes = new TextEncoder().encode(signature.toSVG());
const envelope = await signExport(bytes, privateKey, {
  keyId: 'application-signing-key-1',
  contentType: 'image/svg+xml',
  document: documentBytes,
});
const verified = await verifyExport(bytes, envelope, trustedPublicKey, { document: documentBytes });
```

Signing uses application-supplied P-256 keys. It covers exact exported bytes and the included document/raw-data digests through a versioned detached envelope. There is no generated self-trust key or old signed-SVG comment format.

## Low-level extensions

`protocol.read(codec)` / `write(codec, value)` use the library's transaction queue. `readRaw()` / `writeRaw()` are power-user operations and do not perform high-level state transitions or interpret undocumented payloads. Descriptor presence and public report direction are checked; unknown/internal IDs are rejected. Inspect `reportDefinitions` for unresolved layouts.

Additional transports implement `ReportTransport` and normalize payloads without the report ID. The bundled Web Serial adapter supplies framing, CRC, report-size discovery and request correlation; see [serial setup and qualification](web-serial.md). No native SDK binary is bundled. See the support matrix for model and transport verification status.
