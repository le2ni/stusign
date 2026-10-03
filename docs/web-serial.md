# COM ports with Web Serial

StuSign includes `stusign/webserial`, a direct browser transport for Wacom's serial protocol. Use the same `StuDevice` services for display, settings, capture and ROM images through either WebHID or Web Serial. No Wacom SDK, Windows service or local relay is required for this browser transport.

**Verification:** automated framing, stream/lifecycle, request correlation and service-integration tests pass. An [initial physical STU-540 firmware 1.8 USB COM check](hardware-compatibility.md) confirms mode conversion, the 512-byte report-size collection, successful browser connection, background readback and user-confirmed stored-image recall. Continuous input, encryption, full image transfer and cold-boot reopening still require qualification. The simulated tests do not establish those hardware results.

## Connect

Use a browser that exposes `navigator.serial`, on HTTPS or localhost. Chrome and Edge on desktop are the initial test targets. Web Serial also needs OS access to the serial device; a webpage cannot create a missing OS port or choose an arbitrary `/dev` path. First selection must run directly from a click or tap. See the [browser API guide](https://developer.chrome.com/docs/capabilities/serial) for permissions, streams and connection events.

```ts
import { StuDevice } from 'stusign';
import { createWebSerialManager } from 'stusign/webserial';
import { createRsaCryptoProvider } from 'stusign/crypto';

const manager = createWebSerialManager({
  baudRate: 128000, // USB virtual COM
  responseTimeoutMs: 5000, // Each complete write + reply exchange
});

connectButton.addEventListener('click', async () => {
  const transport = await manager.requestDevice();
  if (!transport) return; // Chooser cancelled
  const tablet = await StuDevice.open(transport, {
    cryptoProvider: createRsaCryptoProvider(),
  });
  try {
    console.log(tablet.identity, tablet.capability);
    await tablet.display.writeImage(rgbaImage, {
      format: 'bgr24',
      timeoutMs: 300_000, // Allow for a slow full-color serial transfer
    });
    // Existing tablet.capture, settings and rom APIs work through this handle.
  } finally {
    await tablet.close();
  }
});
```

Wacom documents **128000 baud** for USB virtual COM on STU-540/STU-430V and **115200 baud** for the STU-540 physical RS-232 kit. Both use 8 data bits, no parity, one stop bit and no hardware flow control here. DTR is low and RTS high, following the verified Mac helper. The physical kit needs its power supply and a usable host serial adapter; selecting its baud rate does not make a USB HID connection serial. [Wacom serial connection reference](https://developer-support.wacom.com/hc/en-us/articles/9354494770967-STU-Serial-Connection).

For the physical kit, use `createWebSerialManager({ baudRate: 115200 })`. Applications with an existing granted `SerialPort` can use `new WebSerialTransport(port, { baudRate: 128000, serial: navigator.serial })`; pass the serial API for physical disconnect events. Stream termination also detects disconnects. StuSign's structural interfaces allow injection without forcing `lib.dom` into server-side declaration consumers.

The chooser is intentionally unfiltered by default. The tablet's virtual COM adapter may appear as **USB Serial**, **FTDI**, or an OS port name, with the adapter's vendor/product IDs rather than Wacom's HID vendor ID. Optional `filters: [{ usbVendorId, usbProductId }]` apply to both selection and authorized-port listing. Use the actual adapter identifiers. Opening verifies a known, non-TLS STU model before exposing services; listing ports does not open or identify them. STU-541's TLS protocol is not implemented by this adapter.

## Use the hardware app

Run `pnpm hardware`, or reload an already running test page after rebuilding it. Under **Connection**, choose:

| Selection                            | Device connection                        | Baud           |
| ------------------------------------ | ---------------------------------------- | -------------- |
| USB HID (WebHID)                     | Tablet currently enumerated as USB HID   | Not applicable |
| USB COM (Web Serial, 128000 baud)    | Tablet currently in USB virtual COM mode | 128000         |
| RS-232 kit (Web Serial, 115200 baud) | Physical serial cable and adapter        | 115200         |

Click **Choose STU-540**, select the tablet's port, then compare the device details and display with the instructions. All existing guided tests use the selected transport. Every display test still shows the expected preview and waits for **Yes**, **No**, or **Can't check** before advancing. Choosing a connection type does not change persistent device settings. Close the connection before choosing another type.

The exported report records `transport: "webserial"`, the baud rate, payload limits, and the device's complete serial report-size table including IDs. It does not export an OS port path or serial identifier. Full uploads and ROM provisioning receive a five-minute operation budget in serial mode; each individual command remains subject to its shorter response deadline. Prefer **Recall the saved image (fast)** to uploading the entire image every connection.

## Authorized reopening

`manager.getAuthorizedDevices()` uses `navigator.serial.getPorts()`. It never prompts or probes. `manager.onConnection(({ connected, port }) => { ... })` returns an unsubscribe function. The library does not automatically open arbitrary authorized ports; the application chooses when to reconnect.

The hardware app's existing **Automatically reopen authorized tablet** option works with serial on page load and USB connection. First choose the serial tablet once. After successful identification, the app remembers the adapter IDs and the connection type. It reopens only a single matching authorized port, waits for firmware readiness, then restores the remembered background and welcome image. Multiple matches require explicit selection. Browser serial port information has no dependable unique device identifier, so two identical adapters cannot be distinguished by these saved IDs; model validation is repeated on every open. Physical RS-232 cable reconnection behind a still-attached adapter does not necessarily produce a browser USB event; use **Reopen authorized tablet** in that case.

Keep one connection per tablet. In your own app, serialize reopen attempts, pause them during capture or a pending user review, and close old handles before opening new ones. Do not poll in a loop after a protocol error. After revoking permission with `await transport.forget()`, the next connection needs the chooser again. Feature-detect optional permission revocation on older browsers.

## Changing the tablet's saved communication mode

Web Serial requires the tablet to be in serial mode already. The app's selector is a host-side choice, not a firmware mode switch. From an existing, idle `StuDevice` connection, the existing settings API can save the desired mode and verify it:

```ts
await tablet.settings.setDefaultMode('serial'); // Use 'hid' to switch back
if ((await tablet.settings.getDefaultMode()) !== 2) {
  throw new Error('Serial mode did not match on readback');
}
await tablet.close();
// Unplug and reconnect USB, then choose the new interface in the app.
```

Use expected value `1` when saving `'hid'`. Closing the connection alone does not reboot the tablet. A hardware reset can disconnect before its acknowledgement, so the readback followed by a manual power cycle gives an unambiguous sequence. For recovery without a browser connection, the [Mac helper](macos-serial-to-hid.md) can restore HID from USB COM mode.

## Wire implementation and recovery

- Each report includes its ID inside the serial frame. Frames have a two-byte header, a 13-bit packed length, optional CRC, and an MSB-first 8-to-7-bit payload. Outgoing reports always include CRC-16/ARC, initial zero, appended little-endian before packing. Incoming unchecked frames are accepted because the tablet sends unchecked acknowledgements.
- The bounded parser accepts split/coalesced stream chunks and discards bytes before a frame header. Bad CRC, invalid padding or a new header inside an incomplete frame faults the connection. It does not silently discard a partially received pen report and continue a signature.
- A read sends `[0x80, reportId]` and waits for that report. A write sends a report padded to the discovered size and waits for `[0x81, result]`. Nonzero results become `StuError('DEVICE_STATUS')` with the command ID and result value. Pen and other input reports are routed independently while a command is pending.
- One command occupies the transport at a time. Acknowledgements contain no command identifier. Timeouts, unexpected replies, malformed input and stream failures close the connection and reject queued commands. The exchange deadline covers both write completion and the reply, including the case where the reply arrives first. Closing or aborting a pending open cannot leave a later successful OS open in use.
- Application cancellation follows the existing device scheduler: the caller can receive `ABORTED` promptly while the outstanding serial exchange finishes. The next transaction cannot consume the cancelled command's late reply. If that exchange times out, the connection faults instead of being reused. Port ownership is retained until the browser releases its stream locks and closes the OS handle.
- Serial support does not enable undocumented reports. Public report directions still govern feature operations; `0x80`/`0x81` are internal envelope messages and cannot be issued as raw feature commands through this transport. Unknown incoming IDs reach the device's existing metadata-only diagnostics.

At open, the transport reads Information (`0x08`), validates the model, then reads ReportSizeCollection (`0xff`). The latter is **512 bytes including its ID**. Entry zero occupies bytes 0–1 and is unused; entries 1–255 start at full-report offset `2 × reportId`, each a **big-endian uint16 size including that report's ID**. Zero means absent. Transport payload limits subtract one. The table is checked against required STU report sizes and frame capacity; a missing or malformed table fails open rather than guessing HID sizes.

This layout follows Wacom's pinned [historical `getReportSizeCollection` implementation](https://github.com/Wacom-Developer/signature-sdk-js/blob/d427fda472880b24fd01ebec5b2a774e0063e5ca/sigCaptDialog/libs/stu_capture/stu-sdk.min.js), which allocates 512 bytes, skips entry zero and reads big-endian pairs at offsets `2 × id`. Wacom's [query sample](https://github.com/Wacom-Developer/stu-sdk-samples/blob/0749f46dd0b3d6f37c25adbbc7212c441a875af0/samples/cpp/query.cpp) prints the indexed collection. Its documented STU-430V output reports Status=5, Information=17, Capability=17, ImageDataBlock=256 and ReportSizeCollection=512. The [subsequent physical STU-540 capture](hardware-compatibility.md) confirms the layout and reports a larger ImageDataBlock=2560; device discovery supplies the actual capacity.

The independent converter-frame vectors, provenance and executable hashes are recorded in the [maintenance-helper evidence](macos-serial-to-hid.md#protocol-evidence). The new TypeScript implementation redistributes none of the reference SDK code or binaries.

## Physical STU-540 checks still to run

Use the actual tablet in COM mode, not `?simulate=1`. Keep other apps and tabs that might own the serial port closed. Record the model, firmware, browser, OS and USB/RS-232 choice in session notes. Run each check and confirm only what you can observe:

1. **Connect and baseline:** verify STU-540, 800 × 480, `webserial`, correct baud, plausible report lengths and successful settings reads. Confirm the displayed welcome image against its preview, or mark it uncheckable if no visual change was expected. Export the report-size table even if later tests fail.
2. **Display formats:** compare every monochrome/color test with its preview, including the red/green/blue/black/white order and border. Serial uploads will take longer; confirm only after the transfer finishes. Then check the odd-width partial rectangle and unchanged pixels outside it.
3. **Pen input:** run inking and plaintext capture; draw lines, lift the pen and check tablet/preview alignment and gaps. Finish, review and export. Run encrypted capture separately; a successful plaintext test does not qualify encryption.
4. **Stored images:** recall an already provisioned slot and compare the result. If testing provisioning, choose an empty slot or explicitly allow replacement. After saving, use **Show stored image** and confirm its pixels. Recall should avoid the long upload.
5. **Page reload and power cycle:** enable automatic reopen and stored-image display. Reload: verify no chooser and the saved display. Finish the review, then unplug/reconnect USB: verify one reopen, stable startup and the correct image/background. A real USB cycle is necessary for this check.
6. **Cancellation and unplug:** stop during a long upload; verify a failed/cancelled result and controlled recovery. Repeat with a USB unplug during capture and transfer. After reconnecting, ensure there are no old strokes or stale replies, then run a fresh clear/capture check. Do not count a broken or incomplete signature as passed.
7. **Repeated connections:** run the ten-reconnection test. Confirm no busy-port errors or duplicated input, export the resulting report, and retain separate evidence for USB COM versus a physical RS-232 adapter.

If connection discovery fails, leave automatic welcome display off for the diagnostic retry. A `TIMEOUT` usually calls for checking the chosen port, baud rate and cable, then closing/reopening. A `MALFORMED_REPORT` needs its report ID and exported sizes investigated; do not retry writes blindly. An OS open error can mean another process owns the port. Missing `navigator.serial` needs a supported browser/secure context, not a Wacom device-mode change.

## Terminal server and RDP

The browser must see and be able to open a serial port on the machine where it runs. Wacom explicitly supports [STU-540 serial operation over RDP/Citrix](https://developer-support.wacom.com/hc/en-us/articles/9354480909847-Cannot-connect-to-the-pad-over-Remote-Desktop-Citrix), but that statement describes device/native SDK support, not Web Serial compatibility.

Microsoft's [platform matrix](https://learn.microsoft.com/en-us/windows-app/compare-platforms-features#port-redirection) lists serial redirection for its Windows client, not macOS. On Windows, redirection must be enabled and permitted by policy; see [COM redirection configuration](https://learn.microsoft.com/en-us/azure/virtual-desktop/redirection-configure-serial-com-ports).

There is an additional browser constraint. [Chromium's Windows serial enumerator](https://github.com/chromium/chromium/blob/main/services/device/serial/serial_device_enumerator_win.cc) discovers device interfaces and Windows PnP serial/modem devices. From this implementation, redirected session-only COM aliases may not appear in the chooser; this is an inference that needs testing on the actual server/client configuration. Native application access to COM does not prove browser discovery.

StuSign has not been qualified inside a terminal-server session and includes no native bridge. Run the signing page in a local browser with a remote backend where possible. If the browser must run on the server, verify its port chooser first; a suitable virtual-port driver or separately implemented native bridge may be required. Increase operation timeouts only after proving correct port visibility and protocol operation.
