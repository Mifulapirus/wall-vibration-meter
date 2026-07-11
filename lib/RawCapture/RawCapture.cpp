#include "RawCapture.h"
#include "ImuVibe.h"
#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include "MeterConfig.h"

namespace {
    String   g_url, g_dev;
    uint32_t g_last  = 0;
    bool     g_first = true;
    int16_t  rawBuf[RAW_CAPTURE_N];   // one axis, int16 counts (16 KB static)

    // Pick the axis with the most vibration (orientation-independent).
    int pickAxis(ImuVibe& imu) {
        double m[3] = {0, 0, 0}, s[3] = {0, 0, 0};
        int n = 0;
        for (int i = 0; i < 256; i++) {
            float x, y, z;
            if (imu.readOnce(x, y, z)) {
                m[0] += x; m[1] += y; m[2] += z;
                s[0] += x * x; s[1] += y * y; s[2] += z * z; n++;
            }
            delay(2);
        }
        if (!n) return 2;
        int best = 0; double bv = -1;
        for (int a = 0; a < 3; a++) {
            double var = s[a] / n - (m[a] / n) * (m[a] / n);
            if (var > bv) { bv = var; best = a; }
        }
        return best;
    }

    void doCapture(ImuVibe& imu) {
        if (WiFi.status() != WL_CONNECTED) return;
        int axis = pickAxis(imu);
        Serial.printf("RawCapture: capturing %d samples on axis %d...\n", RAW_CAPTURE_N, axis);
        if (!imu.captureRawAxis(rawBuf, RAW_CAPTURE_N, axis)) {
            Serial.println("RawCapture: capture failed");
            return;
        }
        WiFiClient client;
        HTTPClient http;
        String url = g_url + "?device=" + g_dev +
                     "&fs=" + String((int)SAMPLE_RATE_HZ) +
                     "&n=" + String(RAW_CAPTURE_N) +
                     "&axis=" + String(axis) +
                     "&range_g=" + String(ACCEL_RANGE_G);
        if (!http.begin(client, url)) return;
        http.addHeader("Content-Type", "application/octet-stream");
        http.setTimeout(15000);
        int code = http.POST((uint8_t*)rawBuf, RAW_CAPTURE_N * sizeof(int16_t));
        http.end();
        Serial.printf("RawCapture: upload HTTP %d\n", code);
    }
}

void RawCapture::begin(const char* url, const char* deviceId) {
    g_url = url; g_dev = deviceId; g_last = 0; g_first = true;
}

void RawCapture::loop(ImuVibe& imu) {
    uint32_t now = millis();
    uint32_t due = g_first ? RAW_CAPTURE_FIRST_MS : RAW_CAPTURE_INTERVAL_MS;
    if (now - g_last < due) return;
    g_last = now; g_first = false;
    doCapture(imu);
}
