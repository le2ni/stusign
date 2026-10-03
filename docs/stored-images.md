# Stored images and connection appearance

Store a welcome screen in tablet memory once, then recall it without transferring the pixels again. Alternatively, upload an image on each connection. Both display paths run through a connected application.

| Behavior                                       | API                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Store an image in tablet memory                | `tablet.rom.storeImage(slot, image)`                                    |
| Recall a stored image                          | `tablet.rom.display(slot)`                                              |
| Recall when the app connects                   | `StuDevice.open(handle, { startupImage: { source: 'stored', slot } })`  |
| Upload when the app connects                   | `StuDevice.open(handle, { startupImage: { source: 'upload', image } })` |
| Restore the clear-screen color when connecting | `StuDevice.open(handle, { startupBackground: 0x28664c })`               |

Availability varies by model; see the [support matrix](support-matrix.md). Stored-image recall and background restoration after a USB power cycle have been [confirmed on STU-540 firmware 1.8](hardware-compatibility.md).

## Store once, recall quickly

Prepare an RGBA image matching the tablet's display dimensions: **800 × 480** on the STU-540. The convenience API uses BGR24; transparent pixels are composited against white unless `background` is provided.

```ts
import type { StuDevice } from 'stusign';
import { imageFromCanvas } from 'stusign/render';

async function saveWelcome(tablet: StuDevice, canvas: HTMLCanvasElement) {
  // Choose a slot owned by this application. Provision it once.
  const saved = await tablet.rom.storeImage(
    { kind: 'slideshow', number: 10 },
    imageFromCanvas(canvas),
    { timeoutMs: 300_000 }, // Full-color serial transfers can be slow.
  );
  await tablet.rom.display(saved.slot, { expectedHash: saved.hash });
  return saved;
}
```

`storeImage()` accepts slideshow slots **1–10** and message slots **1–6**, without pressed variants or button layouts. It checks occupancy, uploads the image, commits and reads back the device's 16-byte hash. An occupied slot rejects unless `overwrite: true` is supplied. Unknown/error results reject even with overwrite enabled. Use `rom.upload()` for advanced PIN/keypad/signature layouts.

Every `storeImage()` call transfers pixels. For later display, reuse `rom.display(saved.slot, { expectedHash: saved.hash })`. Keep the slot and hash in your application; JSON storage needs `Array.from(saved.hash)` when saving and `Uint8Array.from(...)` when restoring validated data. You do not need the source image for recall.

The optional hash check rejects if the slot is missing or changed. It compares the stored image's identity; it is not an authenticity proof or a readback of pixels. Omitting `expectedHash` recalls the selector directly with status checks. No image blocks are sent during recall, though firmware, transport and browser latency still apply.

Cancellation and transfer failures use the ordinary upload recovery mechanism. Cancelling after commit does not undo a persistent save. If commit/readback fails, inspect the slot before attempting replacement. `rom.delete(slot)` and `rom.deleteAll(kind?)` permanently remove stored images.

## Automatic welcome on app connection

Pass the saved reference each time your application opens the tablet:

```ts
import { StuDevice, type ReportTransport, type StoredImageReference } from 'stusign';

async function connectWithWelcome(transport: ReportTransport, saved: StoredImageReference) {
  return StuDevice.open(transport, {
    startupBackground: 0x28664c,
    startupImage: {
      source: 'stored',
      slot: saved.slot,
      expectedHash: saved.hash,
    },
  });
}
```

For a fresh upload instead, pass `startupImage: { source: 'upload', image: rgbaImage, format: 'bgr24' }`. `open()` waits for the display operation before resolving. If it fails, the connection closes and opening rejects. Missing or changed stored images do not fall back to an upload.

Omitting both `startupImage` and `startupBackground` leaves the display unchanged. Supplied pixels, slot and hash are snapshotted before asynchronous opening. The library does not store browser preferences or reconnect automatically; use the [authorized reopening example](getting-started.md#authorized-reopening) to manage connection events.

### Readiness after USB connection

USB enumeration can precede firmware readiness. `open()` checks status before reading identity/capabilities and applying appearance, waits through busy/reset states, and requires continuously ready status for `readyStabilityMs` (default **500 ms**). Transient transport-open/read failures retry within the **30-second** opening deadline, configurable with `timeoutMs`. Permission, protocol and display-write failures are not retried.

Use `readyStabilityMs: 0` to check immediately on page refresh. Busy states and transient read failures still wait. The hardware app uses **1,500 ms** after USB attachment and manual connection; this is an application policy, not a firmware timing guarantee. Cancellation or disconnection stops initialization and closes the session.

Chrome can report a failed OS transfer as `NotAllowedError`. The WebHID adapter retains that cause as `TRANSPORT`, allowing bounded readiness retries; `SecurityError` remains `PERMISSION_DENIED`. See [Chromium's HID implementation](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/hid/hid_device.cc). Persistent failures reach the opening deadline and require the application to handle the error.

## Tablet background color

`tablet.settings.setBackground(0x28664c)` changes the color used by `tablet.display.clear()`. `getBackground()` reads the packed color and format. This setting is volatile on STU-540, so pass `startupBackground` to restore it after reconnection.

`startupBackground` accepts an RGB integer, including `0` for black. Opening sets and verifies it before uploading or recalling `startupImage`. With only a background option, opening clears the display to that color. With an image, it never clears after displaying it. A background readback failure rejects opening before the image operation.

RGB565 devices quantize the selected color. The STU-540 normally uses the 24-bit setting. The clear-screen color does not recolor saved image pixels or margins already included in an uploaded image.

Restoration requires the page to be running, the device to be authorized and a successful application connection. Keep the selected color and image reference in your application's settings and pass them on each reconnect.

## Try it in the browser harness

From a repository checkout, run `pnpm hardware`, open the local page in Chrome/Edge, connect, and find **Welcome & stored images**.

1. Choose a PNG, JPEG or WebP, or use the supplied welcome card. The page fits it to 800 × 480 without stretching.
2. Click **Preview on tablet**. Compare colors, orientation, text and margins with the preview, then give your verdict.
3. Select a slideshow/message slot and click **Save image to tablet**. Replacing an occupied slot requires the replacement checkbox.
4. Confirm saving completed, then separately confirm that the recalled image matches the preview.
5. Display something else and click **Show stored image**. Confirm the saved image returns without a full upload.
6. Enable **Automatically display image on connect** and choose **Recall the saved image (fast)**. Reopen the authorized tablet and compare the preview. **Upload the prepared image** exercises the alternative upload path.
7. Close, unplug/reconnect USB, and reopen with stored recall selected. Do not save again. Confirm the image still appears.

The app keeps the saved slot, device hash and preview in local browser storage. Stored recall uses the last saved reference, independently of unsaved edits to the prepared image. Simulation has separate storage and mock ROM. Reports omit image bytes and filenames.

For background restoration, apply a color with **Apply color & clear display**, compare the solid-color preview, and leave **Restore applied color on connect** enabled. Combine this with **Automatically reopen authorized tablet** to restore the image and color after USB reconnection. Each visual check requires an operator's verdict.

## Protocol references

Wacom's [ROM store documentation](https://developer-support.wacom.com/hc/en-us/articles/9354480514199-STU-540-ROM-Store-Configuration-and-Operation) describes BGR24 storage, selectors, hash results and display commands. Its [operating-mode documentation](https://developer-support.wacom.com/hc/en-us/articles/9354463720343-STU-540-Operating-Modes) describes non-volatile image storage and recall. The [API reference](api.md) lists the full ROM and startup option contracts.
