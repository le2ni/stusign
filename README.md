# StuSign

A TypeScript library for Wacom STU signature tablets, using **WebHID** or **Web Serial** directly in the browser. Capture pen input, send images, recall stored screens, configure the tablet, and export signatures as SVG, PNG or versioned JSON.

ESM, TypeScript declarations, tree-shakable entry points, and a **tsdown** build. No Wacom SDK installation or local relay is needed for supported browser connections. This is an independent project; there is no compatibility layer for older libraries.

STU-540 display, plaintext capture and stored-image restoration have been checked on physical hardware. Other model profiles and advanced workflows have software coverage only. See [supported features and devices](docs/support-matrix.md) for model-specific capabilities and limitations.

## Contents

- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Encryption](#encryption)
- [Authorized reopening](#authorized-reopening)
- [Images and stored screens](#images-and-stored-screens)
- [Tablet settings](#tablet-settings)
- [Events, exports and errors](#events-exports-and-errors)
- [Modules and documentation](#modules-and-documentation)
- [Contributing](#contributing)

## Requirements

- A supported STU tablet connected to the computer **running the browser**.
- Desktop Chrome or Edge with `navigator.hid` or `navigator.serial`, on **HTTPS or localhost**. Feature-detect the API; Safari and Firefox are not supported browser targets.
- HID mode for WebHID; serial mode for Web Serial. USB virtual COM uses **128000 baud**; Wacom's physical RS-232 kit uses **115200**.
- Initial selection must run from a click/tap. Permissions are specific to the browser profile and origin. Close other applications or tabs holding the tablet.
- An ESM-aware bundler such as Vite for the browser example. Node.js **22.18+** is supported for server-side core imports, recording processing and development; native Node hardware transports are not included.

[Chrome's WebHID guide](https://developer.chrome.com/docs/capabilities/hid) and [Web Serial guide](https://developer.chrome.com/docs/capabilities/serial) describe browser permissions and deployment restrictions. An RDP session needs the port to be visible to the **remote browser**; serial redirection alone is not a browser-compatibility guarantee. See [terminal-server constraints](docs/web-serial.md#terminal-server-and-rdp).

## Getting started

```sh
npm install stusign
```

The complete example below connects, clears the screen, enables tablet inking, records until **Finish** or **Cancel**, previews an SVG and closes the connection. It deliberately uses plaintext capture. Configure [required encryption](#encryption) for protected capture.

Add these controls to your page, and load the TypeScript entry with your bundler:

```html
<label><input id="serial" type="checkbox" /> Tablet is in USB COM mode</label>
<button id="connect">Connect and sign</button>
<button id="finish" disabled>Finish</button>
<button id="cancel" disabled>Cancel</button>
<output id="status" aria-live="polite"></output>
<img id="preview" alt="Captured signature" />
<a id="download" download="signature.svg" hidden>Download SVG</a>
<script type="module" src="/src/main.ts"></script>
```

<!-- example: examples/basic/app.ts -->

```ts
import { StuDevice, type Recording, type Signature } from 'stusign';
import { createWebHidManager } from 'stusign/webhid';
import { createWebSerialManager } from 'stusign/webserial';
import { createObjectURL, toSVGBlob } from 'stusign/render';

const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const finish = document.querySelector<HTMLButtonElement>('#finish')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const serial = document.querySelector<HTMLInputElement>('#serial')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
const preview = document.querySelector<HTMLImageElement>('#preview')!;
const download = document.querySelector<HTMLAnchorElement>('#download')!;
let imageURL: ReturnType<typeof createObjectURL> | undefined;

function review(tablet: StuDevice): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const settle = (accepted?: boolean, error?: unknown): void => {
      finish.disabled = cancel.disabled = true;
      finish.onclick = cancel.onclick = null;
      unsubscribe();
      if (error) reject(error);
      else resolve(accepted ?? false);
    };
    const unsubscribe = tablet.on((event) => {
      if (event.type === 'disconnect')
        settle(
          false,
          event.reason instanceof Error ? event.reason : new Error('Tablet disconnected'),
        );
      if (event.type === 'error') settle(false, event.error);
    });
    finish.onclick = () => settle(true);
    cancel.onclick = () => settle(false);
    finish.disabled = cancel.disabled = false;
  });
}

function showSignature(signature: Signature): void {
  imageURL?.dispose();
  imageURL = createObjectURL(toSVGBlob(signature, { background: '#ffffff' }));
  preview.src = download.href = imageURL.url;
  download.hidden = false;
  status.textContent = signature.complete ? 'Signature ready.' : 'Signature contains input gaps.';
}

connect.addEventListener('click', async () => {
  connect.disabled = true;
  imageURL?.dispose();
  imageURL = undefined;
  preview.removeAttribute('src');
  download.removeAttribute('href');
  download.hidden = true;
  let tablet: StuDevice | undefined;
  let recording: Recording | undefined;
  try {
    const manager = serial.checked
      ? createWebSerialManager({ baudRate: 128000 })
      : createWebHidManager();
    // Keep this call in the click handler: the browser requires a user gesture.
    const transport = await manager.requestDevice();
    if (!transport) {
      status.textContent = 'Selection cancelled.';
      return;
    }
    tablet = await StuDevice.open(transport);
    await tablet.display.clear();
    await tablet.settings.setInking(true);
    // Deliberate plaintext example. See the encryption section for required protection.
    recording = tablet.capture.create({ encryption: 'none' });
    await recording.start();
    status.textContent = 'Sign on the tablet, then choose Finish or Cancel.';
    if (await review(tablet)) {
      const signature = await recording.finish();
      if (signature.hasInk) showSignature(signature);
      else status.textContent = 'No ink captured.';
    } else {
      await recording.cancel();
      status.textContent = 'Cancelled.';
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Capture failed.';
  } finally {
    try {
      await recording?.dispose();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Capture cleanup failed.';
    }
    try {
      await tablet?.close();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Connection cleanup failed.';
    }
    connect.disabled = false;
  }
});

window.addEventListener('pagehide', () => imageURL?.dispose());
```

The runnable [basic example](examples/basic/index.html) is also available from this checkout with `pnpm demo`. Check **Tablet is in USB COM mode** for a serial-configured STU-540. Keep the library's canonical recording separate from your preview; drawing or clearing the LCD does not erase recorded samples.

## Encryption

For RSA-generation tablets such as STU-430, STU-530 and STU-540, supply a crypto provider when opening and choose `encryption: 'required'`:

```ts
import { StuDevice, type ReportTransport } from 'stusign';
import { createRsaCryptoProvider } from 'stusign/crypto';

async function startProtectedCapture(transport: ReportTransport) {
  const tablet = await StuDevice.open(transport, {
    cryptoProvider: createRsaCryptoProvider(),
  });
  const recording = tablet.capture.create({ encryption: 'required' });
  try {
    await recording.start();
    return { tablet, recording }; // Caller finishes/cancels and closes in finally.
  } catch (error) {
    try {
      await recording.dispose();
    } finally {
      await tablet.close();
    }
    throw error;
  }
}
```

Required encryption fails instead of falling back to plaintext. RSA-OAEP/SHA-1 and AES are device protocol requirements. Older devices need an injected `LegacyDhBackend`; STU-541 needs a separate TLS backend, which this package does not provide. Hardware qualification and an independent security review of encrypted workflows remain outstanding. See [security semantics](docs/security.md).

## Authorized reopening

`getAuthorizedDevices()` lists handles with existing permission; it never shows a chooser. Use it on page load and listen to `manager.onConnection()` for USB attachment. Serialize attempts, open only when idle, and ask the user to select if multiple handles match. A serial manager lists permitted serial adapters, which may include unrelated hardware: use known adapter filters or a previously selected port, rather than probing every port.

For a single known HID tablet, [the connection guide](docs/getting-started.md#authorized-reopening) includes a complete event-driven example with disposal. Use `readyStabilityMs: 0` for an immediate page-refresh check; the default 500 ms stable-ready interval is useful after USB power-up. Transient busy states still wait. Never reuse a faulted `StuDevice`; close it and open a fresh instance. Recordings do not resume across disconnects.

## Images and stored screens

```ts
import type { StuDevice } from 'stusign';
import { imageFromCanvas } from 'stusign/render';

async function showCanvas(tablet: StuDevice, canvas: HTMLCanvasElement) {
  // Canvas dimensions must equal the tablet's screenWidth and screenHeight.
  await tablet.display.writeImage(imageFromCanvas(canvas), {
    format: 'auto',
    timeoutMs: 300_000, // Full-color serial uploads can be slow.
    onProgress: ({ sent, total }) => console.log(Math.round((100 * sent) / total)),
  });
}
```

Supported encodings depend on the device: mono, zlib-compressed mono, RGB565 or BGR24. RGBA input is composited against white by default. Use `area: { x, y, width, height }` for partial uploads; image dimensions must equal the target rectangle. Upload the background **before** starting encrypted capture.

Store a full-screen image once, then recall it without retransferring pixels:

```ts
import { StuDevice, type ReportTransport, type RgbaImage } from 'stusign';

async function provisionWelcome(tablet: StuDevice, image: RgbaImage) {
  // Choose a slot owned by this application. Occupied slots reject by default.
  return tablet.rom.storeImage({ kind: 'slideshow', number: 10 }, image, {
    timeoutMs: 300_000,
  });
}

async function reopenWithWelcome(
  transport: ReportTransport,
  saved: Awaited<ReturnType<typeof provisionWelcome>>,
) {
  return StuDevice.open(transport, {
    startupBackground: 0x17212b,
    startupImage: { source: 'stored', slot: saved.slot, expectedHash: saved.hash },
  });
}
```

Keep the returned slot and hash in your application; serialize `Uint8Array` as a number array or hex and restore it before use. `overwrite: true` explicitly replaces an occupied slot. ROM operations change persistent tablet storage.

`startupImage: { source: 'upload', image }` transfers an image on every connection. Stored recall is faster. Both run when the application connects. The background color is volatile, so pass `startupBackground` to reapply it after a device restart. See [stored images and connection appearance](docs/stored-images.md).

## Tablet settings

```ts
import type { StuDevice } from 'stusign';
import { ReportId } from 'stusign/protocol';

async function configure(tablet: StuDevice) {
  await tablet.settings.setInking(true);
  if (tablet.support(ReportId.BackgroundColor24).state === 'supported') {
    await tablet.settings.setBackground(0x17212b);
    await tablet.display.clear(); // The new background is used when clearing.
  }
  if (tablet.support(ReportId.BootScreen).state === 'supported') {
    await tablet.settings.setBootScreen(false); // Persistent provisioning.
  }
}
```

Other settings include ink color/thickness, handwriting area, pressure thresholds, report mode/rate, rendering mode, brightness, contrast, UID and default HID/serial mode. Availability and persistence differ by model. `support()` indicates descriptor presence, not successful hardware qualification. See the [complete API reference](docs/api.md).

Autonomous signature, PIN, keypad and slideshow modes use `tablet.modes` with images provisioned through `tablet.rom`. Their typed interfaces are available, but advanced mode workflows still need physical qualification.

## Events, exports and errors

```ts
import type { StuDevice, Signature } from 'stusign';
import { toPNGBlob } from 'stusign/render';

function observe(tablet: StuDevice) {
  return tablet.on((event) => {
    if (event.type === 'pen') console.log(event.sample.pressureNormalized);
    if (event.type === 'error') console.error(event.error.message);
    if (event.type === 'disconnect') console.info('Reconnect the tablet.');
  }); // Call the returned unsubscribe function when the view is disposed.
}

async function exportSignature(signature: Signature) {
  return {
    svg: signature.toSVG({ color: '#17212b', background: '#ffffff' }),
    png: await toPNGBlob(signature), // Browser canvas required.
    recording: signature.toJSON(), // Raw samples; device identity omitted by default.
  };
}
```

- `signature.hasInk` distinguishes a blank recording. `complete` and `loss` report detected input gaps, not a guarantee that every physical sample arrived.
- `samples`, `strokes`, `bounds`, `timeline` and `replay()` support custom rendering and analysis. `Signature.fromJSON()` validates versioned recordings.
- `tablet.stream({ types: ['pen'], maxBuffered: 1024, signal })` provides bounded async iteration. A slow stream consumer cannot silently truncate the canonical recording.
- Operations accept `signal` and `timeoutMs`. A HID timeout rejects promptly but keeps the command queue occupied until its platform call settles. Serial protocol faults close the transport.
- Catch `StuError` and use its `code`: `UNSUPPORTED_BROWSER`, `PERMISSION_DENIED`, `DEVICE_BUSY`, `DISCONNECTED`, `UNSUPPORTED_FEATURE`, `INVALID_ARGUMENT`, `MALFORMED_REPORT`, `DEVICE_STATUS`, `TIMEOUT`, `ABORTED`, `ENCRYPTION`, `CAPTURE_OVERFLOW`, `INVALID_STATE`, or `TRANSPORT`.
- Malformed input and encryption failures fault the connection and fail the recording. Close and reconnect. Do not retry persistent writes blindly.
- Raw signature/PIN data is sensitive. The library does not send it anywhere. Application retention, authentication and storage protection are your responsibility. [Export integrity](docs/security.md#export-signing) supports detached P-256 signatures with application-owned keys.

## Modules and documentation

| Import              | Contents                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| `stusign`           | Device services, recordings, signatures, errors, shared types and model profiles |
| `stusign/webhid`    | Device chooser, authorized handles, HID descriptors and transport                |
| `stusign/webserial` | COM chooser, framed serial transport and report-size discovery                   |
| `stusign/protocol`  | Report catalogue, enums, codecs, image encoders, mode and ROM layouts            |
| `stusign/capture`   | Recorder, immutable signature, transforms, SVG and replay                        |
| `stusign/render`    | Canvas, PNG/SVG blobs, RGBA extraction and disposable object URLs                |
| `stusign/crypto`    | RSA/AES, injected DH adapter and detached export signing                         |
| `stusign/testing`   | Synthetic transport, pen fixtures and deterministic replay for consumer tests    |

The core and transport declarations work without `lib.dom`; browser rendering and Web Crypto types are confined to optional modules. All entry points can be imported without opening hardware. The package is **ESM-only**.

Read the [connection and usage guide](docs/getting-started.md), [API reference](docs/api.md), [serial guide](docs/web-serial.md), [support matrix](docs/support-matrix.md), [protocol evidence](docs/protocol-evidence.md), and [security guide](docs/security.md).

## Contributing

From a repository checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

`pnpm check` verifies formatting, strict types, regression tests, the tsdown build, examples, README TypeScript examples, documentation links in both the repository and npm archive, and packed consumers. `pnpm hardware` starts the optional guided hardware harness; see [hardware qualification](docs/stu-540-hardware-test.md). `pnpm test:coverage` creates a local coverage report.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, hardware testing and publishing commands.

MIT. Wacom and STU are Wacom trademarks. StuSign is not affiliated with or endorsed by Wacom.
