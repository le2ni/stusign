# STU-540 hardware qualification

This reusable guide separates command outcomes from operator-confirmed tablet behavior. Consult the [aggregate qualification matrix](hardware-compatibility.md) for current coverage. The [macOS conversion helper](macos-serial-to-hid.md) is available if a tablet must be switched from serial to HID; the test app also supports serial directly.

## Start the script

From the `stusign` directory:

```sh
pnpm install
pnpm check
pnpm hardware
```

Open **http://127.0.0.1:4173** in Chrome or Edge. The script builds both the library and browser application with tsdown. It serves only on loopback. Stop it with Ctrl+C. Set `STUSIGN_PORT=4174` if port 4173 is occupied.

## How each check works

Choose a test from the left. The **What to check** list explains what the tablet should do. Image operations show an **Expected tablet display** using the same image sent to the tablet. The preview is a reference, not a screenshot read back from the tablet.

After the operation, compare the tablet with the instructions and preview, then choose:

- **Yes, matches:** device commands succeeded and you verified the appearance/behavior.
- **No, differs:** the check fails; describe the difference in the optional per-step notes.
- **Can't check:** records a skipped observation, never a pass.

Every format, partial-update stage and reconnection waits for a separate answer. There is no automatic advance or blanket visual confirmation. Device errors are recorded as failed (unsupported features as skipped); **Continue after this result** acknowledges the result without turning it into a pass. **Stop current test** cancels an upload, drawing or pending review and restores temporary settings if the connection is still usable.

Drawing has no five-second deadline. Once the page says **Draw on the tablet**, draw and lift the pen between strokes, then click **Finish drawing**. Review the tablet and both previews before giving your verdict. **Recorded pen input** is distinct from the expected tablet display: with inking disabled, the tablet stays white while the pen preview still draws.

Finishing a drawing disables further tablet ink while you compare the captured result. The original ink settings are restored when the test ends.

The report includes the instructions, command outcome, your verdict and notes for each step. Successful commands remain **pending** until you confirm. You can export while a review is pending. Software/simulation results are explicitly labeled and do not qualify hardware.

The files are:

- `scripts/hardware-server.mjs`: build and local server.
- `examples/hardware/app.ts`: test operations, pen preview and JSON report export.
- `examples/hardware/index.html`: controls and visual observations.
- `examples/hardware/welcome.ts`: local image fitting, saved slot references and remembered previews.

Close software that already owns the tablet, including Wacom sample applications and other browser tabs using it. Use test scribbles and dummy PINs. The exported report contains device model/firmware/capabilities, report lengths, test outcomes and your observations. It excludes device serial numbers, raw pen samples, signature images, PIN values and key material. Downloading the optional SVG is a separate explicit action.

