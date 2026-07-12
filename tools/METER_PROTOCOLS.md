# USB sound-meter HID protocols

Reverse-engineered so the bench meter can be read directly over USB, with no
vendor software (no manual `.xls`/`.xlsx` export). Verified 2026-07-10 against
each vendor app and the physical LCDs. Used by [`read_meters.py`](read_meters.py).

> **DSL is the only connected meter.** The TAS reader was retired on 2026-07-12
> (single-meter setup, no more two-meter averaging). Its protocol is kept below
> for reference but is no longer read by the tools.

## Setup

```
pip install hidapi
python tools/read_meters.py                       # live DSL, 1 Hz
python tools/read_meters.py --csv run.csv         # also append to CSV
python tools/read_meters.py --interval 0.5 --duration 60
```

On Windows `hidapi.enumerate()` cannot see a device that another process holds
open **exclusively** — see the DSL note below.

## Live push to Capek-web

The DSL meter is USB-connected to a local PC; the website runs elsewhere. So a
local agent reads the meter and pushes readings over the network — it does not
require the meter to be on the server.

```
# on the PC with the meter (close SoundLab first so DSL is readable):
python tools/meter_agent.py --server https://capek.example.dev --token SECRET
python tools/meter_agent.py --server http://localhost:5006
```

- Agent samples DSL (default 1 Hz), buffers readings, and POSTs batches (default
  every 5 s) to **`POST /api/noise/live`**. Readings survive a brief
  server/network outage (bounded local buffer, retried on the next flush).
- Server stores each reading as a `Noise` row with `source` = `DSL` (rename via
  `--name`), so they appear in the existing dashboard, `/sleep`, and heatmap
  views immediately.
- Endpoint body: `{"readings":[{"source","ts","spl_db","lamax"?,"lamin"?}, ...]}`;
  honors the server's `INGEST_TOKEN` via the `X-Device-Token` header. Missing
  `ts` is stamped on receipt.

## TAS — TASI TA652 (retired)

- HID `VID 0x2F81 PID 0x5721`, usage page `0x8C` (Windows mislabels it a
  "barcode badge reader"). 64-byte in/out reports, no report ID.
- Vendor app **EnvironmentalTester** opens it **SHARED**, so this tool works
  even while that app is running. The device is **request/response** — silent
  until polled.
- Realtime read: write `00 AA 55 01 03 03` then `0x00` padding to 65 bytes.
  (Commands use header `AA 55`; replies use `55 AA` — reversed on purpose.)
- Reply (64 bytes):

  | offset | bytes | meaning |
  |--------|-------|---------|
  | 0..3   | `55 AA 01 0D` | header + tag(01) + length(0x0D) |
  | 4..7   | u32 LE | device Unix timestamp |
  | 8..9   | u16 LE | **dB × 100** |
  | 10..11 | `01 00` | fixed |
  | 12..13 | u32 LE | **temperature °C × 100** |
  | 14     | u8     | checksum |

- Other commands (from `USB_helper.o::HID_wirte`): `AA 55 00 03 02` = history
  read (needs handshake), `AA 55 02 03 04` = bulk history dump (reply tag `02`).

## DSL — SoundLab meter

- HID `VID 0x64BD PID 0x74E3`, vendor usage page `0xFFA0`, 8-byte input report,
  **signed** bytes.
- Vendor app **SoundLab** (`SoundLevel.exe`) opens it **EXCLUSIVELY**. You must
  **fully close SoundLab** (pausing is not enough) before this tool can read it.
- Realtime read: write `00 B3` then `0x23` ('#') padding to 65 bytes.
- Reply (hidapi strips the report ID → 8 bytes `hi lo flags 00 …`):
  - `dB = int16_big_endian(hi, lo) / 10`
  - `flags`: bit7 low-battery · bit6 FAST/SLOW · bit5 MAX · bit4 weighting C/A ·
    bits0-3 range (0–4)
- Protocol source: `SoundLevelProtocol.dll` (`Analyse.ReadPoint` /
  `AnalysisReadPoint`), decompiled with ilspycmd. History: `0xB5` handshake,
  `0xC4` read; records prefixed `0xFD` with BCD date/time.

## Provenance

- TAS: static reverse of EnvironmentalTester's shipped object files
  (`ta652_interface.o`, `USB_helper.o`) via MSVC `dumpbin /DISASM`, then a live
  request/response test.
- DSL: decompiled `SoundLevelProtocol.dll`; formula cross-checked against the
  physical LCD (67.4 dB) and the on-screen FAST/dBC flags.
