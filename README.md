# Wall Vibration Meter

A vibration tester built from the **Activity Dice** electronics, repurposed to
measure how much a wall vibrates — e.g. from rooftop AC compressors.

It samples the on-board accelerometer at a fixed rate, runs an FFT, and reports:

- **RMS velocity (mm/s)** — the ISO-10816-style "how bad is it" number
- **Dominant frequency (Hz)** — which lets you match vibration to a source
  (compressor motor speed + harmonics vs. a structural resonance)
- **RMS & peak acceleration (mg / g)**
- **A live acceleration spectrum**

Results appear on the round display, on the LED ring (as a green→red severity
meter), and on a web dashboard over WiFi.

## Hardware (unchanged from Activity Dice)

| Part | Detail |
|------|--------|
| MCU | ESP32-C3 SuperMini |
| IMU | BMI160, I²C @ `0x68` (default pins SDA=GPIO8, SCL=GPIO9) |
| Display | GC9A01A 240×240 round, SPI, CS=GPIO7, DC=GPIO10 |
| LED ring | 16× NeoPixel on GPIO3 |

No wiring changes are needed. The accelerometer is the vibration sensor — for
good readings the device must be **firmly coupled to the wall** (screw a bracket
to the wall, or use strong double-sided tape / museum putty). A loosely held or
hand-held device measures your hand, not the wall.

## How it works

1. **Capture** — the BMI160 is driven directly over I²C (not via the DFRobot
   library, which locks the accelerometer to 100 Hz). It runs at **800 Hz**
   (±2 g) and each sample is taken on the sensor's data-ready flag, so the
   spacing is exactly uniform. A block is `FFT_SIZE` (1024) samples ≈ **1.28 s**.
2. **Analyse** (`lib/VibeDsp`) — per axis: remove the DC/gravity offset, apply a
   Hann window, run an in-house radix-2 FFT, and sum the power across all three
   axes so the result is independent of how the device is mounted.
   - RMS acceleration is computed in the time domain (exact).
   - RMS velocity is obtained by integrating the spectrum (`V = A / 2πf`),
     skipping near-DC bins where `1/f` blows up.
   - The dominant peak is refined with parabolic interpolation for sub-bin
     frequency accuracy.
3. **Show** — `lib/MeterUi` draws the round screen + LED ring; `lib/WebUi`
   serves the dashboard and a JSON endpoint.

## Build & flash

```bash
# 1. Firmware
pio run -t upload

# 2. Web dashboard assets (index.html / app.js / style.css) into LittleFS
pio run -t uploadfs

# 3. Watch the serial log
pio device monitor
```

First boot starts a WiFi setup portal — connect to the **`WallVibeMeter`**
access point and pick your network. After that the device joins your WiFi; the
display shows its IP, and the dashboard is at `http://<ip>/` or
`http://wallvibe.local/`. OTA updates are enabled (`pio run -t upload` with an
`upload_port` set to the device IP, or via the Arduino OTA menu).

## Reading the results

The headline number is **RMS velocity in mm/s**. Severity zones (LED ring +
dashboard colour) are:

| Zone | mm/s (default) | Meaning |
|------|----------------|---------|
| 🟢 Good | `< 0.3` | barely perceptible |
| 🟡 Fair | `0.3 – 1.0` | clearly perceptible |
| 🟠 High | `1.0 – 3.0` | strong |
| 🔴 Severe | `> 3.0` | severe |

**These defaults are a starting point, not gospel.** Walls are not rotating
machines, so ISO 10816 is only a loose reference. The most useful measurement is
**relative**: take a baseline with the AC **off**, then compare with it **on**.
The dashboard's rolling history chart makes that easy — you'll see the velocity
step up when the compressor kicks in, and the spectrum will show a peak at the
compressor's running frequency (and harmonics).

## History (off-device storage)

The ESP32-C3 has no room to keep long-term data, so the meter **pushes each
reading to a history server** which stores it and serves trend charts + a
spectrogram. See [`server/`](server/) for the Dockerized Flask app that runs on
`capek-web` behind Nginx at `wallvibe.thehomelab.dev`.

- The device POSTs summary metrics + the FFT spectrum to `/api/ingest` every
  `HISTORY_PUSH_INTERVAL_MS` (default 10 s).
- The device has no RTC, so **the server timestamps readings on receipt.**
- Configure the endpoint in [`include/MeterConfig.h`](include/MeterConfig.h)
  (`HISTORY_INGEST_URL`, `HISTORY_TOKEN`); set `HISTORY_ENABLE 0` to disable.

The on-device web dashboard (`http://wallvibe.local/`) still shows the live
view; the server is purely for history.

## Tuning (`include/MeterConfig.h`)

| Setting | Effect |
|---------|--------|
| `SAMPLE_RATE_HZ` | Higher = wider frequency range (Nyquist = rate/2). 800 Hz covers 0–400 Hz. |
| `FFT_SIZE` | Larger = finer frequency resolution & lower noise, but slower updates. 1024 → 0.78 Hz/bin, 1.28 s/frame. |
| `ACCEL_RANGE_G` | Keep at 2 g for best resolution; raise only if you see clipping. |
| `VEL_ZONE1..3` | Severity thresholds — calibrate to your wall. |
| `FREQ_MIN_DOM_HZ` / `FREQ_MIN_VEL_HZ` | Ignore slow drift below these frequencies. |

## Accuracy notes

- The BMI160 is a general-purpose MEMS IMU, not a lab accelerometer. Its noise
  floor (~180 µg/√Hz) puts the velocity noise floor around **0.1–0.2 mm/s**, so
  treat readings near the green threshold as "essentially quiet."
- The velocity figure assumes vibration is fairly **tonal** (dominated by a few
  frequencies), which is true for compressor-driven wall vibration. For lower
  noise, raise `FFT_SIZE` or average several frames.
- The numbers are repeatable and good for comparison; they are **not** a
  calibrated substitute for a certified vibration analyzer.

## Project layout

```
include/MeterConfig.h     all pins, sample rate, FFT size, thresholds
lib/ImuVibe/              BMI160 I2C driver (rate/range config + drdy capture)
lib/VibeDsp/              FFT + vibration metrics -> VibeResult
lib/MeterUi/              round display + LED ring rendering
lib/WebUi/                web server + /api/vibration JSON
data/                     web dashboard (served from LittleFS)
src/main.cpp              setup + capture→analyze→render loop
```