If the tablet is in COM mode, select **USB COM (Web Serial, 128000 baud)** under **Connection** and choose its serial port. The physical RS-232 kit has a separate 115200-baud option. Follow the [serial qualification checks](web-serial.md#physical-stu-540-checks-still-to-run). To use HID instead, the [macOS serial-to-HID helper](macos-serial-to-hid.md) changes the persistent default and restarts the tablet; the browser harness does neither automatically.

## 1. Connection and descriptors

The optional **Software check → Run software-only check** uses synthetic capture across sequence rollover, canvas rendering and PNG/SVG export. Its preview and result are explicitly labeled software evidence; it does not qualify a physical tablet.

1. Plug in the STU-540 and select its current connection type: USB HID, USB COM or the RS-232 kit. This harness does not change USB/serial defaults.
2. Click **Choose STU-540**, cancel the browser chooser, and confirm there is no failed connection or stale handle.
3. Click it again and select the tablet. The identity should say STU-540, and the display should report 800 × 480. Confirm the connection step before choosing another test.
4. Click **Read device & settings**. Review every result. Save any failures; do not silently skip an unexpected failure on an advertised feature.
5. Record operating system, browser version and firmware in the report/observations. The browser user-agent is collected, but write the exact browser version if it is reduced there.
6. Inspect the feature/input report lengths. In particular, the image block payload `0x26` might be 255 or 2559 bytes. The library derives capacity from the descriptor, then subtracts the two-byte valid-length field.
7. Close the connection and click **Reopen authorized tablet**. It should reopen without a new chooser.

### Automatic authorized reopening

Enable **Automatically reopen authorized tablet** in Connect. It checks for an authorized STU-540 immediately, after page load, and on USB connection. The preference is remembered in this browser, separately for hardware and simulation. Grant permission once with **Choose STU-540** first; background reopening never opens a permission chooser.

1. Authorize and connect, then finish the connection review. Enable automatic reopening and reload the page. The authorized tablet should open without another chooser, apply your welcome-image option, and show a new connection check awaiting your verdict. An already ready tablet is checked immediately, with no added 1.5-second stability delay; device details should show `readyStabilityMs: 0`. Busy firmware and transient open/read errors still wait/retry. Reloading starts a new report, so export the previous one first if needed.
2. Finish the review, unplug and reconnect USB. The new connection must apply the same welcome option and wait for another verdict. An interrupted capture/upload remains cancelled; it is not resumed or marked successful.
3. Use **Close connection** and finish its review. It must remain closed until an explicit reopen, a new page load or a new USB connection. Automatic reopening must not immediately undo your close.
4. Disable the option and reload. The tablet should remain unopened until you choose or reopen it manually.
5. If multiple STU-540 tablets are authorized, the page asks you to use **Choose STU-540**, rather than selecting an arbitrary tablet. No connected authorized tablet means it waits for USB or initial authorization. Discovery failures are displayed without a repeating retry loop. Each opening attempt has a bounded readiness check of up to 30 seconds. USB reconnects and manual connections require 1.5 seconds of continuously ready status before applying settings; page loads check readiness immediately. Transient open/read failures are retried only within that attempt; permission and write failures stop it.

Automatic reopening waits for a running test and its review to end. Unplugging ends an active hardware operation, and a quick replug is processed after cleanup. Welcome preferences and image previews are restored before the initial automatic connection. The manually invoked chooser remains available for choosing a different tablet.

### Cold boot: remembered background and image

The [27 September 2026 physical retest](hardware-compatibility.md) confirmed stored recall and black-background readback after a USB cycle on firmware 1.8. Use the procedure below to repeat it and extend coverage.

The STU-540 background setting resets after power loss. These checks verify that the app restores it after boot, without relying on the firmware to persist it. Reload the page once before starting, then leave it open throughout the power-cycle checks.

1. In **Boot screen & background**, choose a distinctive color such as `#28664C`, leave **Restore applied color on connect** checked, and click **Apply color & clear display**. Confirm the whole tablet matches the solid preview. Apply once even if you used this color in an older version: it was not previously saved.
2. Enable **Automatically reopen authorized tablet** and disable **Automatically display image on connect**. Finish the active review, unplug USB completely, and reconnect it. Do not refresh the page or click Reopen. Expect a boot wait followed by the solid remembered color and a fresh confirmation step. The background readback must show `#28664C`. Confirm only after comparing all four corners.
3. Enable **Automatically display image on connect** with **Recall the saved image (fast)** (save/confirm an image first if necessary). Repeat the physical unplug/replug. After boot the saved image must match the preview and remain visible; restoring the background must not clear it. Device details must still report the remembered background. Do not save the image again. Confirm this separately.
4. Repeat with **Upload the prepared image**. Expect the prepared preview after the boot wait and transfer. Confirm that it remains visible after startup completes.
5. With welcome display off, disable **Restore applied color on connect**, finish the review, and power-cycle again. The app must not force the remembered color. Enable restore again, then use Reopen to check that the saved color was retained. Reload once to verify the background preference also survives a page reload.
6. During another boot wait, use **Stop current test**, or unplug again. No delayed image/background write should arrive from the stopped attempt. A fresh USB connection may start a new attempt only when automatic reopening is enabled.

Record firmware, time until the expected image/color appears, any unexpected display changes afterward, and any failure details in the report. Boot timing and visible output still require this physical verification; synthetic tests cannot prove them. The simulation's USB buttons now model transient read failures, reset, an early Ready response followed by a three-second boot, and loss of the volatile background. Its ROM slots survive simulated USB cycles within a page; they reset on page reload.

Expected: information offsets, screen dimensions and pressure maximum look plausible; no browser exception; no serial identity requested. Record descriptor lengths before investigating protocol errors.

## 2. Volatile settings and pen input

1. Click **Test ink off / on**. The first stage disables tablet ink: draw, finish and confirm that the tablet remains white while **Recorded pen input** shows your strokes. The second stage enables black tablet ink: draw, finish and compare both displays. Each stage waits for its own verdict. Original inking, rendering, handwriting-area and ink-style values are restored afterward.
2. Click **Test plaintext capture**. It uploads a white background and enables black ink over the full screen. Draw across the whole tablet, include light/heavy pressure and lift the pen between strokes. Click **Finish drawing** when ready; there is no countdown.
3. Compare the live preview against the tablet: top-left is top-left; X and Y are not swapped; pen-up does not draw a line to the next stroke.
4. Repeat near all four corners. Note any systematic edge offset.
5. The result should include contact samples and separate strokes. Confirm the appearance, then use **Download last capture SVG** and open it to compare the export with the preview.
6. If time/sequence reports are active, check that no loss indicators appear. A basic report has no sequence counter, so zero loss indicators alone do not prove no reports were lost.

Expected: raw pressure reaches sensible values, contact follows the firmware switch, hover does not become ink, and no malformed reports appear. A capture that contains no pen contact is reported as a failure to repeat, not a successful signature.

## 3. Display encoding and partial updates

1. Click **Test display formats**. For each advertised encoding the script uploads five vertical bars and a border, verifies completion, shows the same pattern in the preview, and waits indefinitely for your verdict.
2. For BGR24 and RGB565, the bars should be **red, green, blue, black, white** from left to right. A swapped red/blue pair indicates byte-order trouble.
3. Monochrome uses **black, white, black, white, black**, with the same black border. Both the reference and sent image are monochrome. Compare raw and zlib monochrome when both are advertised.
4. Record any difference in **Notes for this step**, then choose your verdict. A completed transfer only proves command success; it stays pending until you inspect it. The next image is sent only after your answer.
5. Click **Test partial update**. First confirm a completely white screen. Only a confirmed baseline advances to the patch. The second stage sends a 101 × 53 monochrome image to the rectangle starting at (17,23), ending at (118,76). The preview composites it onto the white background so you can check that all pixels outside the rectangle remain white.
6. Confirm the partial update separately. Odd-width row padding and rectangle endpoint semantics should not create shifted rows or stray pixels.

Expected: exact orientation and color order, no diagonal row shift, no unintended pixels outside the partial area, and no early success while blocks are still uploading. Timeouts are 120 seconds per transfer initially; record actual timing before tightening them.

## 4. Cancellation, unplug and connection recovery

Run these separately so the report makes the trigger clear:

1. Start a full image transfer, then click **Stop current test** before completion. Expect cancellation, an abandoned transaction, and a later upload that succeeds. Stopping while awaiting your verdict cancels the review; it cannot retroactively cancel an already completed upload.
2. Start another upload and unplug the USB cable during it. Expect an unplug event and a rejected operation. The library must never report this upload committed.
3. Reconnect and click **Reopen authorized tablet**. Upload again.
4. Start capture and unplug while drawing. The drawing wait should end and the check must not pass or return a successful `Signature`.
5. Reconnect again, then click **Test 10 reconnections**. With both welcome display and background restoration off, confirm unchanged tablet appearance after each cycle. Otherwise compare the configured image or solid-background preview. Check that pen events do not multiply by running another capture afterward.
6. Open the harness in a second tab and try to open the same tablet while the first owns it. Record the browser/OS result. It must not corrupt the first capture.
7. Test sleep/wake once, then close/reopen. Do not assume a previously negotiated encryption session is still valid.

If recovery fails, close the harness connection and unplug/replug the tablet. Record whether recovery needed that physical reset. No automatic hard reset, persistent mode change or data deletion is part of these tests.

## 5. RSA/AES encrypted input

The built-in provider requests RSA-2048, OAEP/SHA-1 and AES-256, matching the documented Wacom workflow. These are protocol settings, not freely interchangeable cryptographic choices.

The saved reports from 27 September 2026 record `ENCRYPTION: Session key has an unexpected length`. The provider now follows Wacom's native sample by taking the trailing AES key bytes from a potentially larger OAEP plaintext and clearing the temporary block. The correction passes crypto regression tests, but encrypted capture is not yet qualified on this tablet. Rebuild/reload before retesting; the guided step reports command failures before offering visual confirmation.

1. Upload the background before capture.
2. Click **Test encrypted capture**, wait for **Draw on the tablet**, draw a test scribble, then click **Finish drawing**.
3. Expect the negotiation to finish, decrypted samples to appear, and the result to report `rsa-aes` protection. Compare stroke shape and position on the tablet and browser, then give your verdict. The browser cannot visually prove encryption; the command checks establish the negotiated protection separately.
4. The normal plaintext capture test should still work after finishing the encrypted test, demonstrating `EndCapture` returned the tablet to ready.
5. Repeat encrypted capture twice. The implementation creates a new key exchange and session identifier each time.
6. During another encrypted capture, unplug the tablet. Expect capture failure and a fresh negotiation after reconnect.
7. If negotiation fails, record the error code and the descriptor/firmware information. Never change the harness to silently use plaintext. Inspect the pinned protocol evidence and compare a run with Wacom's native sample.

Automatic tests already check invalid session IDs, AES decoding and RSA key transport. Physical testing must confirm the wire negotiation, key-block lengths, asynchronous status behavior, and report `0x33` on this firmware. The device protocol does not provide general authenticated encryption for all host/device traffic.

## 6. ROM inspection without persistent changes

Click **Inspect ROM & mode**. It reads the current operation mode/image area, then performs atomic selector-plus-hash reads for slot 1 of signature, keypad, PIN, slideshow and message storage. Each check waits for your confirmation. Each slot gets its own result, and a failed read includes the report ID when available. The library waits for ROM readiness after selecting a hash; this was missing in the first hardware run.

The selector is a volatile protocol operation; this step does **not** upload or delete images. Record result codes for missing and occupied slots. Wacom documents result `1` as empty and `0` as occupied; confirm these on this firmware. Other nonzero results are errors, not permission to overwrite data.

## Stored welcome images

The **Welcome & stored images** panel is an explicit persistent provisioning workflow, separate from read-only ROM inspection. Follow the [full welcome-image procedure](stored-images.md#try-it-in-the-browser-harness): preview a local image, select a replaceable slideshow/message slot, save it, confirm completion, then separately confirm its recalled appearance. Occupied slots are protected unless you select the replacement checkbox.

To verify fast recall visibly, first display another test image, then use **Show stored image** and compare the saved preview. The result reports elapsed recall time including hash/status checks. For connection behavior, enable **Automatically display image on connect** in the Connect controls, select **Recall the saved image (fast)** and use **Reopen authorized tablet**. Also test **Upload the prepared image** separately; it intentionally retransfers pixels. Reloading remembers the enabled state, source and, for automatic uploads, the prepared image. Stored recall remains tied to the last saved image when you edit an unsaved image or slot choice.

For persistence, close the connection, finish its confirmation, unplug/replug, and reopen with stored recall selected. Do not upload again. Confirm the saved image appears and record the physical power cycle in the step notes. Keep the page open so the report remains intact. Storage persists in ROM according to the protocol; the hardware test must establish that on this tablet. Appearance is restored after the application reconnects.

The browser remembers the last saved reference and preview locally. The report excludes image bytes and filenames; it includes the slot and device-returned hash. Cancelling after a save has committed does not undo it. No slot is deleted automatically at the end of this workflow.

## 7. Advanced modes and persistent provisioning

These checks require an identified replaceable slot and the SDK's layout/key tables. They are deliberately not part of the automatic baseline. Do not erase an existing installation just to test the library.

For each workflow, save the pre-test operation mode, return to normal mode afterward, and preserve any pre-existing ROM content using vendor tools if needed. The public API cannot back up arbitrary ROM image bytes; a hash is not a backup.

| Workflow            | Setup and test                                                                                                                                       | Evidence to record                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Signature           | Provision normal/pressed images in an agreed slot; enable three buttons; configure their documented order; exercise cancel, clear and accept.        | Correct button events; button presses do not appear as signature ink; signing area is 800 × 431.       |
| Keypad              | Provision normal/pressed designs with a nine-key enable mask. Enable a subset, then select each enabled/disabled key.                                | Correct screen/key IDs; disabled keys do not select.                                                   |
| PIN pad             | Use dummy digits. Test minimum/maximum, masking, bypass, enter and cancel, then repeat with encrypted capture.                                       | Correct completion/error variants and special characters; never put actual PINs in the report.         |
| Slideshow           | Provision two replaceable slide slots; configure round-robin order and a two-second interval; then select a single slide.                            | Correct order, interval and return to normal.                                                          |
| Messages            | Show an agreed message slot from a supported workflow.                                                                                               | Actual message slot count and area; no speculative MessageBox operation mode.                          |
| Image deduplication | Upload an agreed image, read its device MD5, then call `uploadIfChanged` with that expected hash. Repeat after deliberately changing the image/hash. | No second upload for a match; stored hash checked after changes; confirm hash input for each encoding. |
| Deletion            | Only delete the explicitly agreed test slot.                                                                                                         | Other slot hashes remain unchanged. Do not use `deleteAll()` on a deployed tablet.                     |

Encrypted `EventData` must be checked separately from encrypted pen data. The historical browser reference has inconsistent signature-event offsets. StuSign validates the envelope's mode and session instead of accepting a guessed offset. Record any rejection and obtain an SDK-confirmed synthetic fixture before changing that decoder.

Communication defaults, hard resets, persistent brightness and UID provisioning require their own controlled test. The baseline harness does not modify them. Serial framing/CRC and the STU-540 conversion workflow are recorded in the [Mac helper evidence](macos-serial-to-hid.md#protocol-evidence). The [Web Serial adapter](web-serial.md) is implemented and has automated coverage; qualify its physical behavior separately from existing HID results.

## Boot screen and background color

The **Boot screen & background** controls read current values on connection. Apply changes the boot flag or background explicitly; **Restore applied color on connect** also reapplies a previously saved background after readiness. These changes are not reverted at the end of the check. See [the cold-boot checks](#cold-boot-remembered-background-and-image) for power-cycle restoration.

1. Check **Disable firmware boot screen**, then click **Apply boot screen setting**. Confirm that the flag reads back as disabled and the current display stays unchanged. The report does not count this as visual power-on verification.
2. Close the connection, confirm its completion, then unplug/replug the USB cable. Observe the power-on display before opening another app connection. Record whether the firmware logo is suppressed. To restore it, uncheck the option and apply again; qualify re-enabling with another separate power cycle.
3. Choose a background color in the picker or enter a `#RRGGBB` value. Click **Apply color & clear display**. It verifies the setting before clearing. Compare the resulting solid color with the preview, including all four corners and absence of old image/stroke remnants.
4. Click **Read current display settings** to confirm the retained flag and color without changing the display. Restoring white is an explicit background change to `#FFFFFF`. Stored-image contents are unaffected.

The [welcome-image guide](stored-images.md) includes the library API examples and covers image recall on app connection and clear-screen background restoration.

## Return the evidence

Click **Export test report**. Send the resulting JSON plus any screenshots of visual artifacts that are useful. Review free-text observations for sensitive information before sharing. A useful bug report includes:

- The exact failing check and error code.
- Model, firmware, OS/browser version, and report descriptors from the exported report.
- Whether the failure repeats after close/reopen and after unplug/replug.
- For images: format, dimensions, border/color observations and transfer duration.
- For capture: basic versus encrypted mode, sample/stroke/loss counts, and the trigger.

Do not include real signature samples, PINs, session keys or certificate private material. Use synthetic fixtures if a packet-level reproduction is needed.

## Graduation criteria

Mark an STU-540/firmware/browser/OS combination as verified only after baseline, all advertised encodings, partial updates, required encryption, cancellation and unplug/reopen pass. Record autonomous modes individually. A successful STU-540 run does not verify other STU models, serial transport or STU-541 TLS.

## Harness development checks

For UI verification without sending commands to a physical tablet, open `http://127.0.0.1:4173/?simulate=1`. A banner and report-level mode identify the simulation. Connect the simulated STU-540 and exercise the same confirmation flow; its capture supplies synthetic pen data. Encrypted capture is disabled in this mode. Remove the query parameter to return to real hardware.

**Connect simulated STU-540** remembers a synthetic permission for this browser. Use **Simulate USB unplug** and **Simulate USB reconnect** to exercise automatic reopening without touching hardware. The same mock retains ROM images during unplug/replug in one page; its ROM resets on page reload, so use automatic upload or leave welcome display off for a reload-only simulation check.

The guided UI was checked with simulated color/monochrome transfers, partial updates, manual capture completion, positive/negative/skipped verdicts, per-step notes, stopping during drawing/review, and restoration of ink settings. Automated harness tests cover the confirmation gate and reference images. These checks qualify the test interface, not the physical tablet's appearance.

The welcome-image UI was also checked in simulation: local PNG selection with transparency and letterboxing, display preview, save and separate recall confirmations, occupied-slot rejection, both connection actions, recalling an older saved image after preparing a different image, and restoration of the saved preview after reloading. No browser console errors occurred. Automated protocol tests assert that stored recall sends no image blocks; the packed-package consumer exercises the same API without DOM declarations. Physical ROM persistence and recall timing remain unqualified.

The automatic-display checkbox was verified across reloads for upload, stored recall and off, including recalling the last saved image after editing an unsaved slot choice. Boot enable/disable, flag readback, background application/clearing and subsequent read-only refresh were exercised in simulation with separate confirmations and the solid-color preview. Regression tests cover boot readback failure without reset, 24-bit/RGB565 background readback, and suppression of clearing when background verification fails. These do not qualify physical boot-logo suppression or background persistence across power cycles.

Cold-boot regression checks now cover transient transport-open/read failures, system reset, an early Ready response followed by boot/ROM busy, stable readiness, cancellation, disconnect and timeout. They assert background verification before image display, no clear after the welcome image, no pixel transfer for stored recall, and restoration after loss of the volatile color. Browser simulation verified the boot wait, solid-color preview/readback after USB reconnection, saved color after a page reload, stored-image recall after a simulated power cycle, opting out (the reset white background remained), and stopping during boot. These checks cover application behavior; the physical STU-540 must still be power-cycled using the procedure above.
