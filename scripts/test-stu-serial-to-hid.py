"""Offline regression checks; never open a device. Run with python3."""

import contextlib
import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "stu_serial_to_hid", Path(__file__).with_name("stu-serial-to-hid.py")
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class FramingTests(unittest.TestCase):
    def test_crc_check_value(self):
        self.assertEqual(helper.crc16(b"123456789"), 0xBB3D)

    def test_converter_wire_vectors(self):
        # Independently checked against the vendor utility's CRC table and packing.
        for report, frame in [
            ("80 08", "c0 05 40 02 0c 00 30"),
            ("80 0c", "c0 05 40 03 0c 1c 28"),
            ("0c 01 00", "c0 06 06 00 20 0c 0c 4c"),
            ("04 01", "c0 05 02 00 38 30 00"),
        ]:
            report, frame = bytes.fromhex(report), bytes.fromhex(frame)
            self.assertEqual(helper.encode_frame(report), frame)
            self.assertEqual(helper.FrameParser().feed(frame), [report])

    def test_unchecked_device_acknowledgement(self):
        self.assertEqual(
            helper.FrameParser().feed(bytes.fromhex("80 03 40 40 00")),
            [bytes.fromhex("81 00")],
        )

    def test_partial_and_concatenated_frames(self):
        frames = bytes.fromhex("c0 05 40 02 0c 00 30 80 03 40 40 00")
        for boundary in range(len(frames) + 1):
            parser = helper.FrameParser()
            self.assertEqual(
                parser.feed(frames[:boundary]) + parser.feed(frames[boundary:]),
                [bytes.fromhex("80 08"), bytes.fromhex("81 00")],
            )

    def test_resynchronize_after_noise_and_truncated_frame(self):
        parser = helper.FrameParser()
        self.assertEqual(
            parser.feed(bytes.fromhex("01 02 c0 05 00 80 03 40 40 00")),
            [bytes.fromhex("81 00")],
        )

    def test_reject_corruption_and_padding(self):
        for frame in ["c0 05 41 02 0c 00 30", "80 03 40 40 01"]:
            with self.assertRaises(ValueError):
                helper.FrameParser().feed(bytes.fromhex(frame))


class FakeSerial:
    def __init__(self, model=b"STU-540", mode=2, readback=1, reject=False):
        self.model, self.mode, self.readback = model, mode, readback
        self.reject = reject
        self.writes = []

    def get(self, report_id, length):
        if report_id == 0x08:
            return b"\x08" + self.model.ljust(9, b"\0") + b"\x01\x08" + bytes(5)
        mode = self.readback if self.writes else self.mode
        return b"\x0c" + mode.to_bytes(2, "little")

    def set(self, report):
        self.writes.append(report)
        if self.reject:
            raise RuntimeError("Rejected")

    def send(self, report):
        self.writes.append(report)

    def receive(self, report_id, length):
        return b"\x81\x00"


class ModeSwitchTests(unittest.TestCase):
    def test_query_has_no_settings_writes(self):
        serial = FakeSerial()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(helper.identify(serial), 2)
        self.assertEqual(serial.writes, [])

    def test_identity_and_mode_gate_all_writes(self):
        for serial in [FakeSerial(model=b"OTHER"), FakeSerial(mode=0)]:
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                helper.switch_to_hid(serial)
            self.assertEqual(serial.writes, [])

    def test_rejection_or_failed_readback_prevents_reset(self):
        for serial in [FakeSerial(reject=True), FakeSerial(readback=2)]:
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                helper.switch_to_hid(serial)
            self.assertEqual(serial.writes, [bytes.fromhex("0c 01 00")])

    def test_successful_sequence(self):
        serial = FakeSerial()
        with contextlib.redirect_stdout(io.StringIO()):
            helper.switch_to_hid(serial)
        self.assertEqual(serial.writes, [bytes.fromhex("0c 01 00"), bytes.fromhex("04 01")])


if __name__ == "__main__":
    unittest.main()
