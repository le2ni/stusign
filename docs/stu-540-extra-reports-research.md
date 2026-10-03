# Research into the 37 additional STU-540 reports

Research date: **27 September 2026**. Device evidence: **STU-540, firmware 1.8**, USB vendor/product `056a:00a8`, from the existing macOS/Chrome hardware reports. This investigation used public source code, static inspection of vendor artifacts, and saved descriptor evidence. **No additional report was sent to the tablet.**

## Findings

The 37 entries are **HID feature-report IDs outside the public STU catalogue**, not necessarily 37 independent product features. Several reports can implement one operation, and a descriptor does not establish a report's meaning or permitted read/write direction.

The strongest new finding is a probable **Wacom flash-loader/firmware-maintenance interface**:

- **15 IDs have matching names in fwupd's Wacom USB updater.** Nine also have exact fixed payload-size matches; three fit its variable-size formats; three have only enum-level evidence in that implementation. These are strong research candidates, not verified STU-540 commands.
- **22 IDs still have no established STU-540 meaning.** Seven are also present, anonymously and with matching sizes, in Wacom's STU-430V example. Six more sit in the same numeric region as the probable flash-loader commands. Neither observation supplies a payload definition.
- There is also **one uncatalogued input report, `0xb1`, with 39 payload bytes**. It is separate from the 37 feature reports.

The [machine-readable inventory](research/stu-540-extra-reports.json) records every ID, observed size, candidate name, evidence level and source. None is marked as behaviorally verified on the STU-540.

## Count and evidence boundaries

The retained descriptor snapshot contains only model, firmware and report lengths. Personal run reports have been removed from the repository. Comparing the after recording with `ReportId` in the current catalogue gives:

| Inventory                                                  |  Count |
| ---------------------------------------------------------- | -----: |
| Public IDs in StuSign's catalogue, across all report types |     57 |
| Feature IDs advertised by this tablet                      |     79 |
| Advertised feature IDs also in the public catalogue        |     42 |
| Advertised feature IDs outside that catalogue              | **37** |

