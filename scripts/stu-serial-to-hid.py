#!/usr/bin/env python3
"""Query an STU-540's USB virtual COM port on macOS; optionally switch to HID.

Uses Python's standard library. Default: query only. See docs/macos-serial-to-hid.md
for protocol evidence and scope. This is a maintenance utility, not a serial backend.
"""

import argparse
import fcntl
import os
import select
import struct
import sys
import termios
import time


def crc16(data):
    """CRC-16/ARC: reflected 0xA001, initial 0, no final XOR."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return crc


def encode_frame(report):
    data = report + struct.pack("<H", crc16(report))
    packed = bytearray()
    accumulator = bits = 0
    for byte in data:
        accumulator = (accumulator << 8) | byte
        bits += 8
        while bits >= 7:
            bits -= 7
            packed.append((accumulator >> bits) & 0x7F)
        accumulator &= (1 << bits) - 1
    if bits:
        packed.append(accumulator << (7 - bits))
    size = len(packed)
    if size > 0x1FFF:
        raise ValueError("Serial frame is too large")
    return bytes([0xC0 | (size >> 7), size & 0x7F]) + packed


class FrameParser:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        reports = []
        while self.buffer:
            if not self.buffer[0] & 0x80:
                del self.buffer[0]
                continue
            if len(self.buffer) < 2:
                break
            if self.buffer[1] & 0x80:
                del self.buffer[0]
                continue
            size = ((self.buffer[0] & 0x3F) << 7) | self.buffer[1]
            end = size + 2
            # A new header within an incomplete frame resynchronizes the stream.
            next_header = next(
                (i for i in range(2, min(end, len(self.buffer)))
                 if self.buffer[i] & 0x80), None
            )
            if next_header is not None:
                del self.buffer[:next_header]
                continue
            if len(self.buffer) < end:
                break
            header = self.buffer[0]
            packed = self.buffer[2:end]
            del self.buffer[:end]
            report = bytearray()
            accumulator = bits = 0
            for byte in packed:
                accumulator = (accumulator << 7) | byte
                bits += 7
                if bits >= 8:
                    bits -= 8
                    report.append((accumulator >> bits) & 0xFF)
                accumulator &= (1 << bits) - 1
            if accumulator:
                raise ValueError("Nonzero serial frame padding")
            if header & 0x40:
                if len(report) < 2:
                    raise ValueError("Serial frame is missing its CRC")
                expected = struct.unpack("<H", report[-2:])[0]
                report = report[:-2]
                if crc16(report) != expected:
                    raise ValueError("Serial frame CRC mismatch")
            if report:
                reports.append(bytes(report))
        return reports


class MacSerial:
    def __init__(self, port, timeout=5.0):
        self.port = port
        self.timeout = timeout
        self.fd = None
        self.parser = FrameParser()

    def __enter__(self):
        self.fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            fcntl.ioctl(self.fd, termios.TIOCEXCL)
            settings = termios.tcgetattr(self.fd)
            settings[0] = settings[1] = settings[3] = 0
            settings[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            settings[4] = settings[5] = termios.B115200
            settings[6][termios.VMIN] = 0
            settings[6][termios.VTIME] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, settings)
            # macOS IOKit/serial/ioss.h: _IOW('T', 2, speed_t).
            # speed_t is unsigned long; use native width (8 on arm64/x86_64).
            speed = struct.pack("@L", 128000)
            request = 0x80000000 | (len(speed) << 16) | (ord("T") << 8) | 2
            fcntl.ioctl(self.fd, request, speed)
            fcntl.ioctl(self.fd, termios.TIOCMBIC, struct.pack("@i", termios.TIOCM_DTR))
            fcntl.ioctl(self.fd, termios.TIOCMBIS, struct.pack("@i", termios.TIOCM_RTS))
            termios.tcflush(self.fd, termios.TCIFLUSH)
            return self
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def send(self, report):
        pending = memoryview(encode_frame(report))
        deadline = time.monotonic() + self.timeout
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [self.fd], [], remaining)[1]:
                raise TimeoutError("Timed out writing to the tablet")
            try:
                written = os.write(self.fd, pending)
            except BlockingIOError:
                continue
            if not written:
                raise OSError("Serial port stopped accepting data")
            pending = pending[written:]

    def receive(self, report_id, length):
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.fd], [], [], remaining)[0]:
                raise TimeoutError(f"No response for report 0x{report_id:02x}")
            try:
                data = os.read(self.fd, 512)
            except BlockingIOError:
                continue
            if not data:
                raise OSError("Serial port disconnected")
            for report in self.parser.feed(data):
                if report[0] == report_id:
                    if len(report) != length:
                        raise ValueError(f"Unexpected report length for 0x{report_id:02x}")
                    return report

    def get(self, report_id, length):
        self.send(bytes([0x80, report_id]))
        return self.receive(report_id, length)

    def set(self, report):
        self.send(report)
        response = self.receive(0x81, 2)
        if response[1] != 0:
            raise RuntimeError(f"Tablet rejected report 0x{report[0]:02x}: result {response[1]}")


def identify(serial):
    info = serial.get(0x08, 17)
    model = info[1:10].split(b"\0", 1)[0].decode("ascii", errors="strict")
    if model != "STU-540":
        raise RuntimeError(f"Expected STU-540; received {model!r}. No settings changed.")
    print(f"Identified {model}, firmware {info[10]}.{info[11]}", flush=True)
    mode = int.from_bytes(serial.get(0x0C, 3)[1:], "little")
    if mode not in (1, 2):
        raise RuntimeError(f"Unexpected default mode {mode}. No settings changed.")
    print(f"Startup mode: {'HID' if mode == 1 else 'serial'} ({mode})", flush=True)
    return mode


def switch_to_hid(serial):
    identify(serial)
    serial.set(bytes([0x0C, 0x01, 0x00]))
    print("Tablet acknowledged HID startup mode.", flush=True)
    readback = serial.get(0x0C, 3)
    if readback != bytes([0x0C, 0x01, 0x00]):
        raise RuntimeError("HID mode readback failed; restart was not sent.")
    print("Verified HID startup mode; sending hardware restart.", flush=True)
    serial.send(bytes([0x04, 0x01]))
    try:
        response = serial.receive(0x81, 2)
    except (OSError, TimeoutError) as error:
        print(f"No restart acknowledgement ({error}). Check USB enumeration or reconnect the cable.")
        return
    if response[1] != 0:
        raise RuntimeError(f"Restart rejected: result {response[1]}. HID startup mode is saved; reconnect the cable.")
    print("Restart acknowledged. Check that macOS now lists STU-540 as USB 056a:00a8.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="USB virtual COM callout port, e.g. /dev/cu.usbserial-EXAMPLE")
    parser.add_argument("--switch", action="store_true", help="Save HID startup mode and restart the identified STU-540")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This utility supports macOS only")
    if not args.port.startswith("/dev/cu.usbserial-") or "/" in args.port[len("/dev/"):]:
        parser.error("Choose an explicit /dev/cu.usbserial-* port")
    try:
        with MacSerial(args.port) as serial:
            if args.switch:
                switch_to_hid(serial)
            else:
                identify(serial)
                print("Query complete. No settings changed. Use --switch to save HID mode and restart.")
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
