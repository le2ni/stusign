# Switch an STU-540 from serial to HID on macOS

**Verified on a physical STU-540, firmware 1.8, on an Apple Silicon Mac on 27 September 2026.** Windows and the native Wacom SDK were not needed. The tablet acknowledged the mode change, returned HID in a readback, acknowledged the restart, and reappeared as USB HID `056a:00a8`.

The repository and npm package include a Python standard-library utility: [`scripts/stu-serial-to-hid.py`](../scripts/stu-serial-to-hid.py). It is a maintenance tool for the STU-540's USB virtual COM connection at **128000 baud, 8N1**. The helper does not support the optional physical RS-232 cable or other models. To stay in COM mode and connect directly from the browser, use the [TypeScript Web Serial transport](web-serial.md) instead; conversion is needed only when choosing WebHID.

## Run it

Close other applications using the tablet. The commands below run from a StuSign repository checkout. After an npm installation, use `node_modules/stusign/scripts/stu-serial-to-hid.py` as the script path instead. Python 3 is needed only for this maintenance utility. First, list callout ports:

```sh
ls /dev/cu.usbserial-*
```

Use the actual port from the listing in place of `/dev/cu.usbserial-EXAMPLE` below. The suffix depends on the USB port and Mac. If several ports appear, identify the tablet's port by unplugging and reconnecting it. Use the `/dev/cu.*` callout device.

First query its identity and startup mode; this command changes no tablet settings:

```sh
python3 scripts/stu-serial-to-hid.py --port /dev/cu.usbserial-EXAMPLE
```

Expected: `Identified STU-540` and `Startup mode: serial (2)`. To save HID as the startup mode and restart:

```sh
python3 scripts/stu-serial-to-hid.py --port /dev/cu.usbserial-EXAMPLE --switch
```

The script refuses settings writes unless the model is exactly `STU-540` and the current default mode is recognized. It waits for a successful setting acknowledgement and verifies the saved value before sending a hardware restart. The persistent change is the communication default; it does not erase ROM images or perform a factory reset. The restart interrupts any current capture.

The serial port should disappear and **LCD Signature Pad STU-540** should appear under **System Information → USB**, with vendor ID `0x056a` and product ID `0x00a8`. It should also appear as an `IOHIDDevice`. Connect using `createWebHidManager()` in your application. From a repository checkout, you can also run the hardware app:

```sh
pnpm hardware
```

Open `http://127.0.0.1:4173` in Chrome or Edge and click **Choose STU-540**. Continue with the [hardware test guide](stu-540-hardware-test.md). USB enumeration alone does not qualify pen input, image transfer or encryption.

## If a step fails

- **Port absent:** the tablet may already be in HID mode. Check System Information. Recheck the cable and port suffix before running the script.
- **Port busy or access denied:** close any application holding the port. The script requests exclusive access while it runs.
- **Identity timeout:** no settings command has been sent. Confirm that this is the tablet's USB virtual COM port. The baud rate is fixed at 128000; do not use the physical RS-232 kit with this helper.
- **Setting rejected or readback failed:** the script stops before restarting. Its output distinguishes an acknowledged setting from an unverified one.
- **Restart acknowledgement absent:** a reset can disconnect serial before a reply is received. Check USB enumeration. If HID was saved but the device has not reappeared, unplug and reconnect its USB cable.

No driver installation was necessary on the tested Mac: its FTDI virtual COM device was already exposed. That observation does not establish driver availability on every macOS installation.

## Protocol evidence

Wacom's [STU serial connection article](https://developer-support.wacom.com/hc/en-us/articles/9354494770967-STU-Serial-Connection) documents 128000 baud for USB virtual COM, the conversion workflow and the official [serial utilities archive](https://cdn.wacom.com/u/marketplace/INK-SDK/faqs/stu/serial-connection.zip). The framing and command sequence below were established by static inspection of `serial2hid.exe` from that archive. The executable was not run, copied into this repository or required at runtime.

Artifact identifiers:

- `serial-connection.zip`, SHA-256: `bada79647eb68a09aacf5bd66378e369ad27db8979c3558e003192916d0f94e4`.
- `serial2hid.exe`, 465408 bytes, SHA-256: `ca685f11c2cfcd5d73dbf7e2a8148cb45863c0e6c9036d9f9855dd399f08ebf5`.

The utility's conversion routine reads Information, writes DefaultMode `1`, then writes Reset `1`. These full reports include the report ID:

| Operation        | Report bytes | CRC-protected serial frame |
| ---------------- | ------------ | -------------------------- |
| Read Information | `80 08`      | `c0 05 40 02 0c 00 30`     |
| Read DefaultMode | `80 0c`      | `c0 05 40 03 0c 1c 28`     |
| Save HID default | `0c 01 00`   | `c0 06 06 00 20 0c 0c 4c`  |
| Hardware restart | `04 01`      | `c0 05 02 00 38 30 00`     |

The Mac helper adds a DefaultMode read before changing settings and another before restarting. A successful setter response is report `81 00`; the unchecksummed wire representation is `80 03 40 40 00`.

Frame rules established from the converter:

1. The first header byte has bit 7 set, bit 6 indicating CRC presence, and six high length bits. The second byte contains seven low length bits. The length counts packed payload bytes after the two-byte header.
2. The report, including its ID, is followed by an optional CRC-16/ARC in little-endian order: reflected polynomial `0xa001`, initial value zero, no final XOR. CRC covers only the report bytes.
3. That byte stream is packed MSB-first into seven-bit units, with zero padding in the final unit. Payload bytes consequently never have bit 7 set.
4. Reads send report `80 <requested ID>` and await that report ID. Writes await report `81 <result>`; zero means success. A new header provides a resynchronization boundary.

Static inspection landmarks in this exact executable: conversion at `0x40b852`, DefaultMode construction at `0x4040a0`, Reset at `0x403fb0`, GetReport at `0x402c20`, SetResult handling at `0x402c50`, frame construction at `0x404210`, seven-bit packing at `0x4043d0`, CRC at `0x404560`, and response parsing at `0x401d60`.

Offline checks cover fixed wire vectors, the CRC check value, partial/concatenated frames, resynchronization, corruption rejection and the identity/readback gates:

```sh
python3 scripts/test-stu-serial-to-hid.py
```

The successful physical conversion verifies this narrow maintenance workflow on one STU-540/firmware/Mac combination. The [TypeScript Web Serial transport](web-serial.md) now implements continuous input, request correlation, deadlines and cancellation handling. Its broader browser/hardware qualification remains separate from this maintenance result.
