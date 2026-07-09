#pragma once
// ============================================================================
//  Wall Vibration Meter - central configuration
//  All pins match the Activity Dice board (V0.2), so the same electronics
//  can be reused unchanged.
// ============================================================================

// ---- Display (GC9A01A, hardware SPI) ---------------------------------------
#define TFT_CS   7    // GPIO7  chip select
#define TFT_DC   10   // GPIO10 data/command
// SPI SCK/MOSI use the ESP32-C3 default pins (same as Activity Dice)

#define SCREEN_WIDTH   240
#define SCREEN_HEIGHT  240

// ---- NeoPixel ring (severity meter) ----------------------------------------
#define LED_PIN        3     // GPIO3
#define NUM_LEDS       16
#define LED_BRIGHTNESS 40    // 0-255, keep modest so it doesn't wash out the screen

// ---- BMI160 IMU (I2C) ------------------------------------------------------
#define BMI160_I2C_ADDRESS 0x68
#define I2C_CLOCK_HZ       400000UL   // 400 kHz fast mode

// ---- Sampling / DSP --------------------------------------------------------
// Sensor output data rate. Must be one of the BMI160 ODR steps.
// 800 Hz -> 400 Hz Nyquist, comfortably covers AC compressor motor
// frequencies (typ. 25-60 Hz) and their harmonics.
#define SAMPLE_RATE_HZ   800.0f

// FFT length (power of two). 1024 @ 800 Hz -> 0.78 Hz resolution, ~1.28 s/frame.
// Lower it (e.g. 512) for snappier updates, raise it for finer frequency
// resolution and lower noise.
#define FFT_SIZE         1024

// Accelerometer full scale. Wall vibration is tiny (<< 1 g), so +/-2 g gives
// the best resolution (16384 LSB/g).
#define ACCEL_RANGE_G    2

// Number of spectrum bins exposed to the display / web dashboard.
// 256 bins @ 0.78 Hz = 0..200 Hz, which is where all the interesting
// compressor content lives.
#define SPECTRUM_BINS    256

// Ignore very-low-frequency content (sensor drift, slow building sway) when
// picking the dominant peak and when integrating to velocity.
#define FREQ_MIN_DOM_HZ  3.0f    // dominant-peak search floor
#define FREQ_MIN_VEL_HZ  2.0f    // velocity-integration floor

// ---- AC vibration bands ----------------------------------------------------
// Rooftop units couple into the wall at different frequencies and cycle
// independently, so two bands separate them (measured on-wall):
//   Band 1 (low)        ~25-40 Hz : 4-pole machines / condenser fans (~1728 RPM)
//   Band 2 (compressor) ~50-65 Hz : 2-pole compressors (~3516 RPM)
// RMS acceleration in each band is the responsive "which unit is running?"
// signal — velocity (mm/s) de-weights these mid frequencies, so it barely moves.
#define BAND1_LO_HZ  25.0f
#define BAND1_HI_HZ  40.0f
#define BAND2_LO_HZ  50.0f
#define BAND2_HI_HZ  65.0f

// ---- Severity thresholds (RMS velocity, mm/s) ------------------------------
// NOTE: Walls are not rotating machines, so ISO 10816 is only a loose guide.
// These defaults are tuned for building/wall vibration perception and should
// be calibrated against your own compressor-on vs compressor-off readings.
//   zone 0 GREEN  : below VEL_ZONE1  (barely perceptible)
//   zone 1 YELLOW : VEL_ZONE1..ZONE2 (clearly perceptible)
//   zone 2 ORANGE : VEL_ZONE2..ZONE3 (strong)
//   zone 3 RED    : above VEL_ZONE3  (severe)
#define VEL_ZONE1  0.3f
#define VEL_ZONE2  1.0f
#define VEL_ZONE3  3.0f

// ---- WiFi / identity -------------------------------------------------------
#define AP_SSID      "WallVibeMeter"   // captive-portal SSID for first-time setup
#define MDNS_NAME    "wallvibe"        // reachable as http://wallvibe.local

// ---- History server push ---------------------------------------------------
// The device has no RTC, so the server timestamps each reading on receipt.
// The meter just POSTs its latest metrics (+ spectrum) every push interval.
#define HISTORY_ENABLE            1
// Ingest endpoint. Plain HTTP is used deliberately: a TLS handshake needs
// ~40 KB of contiguous heap, but the 240x240 display canvas leaves the
// ESP32-C3 only ~50 KB free, so HTTPS pushes fail intermittently on memory.
// Nginx proxies /api/ingest over port 80 (browsers are still forced to HTTPS),
// matching the "devices on HTTP, browsers on HTTPS" pattern used by the other
// homelab devices. Switch to https:// only if the display/canvas is removed.
#define HISTORY_INGEST_URL        "http://wallvibe.thehomelab.dev/api/ingest"
#define HISTORY_TOKEN             ""            // must match server INGEST_TOKEN ("" = none)
#define HISTORY_PUSH_INTERVAL_MS  0             // 0 = push every measurement (~1.3 s, the FFT frame time)
#define HISTORY_INCLUDE_SPECTRUM  1             // also send the FFT spectrum (for the spectrogram)

// ---- Firmware version + remote OTA -----------------------------------------
// Monotonic build number. Bump on every release you publish to the server.
// The device pulls + installs firmware when the server manifest advertises a
// HIGHER version than this. Uses plain HTTP (TLS won't fit alongside the
// display canvas), same as the metrics push.
#define FIRMWARE_VERSION          4
#define OTA_ENABLE                1
#define OTA_MANIFEST_URL          "http://wallvibe.thehomelab.dev/api/firmware/latest"
#define OTA_CHECK_INTERVAL_MS     1800000UL     // re-check every 30 min
#define OTA_FIRST_CHECK_MS        15000UL       // first check 15 s after boot

// ---- Constants -------------------------------------------------------------
#define GRAVITY_MS2  9.80665f