The subtraction is **79 − 42**, not 79 − 57. Some public IDs are input/serial reports or are not advertised by this device. The public reports with unverified layouts are a different work list: seven at this research snapshot, reduced to four by the subsequent Web Serial implementation. See the [current public inventory](support-matrix.md#public-report-inventory). The hardware snapshot and its 37 extra IDs are unchanged.

All lengths and offsets in this document **exclude the report-ID byte**. Wacom's `query` output and fwupd's native buffers generally include it. Sources: [saved descriptor inventory](research/stu-540-hid-report-sizes.json), [public catalogue](support-matrix.md#public-report-inventory), [Wacom query source](https://github.com/Wacom-Developer/stu-sdk-samples/blob/0749f46dd0b3d6f37c25adbbc7212c441a875af0/samples/cpp/query.cpp#L354).

Evidence labels used below:

- **F — fixed-size candidate:** another Wacom protocol implementation provides a name, actual operation and matching fixed length. Applying it to STU-540 remains an inference.
- **V — variable-format candidate:** name and implemented format exist elsewhere; this descriptor's capacity fits that format. Actual parameters have not been read.
- **N — name-only candidate:** upstream enumerates the ID, but its inspected device implementation does not exercise that command.
- **U — unresolved:** no defensible semantic assignment for this tablet. A cross-model observation or independent implementation can be a lead without resolving the report.

## The flash-loader connection

The [upstream fwupd plugin description](https://github.com/fwupd/fwupd/blob/5ca4290924f2a51bf9e624f149ea41b58a27b0bc/plugins/wacom-usb/README.md) says its Wacom HID flashing implementation was developed using documentation supplied by Wacom. Its [report enumeration](https://github.com/fwupd/fwupd/blob/5ca4290924f2a51bf9e624f149ea41b58a27b0bc/plugins/wacom-usb/fu-wacom-usb.rs#L18) assigns the names below. The [device implementation](https://github.com/fwupd/fwupd/blob/5ca4290924f2a51bf9e624f149ea41b58a27b0bc/plugins/wacom-usb/fu-wacom-usb-device.c#L162) supplies the layouts.

Two independent size calculations are especially informative:

```text
0xd9: 2560 payload bytes = 256 × 10-byte flash-descriptor entries
0xda: 1028 payload bytes = 4-byte header + 256 × 4-byte checksums
0xd2:  260 payload bytes = 4-byte address + 256 data bytes
```

This is much stronger than assigning names from ID adjacency alone. However, **256 is a compatible table capacity, not a measured count of populated flash blocks**. The updater normally obtains block count and transfer sizes from `0xd8`. We have not read that report from this tablet.

The inspected [fwupd device list](https://github.com/fwupd/fwupd/blob/5ca4290924f2a51bf9e624f149ea41b58a27b0bc/plugins/wacom-usb/wacom-usb.quirk) does **not** list STU-540/product `00a8`. Its other IDs also demonstrate limits to compatibility: `0xcb`, `0xcd` and `0xe4` exist in the updater's enumeration but are absent from this tablet's saved feature map. Do not assume the complete updater sequence, loader exit route or firmware format works on the STU-540.

### All 21 reports in the probable loader region

The first column is observed hardware evidence. Names, directions and layouts are **candidate interpretations from other source code**, not new public StuSign APIs. GET/SET below refer to HID feature transactions in that source.

| ID     | Payload bytes | Candidate meaning                | Level | Evidence and remaining question                                                                                                                             |
| ------ | ------------: | -------------------------------- | :---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0xcc` |             2 | SwitchToFlashLoader              |   F   | Updater sends a two-byte SET to change device mode. STU entry/exit behavior is unverified.                                                                  |
| `0xd0` |             8 | Unknown                          |   U   | Independent tool maps logical command 0 here, but supplies no semantic name or verified STU layout.                                                         |
| `0xd1` |           260 | ReadBlockData                    |   N   | Upstream labels it GET; no read implementation in the inspected fwupd device file. Another tool assumes a four-byte prefix plus data.                       |
| `0xd2` |           260 | WriteBlock                       |   V   | Updater SET format: little-endian 32-bit address, then a device-reported number of data bytes. Fits a 256-byte data capacity here.                          |
| `0xd3` |             4 | EraseBlock                       |   F   | Updater SET carries a little-endian 32-bit address. This is a potential flash erase operation.                                                              |
| `0xd4` |             4 | SetReadAddress                   |   N   | Direction evidence conflicts: fwupd's enum comment says GET; another implementation sends SET. Do not resolve this from the name.                           |
| `0xd5` |             4 | GetStatus                        |   F   | Updater GET returns a little-endian 32-bit loader status word. Distinct from ordinary STU status `0x03`.                                                    |
| `0xd6` |             4 | UpdateReset                      |   F   | Updater issues a four-byte SET during firmware-update processing. Other software uses a different payload for entry; do not treat it as ordinary STU Reset. |
| `0xd7` |             8 | WriteWord                        |   N   | Upstream names a SET operation, but has no exercised serializer here. Address/value field split remains unverified.                                         |
| `0xd8` |            12 | GetParameters                    |   F   | Updater GET parses six little-endian 16-bit values; detailed candidate offsets below. Best first validation target.                                         |
| `0xd9` |          2560 | GetFlashDescriptor               |   V   | Updater GET parses ten-byte entries describing address, extent and write granularity/protection. Capacity fits 256 entries.                                 |
| `0xda` |          1028 | GetChecksums                     |   V   | Updater GET parses a four-byte version header followed by 32-bit block checksums. Capacity fits 256 entries.                                                |
| `0xdb` |             6 | SetChecksumForBlock              |   F   | Updater SET contains a little-endian 16-bit block index and 32-bit checksum. Mutates update bookkeeping.                                                    |
| `0xdc` |             2 | CalculateChecksumForBlock        |   F   | Updater SET selects a little-endian 16-bit block index and triggers calculation. It is not a passive checksum read.                                         |
| `0xdd` |             4 | Unknown                          |   U   | Independent tool maps logical command 14 here without establishing meaning.                                                                                 |
| `0xde` |             4 | WriteChecksumTable               |   F   | Updater sends a four-byte SET to commit checksum bookkeeping. This is part of updating flash.                                                               |
| `0xdf` |            34 | Unknown                          |   U   | Independent tool maps logical command 16 here. Size alone does not establish a hash, key or identity layout.                                                |
| `0xe0` |             1 | Unknown                          |   U   | Independent tool maps logical command 17 here. A byte is not evidence of a Boolean setting.                                                                 |
| `0xe1` |             2 | Unknown; checksum-selection lead |   U   | Independent tool calls logical command 18 a checksum-block selector and sends a 16-bit index. No STU trace or vendor definition corroborates it.            |
| `0xe2` |             2 | GetCurrentFirmwareIdx            |   F   | Updater GET returns a little-endian 16-bit firmware index. This is not evidence of a selected image slot.                                                   |
| `0xe3` |             2 | Unknown                          |   U   | Independent tool maps logical command 20 here without establishing meaning.                                                                                 |

The independent implementation is [WacomFirmwareTool's command map](https://github.com/telecomadm1145/WacomFirmwareTool/blob/160f994426d76d66bdad5897f9bb158e992844ec/src/WacomFirmwareTool/Wacom/WacomProtocol.cs#L53) and [firmware client](https://github.com/telecomadm1145/WacomFirmwareTool/blob/160f994426d76d66bdad5897f9bb158e992844ec/src/WacomFirmwareTool/Wacom/WacomFirmwareClient.cs). It is a **lead**, not a second vendor specification: its README explicitly says many names were cross-checked against fwupd, and the inspected material supplies no STU-540 packet captures. Its numeric mappings therefore do not increase the count of established names beyond 15.

### Candidate parameter and table layouts

These offsets are suitable for an **offline decoder proposal**. They are not permission to send loader commands or evidence that this tablet returns these fields.

| Report | Candidate payload interpretation from fwupd                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0xd8` | Six `u16le` fields: loader version at 0; read transfer size at 2; word-write size at 4; block-write size at 6; flash-block count at 8; configuration at 10.                         |
| `0xd9` | Repeated ten-byte records: `u32le` start address at 0; `u32le` block length at 4; `u16le` write size/flags at 8. Upstream interprets bit 15 of that last field as write protection. |
| `0xda` | `u32le` updater version at 0, followed by one `u32le` checksum per block.                                                                                                           |
| `0xd5` | `u32le` status; upstream defines writing, erasing, write-error, erase-error and write-protection bits.                                                                              |
| `0xe2` | `u16le` current firmware index. Valid index range on STU-540 is unknown.                                                                                                            |

The fwupd checksum workflow uses its own firmware-update bookkeeping. These values must not be confused with the MD5-sized identity returned by STU ROM image report `0x96`. Likewise, a flash descriptor is not an image-slot directory. [Updater implementation](https://github.com/fwupd/fwupd/blob/5ca4290924f2a51bf9e624f149ea41b58a27b0bc/plugins/wacom-usb/fu-wacom-usb-device.c#L251), [existing STU wire decisions](protocol-evidence.md#concrete-wire-decisions).

## The remaining 16 feature reports

Seven have independent **STU-family presence/length evidence**, but still no names. Wacom publishes a `query` result for STU-430V firmware 1.04 showing decimal IDs 160, 162, 163, 171, 178, 180 and 181. Subtracting the included report-ID byte gives exact matches with this STU-540. Its published query source prints supported entries numerically when no descriptive name is available. [Wacom STU-430V example](https://developer-support.wacom.com/hc/en-us/articles/9354494770967-STU-Serial-Connection), [query loop](https://github.com/Wacom-Developer/stu-sdk-samples/blob/0749f46dd0b3d6f37c25adbbc7212c441a875af0/samples/cpp/query.cpp#L354).

| ID     | Payload bytes | Additional evidence                                                      | Result                                                             |
| ------ | ------------: | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `0x60` |             1 | No matching definition found in the inspected STU references or updater. | U: unknown purpose, direction and value domain.                    |
| `0xa0` |             4 | STU-430V lists decimal 160 with total length 5.                          | U: shared ID/length; no semantic name.                             |
| `0xa2` |             4 | STU-430V lists decimal 162 with total length 5.                          | U: shared ID/length; no semantic name.                             |
| `0xa3` |            16 | STU-430V lists decimal 163 with total length 17.                         | U: shared ID/length; no semantic name.                             |
| `0xab` |            11 | STU-430V lists decimal 171 with total length 12.                         | U: shared ID/length; no semantic name.                             |
| `0xad` |            12 | Descriptor evidence only.                                                | U: no verified field layout.                                       |
| `0xae` |             1 | Descriptor evidence only.                                                | U: no verified enum or flag meaning.                               |
| `0xaf` |             1 | Descriptor evidence only.                                                | U: no verified enum or flag meaning.                               |
| `0xb0` |             1 | Descriptor evidence only; adjacent input `0xb1` also exists.             | U: adjacency does not establish an input-mode selector.            |
| `0xb2` |             2 | STU-430V lists decimal 178 with total length 3.                          | U: shared ID/length; no semantic name.                             |
| `0xb4` |             2 | STU-430V lists decimal 180 with total length 3.                          | U: shared ID/length; no semantic name.                             |
| `0xb5` |            10 | STU-430V lists decimal 181 with total length 11.                         | U: shared ID/length; no semantic name.                             |
| `0xb6` |             2 | Descriptor evidence only.                                                | U: no verified field layout.                                       |
| `0xb7` |           100 | Descriptor evidence only.                                                | U: no evidence that this is an image buffer or calibration table.  |
| `0xb8` |             2 | Descriptor evidence only.                                                | U: no verified field layout.                                       |
| `0xb9` |            13 | Descriptor evidence only.                                                | U: equal size to another report would not establish equal meaning. |

These reports could include internal configuration or diagnostics, but the inspected sources do not justify assigning those categories individually. In particular, do not label `0xa3` a cryptographic key merely because it has 16 bytes, or label the one-byte reports persistent settings.

### Additional input report

The saved `device.inputReports` map contains nine IDs. Eight are in the public catalogue; **`0xb1` is absent and has a 39-byte payload**. There is no corresponding `0xb1` feature report in this recording. Its presence does not establish that the firmware emits it in the current operating mode. Existing descriptor data supplies neither sample bytes nor a decoder. Keep it as metadata until a source or an observed, understood workflow establishes its meaning.

## Next verification work

### 1. Resolve source evidence first

Inspect the complete current STU SDK's C++ headers, serializers and report-name/direction tables, then compare its definitions against this inventory. The public Wacom repository supplies samples, not that complete SDK. Wacom's [API guide](https://developer-docs.wacom.com/docs/stu-sdk/windows-sdk/api-guide/) places the full references inside the SDK download.

For unresolved IDs, useful evidence is a vendor command definition or a capture of a named utility performing a known operation. A capture should include the starting mode, firmware version, request/response lengths, status transitions, and observed effect. A generic list of opaque bytes cannot establish which writes are safe or persistent.

A focused vendor question is: **Does STU-540 firmware 1.8 use the Wacom flash-loader definitions for `0xcc` and `0xd0`–`0xe3`, and is there a supported boot-resource or persistent initial-display provisioning command? What are the definitions of `0x60`, the advertised `0xa0`–`0xb9` reports and input `0xb1`?** No support request has been sent.

### 2. Validate a small set of source-backed GET candidates on the Mac

This is a proposed diagnostic experiment, **not executed in this research**. It should use a dedicated connection with no automatic appearance changes or active signing capture. Ordinary identity and status reads must succeed first.

| Step | Action                                                                                                | Acceptance / stop condition                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Record model, firmware, normal `0x03` status, displayed image and descriptor map.                     | Must match the intended tablet; preserve the visible image as the baseline preview.                                                                                                                                     |
| B    | Make one bounded GET of candidate parameters `0xd8`, without entering a loader.                       | Preserve raw bytes and actual length. Decode only an exact 12-byte normalized payload. An error or implausible result stops the experiment.                                                                             |
| C    | If B is coherent, inspect reported counts and sizes against descriptor capacities.                    | For the observed maps: read/block capacities can accommodate at most 256 data bytes; ten-byte descriptor and checksum capacities allow at most 256 entries. These are bounds, not defaults to insert into missing data. |
| D    | Read candidate loader status `0xd5` and firmware index `0xe2` individually.                           | Record raw and interpreted values; no SET transaction or automatic recovery command. Success strengthens the mapping without proving writable support.                                                                  |
| E    | Only if parameters justify it, read `0xd9` and `0xda` once and decode the reported number of entries. | Validate bounds, non-overflowing address extents, coherent write sizes and unused trailing capacity. Retain unexpected bytes without guessing their meaning.                                                            |
| F    | Read ordinary STU status again; close the diagnostic connection.                                      | User confirms the tablet still shows the baseline image and the normal app reconnects. A screen change is a failure, not an automatic pass.                                                                             |

Follow the hardware harness's review workflow: before the experiment, show **“This test reads device metadata. The tablet should keep showing the image in this preview.”** Afterwards offer a manual correct/incorrect verdict. No synthetic image update or automatic visual confirmation is appropriate for this test.

Do not expand a failed GET into a sweep of all 37 reports. Do not automatically send `0xcc`/`0xd6` to make a read succeed. Do not use `0xd4` until its direction is resolved, or `0xdc` as if it were a passive read. A timeout should terminate the diagnostic sequence, not launch another potentially overlapping request. The [low-level protocol API](api.md#low-level-protocol--stusignprotocol) deliberately requires catalogue direction metadata; keep that protection in the public library and use any future research harness as a separate, tightly scoped tool.

### 3. Turn only validated behavior into library APIs

The immediate deliverable is an evidence inventory, not 37 stubs. After source and hardware validation:

- Read-only loader metadata could become an explicit diagnostics facility with model/firmware qualification, exact decoders and recorded fixtures.
- Application-level STU settings found in the remaining reports should receive typed APIs only after ranges, persistence and side effects are established.
- Firmware maintenance would need its own lifecycle, recovery design and supported images. It should not run during automatic reconnect or be presented as ordinary background-image storage.

## Sources inspected and limits

| Source                                                              | What was established                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing STU-540 before/after JSON recordings                       | Exact advertised lengths, stable across the recorded reconnect; no additional command-response semantics.                                                           |
| Wacom public SigCaptX wrapper and historical browser implementation | Public STU report catalogue, normal display/ROM paths and namespace separation. None names the additional 37.                                                       |
| Wacom C++ query sample and published STU-430V output                | Anonymous shared report IDs and correct report-ID-inclusive size comparison.                                                                                        |
| Public Wacom `wgssSTU.dll` from the SxS sample, version 2.4.0.0     | Static readable strings/type metadata only; no additional report names found. This is an old binary, not an audit of the current complete SDK. It was not executed. |
| Previously downloaded Wacom `query.exe` and `serial2hid.exe`        | Static strings/type-name inspection supplied no additional semantic names. This is not a complete disassembly-based proof of absence.                               |
| fwupd at the pinned revision below, plus its 1.2.2 header           | Fifteen overlapping named loader reports. The older header contains the same relevant names and the same `0xd4` direction comment.                                  |
| Independent WacomFirmwareTool source                                | Additional numeric command-map leads and the `0xe1` selector claim; no STU-specific verification. Not executed.                                                     |
| `bentiss/wacom-fw`, `fourks/cte450-homebrew`                        | Other Wacom work, but no applicable STU-540 mapping: the former models device descriptions, the latter targets CTE-450 firmware/RAM behavior.                       |
| fwupd's `wacom-raw` protocol                                        | A different firmware-loader report namespace; its `0x02`/`0x07`/`0x08` definitions do not identify this tablet's missing reports.                                   |

No firmware dump, image-address search, loader entry, erase, write or new power-cycle experiment was performed. The complete current SDK source/reference was unavailable for this investigation.

### Reproducibility

The [JSON inventory](research/stu-540-extra-reports.json) includes hashes and pinned URLs for the decisive artifacts. Vendor source and binaries are not bundled with StuSign.

| Artifact                               | Revision / SHA-256                                                 |
| -------------------------------------- | ------------------------------------------------------------------ |
| StuSign catalogue at research time     | `fd1c66580507cfc967897a1723d65bdbfa189a6cc2ad5a816eff65864b217e00` |
| fwupd revision                         | `5ca4290924f2a51bf9e624f149ea41b58a27b0bc`                         |
| fwupd report enum                      | `c1f8e2026345bc7e868b2e477fb94946316f6a631ada4a08c2988fdc8cccb4f4` |
| fwupd device implementation            | `dee28fdf4dbb79abc0e4e9b8654052d5943cfe68a3cddbfbec78e430d25770e5` |
| Independent WacomFirmwareTool revision | `160f994426d76d66bdad5897f9bb158e992844ec`                         |

To recalculate the feature inventory without connecting a tablet, run this from the repository root:

```sh
python3 - <<'PY'
import json
import re
from pathlib import Path

recording = json.loads(Path(
    'docs/research/stu-540-hid-report-sizes.json'
).read_text())
catalogue = Path('src/protocol/catalogue.ts').read_text().split('} as const;', 1)[0]
public = {int(value, 16) for value in re.findall(r': (0x[0-9a-f]+)', catalogue)}
advertised = {int(key): size for key, size in recording['featureReports'].items()}
extra = {key: size for key, size in advertised.items() if key not in public}
inventory = json.loads(Path('docs/research/stu-540-extra-reports.json').read_text())
expected = {int(row['id'], 16): row['payloadBytes'] for row in inventory['reports']}
assert extra == expected, 'Evidence inventory differs from the recording/catalogue'
print(f'{len(advertised)} feature IDs; {len(extra)} outside the public catalogue')
for report_id, size in sorted(extra.items()):
    print(f'0x{report_id:02x}: {size} payload bytes')
PY
```

If a future catalogue adds validated IDs, this check should flag the difference so the research snapshot can be revised deliberately.
