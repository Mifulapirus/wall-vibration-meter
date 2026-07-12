"""Shared HID access + decode for the DSL USB sound meter.

See METER_PROTOCOLS.md for the wire format. Used by read_meters.py (local
CLI/CSV) and meter_agent.py (push readings to Capek-web).

Requires: pip install hidapi
"""
import time

try:
    import hid
except ImportError:  # surfaced by the callers with a friendly message
    hid = None

DSL = dict(vid=0x64BD, pid=0x74E3, name="DSL")   # SoundLab meter (vendor app: SoundLab, EXCLUSIVE)

DSL_CMD = [0x00, 0xB3] + [0x23] * 63                            # realtime read


def open_meter(spec):
    """Open the meter's HID device, or return None if absent/locked.

    DSL returns None while SoundLab holds it (exclusive open)."""
    if hid is None:
        return None
    path = next((d["path"] for d in hid.enumerate(spec["vid"], spec["pid"])), None)
    if not path:
        return None
    h = hid.device()
    try:
        h.open_path(path)
    except OSError:
        return None
    h.set_nonblocking(1)
    return h


def transact(h, cmd, timeout=0.5):
    """Send a command frame and return the first non-empty reply, or None."""
    while h.read(64):
        pass
    h.write(cmd)
    end = time.time() + timeout
    while time.time() < end:
        d = h.read(64)
        if d and any(d):
            return bytes(d)
        time.sleep(0.005)
    return None


def read_dsl(h):
    b = transact(h, DSL_CMD)
    if not b or len(b) < 3:
        return None
    raw = (b[0] << 8) | b[1]
    if raw >= 32768:               # signed 16-bit
        raw -= 65536
    f = b[2]
    return {
        "meter": "DSL",
        "dB": raw / 10.0,
        "tempC": None,
        "weighting": "C" if f & 0x10 else "A",
        "mode": "FAST" if f & 0x40 else "SLOW",
        "dev_ts": None,
    }
