# Hardware compatibility evidence

This is an aggregate engineering summary. Personal run reports, signature recordings, serial numbers, machine paths and browser storage are not part of the repository. A recorded successful command is not counted as a visual pass without an operator's confirmation.

## Qualified observations

| Device / environment                           | Observed result                                                                                                           | Boundary                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| STU-540 firmware 1.8, macOS, Chrome, WebHID    | Connection; full-screen mono, mono-zlib, RGB565 and BGR24; odd-width partial update; tablet inking; plaintext pen capture | Visual outcomes confirmed; applies to this model/firmware combination                                  |
| Same device, USB power cycle                   | Authorized reopen, stored welcome-image recall matching preview, background reapplication and readback                    | Restoration requires the application to reconnect                                                      |
| Same device, Web Serial USB COM at 128000 baud | Model and capability reads, report-size discovery, background readback, stored-image recall matching preview              | Continuous/encrypted input, full upload verification and repeated serial reconnects remain unqualified |
| Same device, macOS native maintenance          | HID/serial default-mode readback and re-enumeration                                                                       | Does not qualify a general native SDK or other models                                                  |

## Retained protocol fixtures

The [HID report-size snapshot](research/stu-540-hid-report-sizes.json) contains only model, firmware and report lengths. It is sufficient to reproduce the [37 additional-report inventory](stu-540-extra-reports-research.md).

The source test fixture `tests/fixtures/stu-540-fw1.8-serial-report-sizes.bin` contains only the 512-byte report-size collection, with no unique device ID or input samples. SHA-256: `d302005ef4064d7b98d3328a97df183916f39c17261d1915580338d3ec888204`. It advertises 74 nonzero entries, with full-report sizes Status=5, Information=17, Capability=17, ImageDataBlock=2560, timed pen=11, ROM display=3 and collection=512. This is a public-protocol conformance fixture, not a session report.

## Still required before broad production claims

Qualify encrypted capture on physical tablets; serial display, continuous input and cancellation; operating modes and ROM provisioning; multiple reconnect/power cycles; browser/OS combinations; every other model; and application-specific handling of input loss. See the [support matrix](support-matrix.md), [guided hardware procedure](stu-540-hardware-test.md) and [serial qualification procedure](web-serial.md#physical-stu-540-checks-still-to-run).

The presence of a model profile or report ID is not a certification claim. Software tests cannot establish physical behavior.
