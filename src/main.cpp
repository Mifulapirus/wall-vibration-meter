/*************************************************************************************************************
 * Wall Vibration Meter
 * Measures how much a wall vibrates (e.g. from rooftop AC compressors) using the
 * Activity Dice electronics: ESP32-C3 SuperMini + BMI160 IMU + GC9A01A round
 * display + NeoPixel ring.
 *
 * Each cycle it captures a block of accelerometer samples at a fixed rate,
 * computes RMS acceleration, peak, ISO-style RMS velocity (mm/s), the dominant
 * frequency and an FFT spectrum, then shows them on the display, the LED ring
 * (as a severity meter) and a web dashboard over WiFi.
 *
 * Author: Angel Hernandez  (built on the Activity Dice hardware)
 *************************************************************************************************************/
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <LittleFS.h>

#include "MeterConfig.h"
#include "ImuVibe.h"
#include "VibeDsp.h"
#include "MeterUi.h"
#include "WebUi.h"
#include "HistoryClient.h"
#include "OtaClient.h"

// --- Modules ---------------------------------------------------------------
ImuVibe   imu;
VibeDsp   dsp;
VibeResult latest;

// --- Capture buffers (static so they live in .bss, not the stack) ----------
static float bufX[FFT_SIZE];
static float bufY[FFT_SIZE];
static float bufZ[FFT_SIZE];

WiFiManager wifiManager;

void setupOTA() {
    ArduinoOTA.setHostname(MDNS_NAME);
    ArduinoOTA.onStart([]() { MeterUi::message("OTA update...", 0xFFFF); });
    ArduinoOTA.onEnd([]()   { MeterUi::message("OTA done", 0x07E0); });
    ArduinoOTA.onError([](ota_error_t) { MeterUi::message("OTA error", 0xF800); });
    ArduinoOTA.begin();
}

void setup() {
    Serial.begin(115200);

    MeterUi::begin();
    MeterUi::splash("Wall Vibe", "Meter");
    delay(800);

    // Filesystem for the web dashboard assets.
    if (!LittleFS.begin(true)) {
        Serial.println("LittleFS mount failed");
    }

    // IMU / vibration sensor.
    MeterUi::splash("Sensor", "init...");
    if (imu.begin(SAMPLE_RATE_HZ, ACCEL_RANGE_G)) {
        Serial.printf("BMI160 OK @ %.0f Hz, +/-%dg\n", SAMPLE_RATE_HZ, ACCEL_RANGE_G);
    } else {
        Serial.println("BMI160 not found!");
        MeterUi::message("No IMU!", 0xF800);
        delay(3000);
    }

    dsp.begin();

    // WiFi (captive portal on first use).
    wifiManager.setAPCallback([](WiFiManager* wm) {
        MeterUi::wifiPortal(AP_SSID, WiFi.softAPIP().toString());
    });
    MeterUi::splash("WiFi", "connecting");
    wifiManager.autoConnect(AP_SSID);

    Serial.println("IP: " + WiFi.localIP().toString());
    if (MDNS.begin(MDNS_NAME)) {
        Serial.printf("http://%s.local/\n", MDNS_NAME);
    }
    setupOTA();

    WebUi::begin(&latest);

#if HISTORY_ENABLE
    // Use the MAC (no colons) as a stable device id.
    String mac = WiFi.macAddress();
    mac.replace(":", "");
    HistoryClient::begin(HISTORY_INGEST_URL, HISTORY_TOKEN, mac.c_str());
    Serial.printf("History push -> %s as %s\n", HISTORY_INGEST_URL, mac.c_str());
#endif

#if OTA_ENABLE
    OtaClient::begin(OTA_MANIFEST_URL, FIRMWARE_VERSION);
    Serial.printf("Remote OTA enabled (running fw v%d) -> %s\n", FIRMWARE_VERSION, OTA_MANIFEST_URL);
#endif

    MeterUi::splash("Ready", WiFi.localIP().toString());
    delay(1000);
}

void loop() {
    ArduinoOTA.handle();
    WebUi::handle();
#if OTA_ENABLE
    OtaClient::loop();      // rate-limited remote update check
#endif

    // Capture one block (blocks ~ FFT_SIZE / SAMPLE_RATE seconds).
    if (imu.capture(bufX, bufY, bufZ, FFT_SIZE)) {
        VibeResult r;
        dsp.analyze(bufX, bufY, bufZ, FFT_SIZE, imu.sampleRate(), r);
        latest = r;

        MeterUi::render(latest);

        Serial.printf("v=%.3f mm/s  f=%.1f Hz  a=%.1f mg  b1=%.1f b2=%.1f mg  zone=%d\n",
                      r.velRmsMmS, r.domFreqHz, r.accelRmsG * 1000.0f,
                      r.band1RmsG * 1000.0f, r.band2RmsG * 1000.0f, r.zone);

#if HISTORY_ENABLE
        // Push to the history server on an interval (measurements keep running
        // regardless of whether the push succeeds).
        static unsigned long lastPush = 0;
        unsigned long nowMs = millis();
        if (lastPush == 0 || nowMs - lastPush >= HISTORY_PUSH_INTERVAL_MS) {
            lastPush = nowMs;
            bool ok = HistoryClient::push(latest, nowMs, HISTORY_INCLUDE_SPECTRUM);
            Serial.printf("  history push: %s\n", ok ? "ok" : "failed");
        }
#endif
    } else {
        Serial.println("IMU capture timeout");
        MeterUi::message("IMU timeout", 0xF800);
        delay(500);
    }
}
