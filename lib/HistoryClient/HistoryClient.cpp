#include "HistoryClient.h"
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

namespace {
    String g_url;
    String g_token;
    String g_deviceId;

    bool isHttps() { return g_url.startsWith("https://"); }
}

void HistoryClient::begin(const char* url, const char* token, const char* deviceId) {
    g_url = url;
    g_token = token;
    g_deviceId = deviceId;
}

const char* HistoryClient::deviceId() { return g_deviceId.c_str(); }

bool HistoryClient::push(const VibeResult& r, unsigned long uptimeMs, bool includeSpectrum) {
    if (g_url.length() == 0 || WiFi.status() != WL_CONNECTED) return false;

    // Build the JSON body.
    JsonDocument doc;
    doc["device_id"]     = g_deviceId;
    doc["uptime_ms"]     = uptimeMs;
    doc["vel_rms_mm_s"]  = r.velRmsMmS;
    doc["dom_freq_hz"]   = r.domFreqHz;
    doc["accel_rms_g"]   = r.accelRmsG;
    doc["accel_rms_ms2"] = r.accelRmsMs2;
    doc["peak_g"]        = r.accelPeakG;
    doc["band1_rms_g"]   = r.band1RmsG;
    doc["band1_lo_hz"]   = r.band1LoHz;
    doc["band1_hi_hz"]   = r.band1HiHz;
    doc["band2_rms_g"]   = r.band2RmsG;
    doc["band2_lo_hz"]   = r.band2LoHz;
    doc["band2_hi_hz"]   = r.band2HiHz;
    doc["fw_version"]    = FIRMWARE_VERSION;
    doc["zone"]          = r.zone;
    doc["fs"]            = r.fs;
    doc["n"]             = r.n;
    doc["bin_hz"]        = r.binHz;
    doc["n_bins"]        = r.nBins;

    if (includeSpectrum) {
        JsonArray spec = doc["spectrum"].to<JsonArray>();
        for (int k = 0; k < r.nBins; k++) spec.add(r.spectrum[k]);
    }

    String body;
    serializeJson(doc, body);

    // Pick the transport based on the URL scheme. Both clients are created on
    // the stack so any TLS buffers are freed as soon as the push completes,
    // keeping steady-state heap usage low.
    HTTPClient http;
    bool begun = false;
    WiFiClientSecure secure;
    WiFiClient plain;

    if (isHttps()) {
        secure.setInsecure();            // trusted LAN; skip cert validation
        secure.setTimeout(8);            // seconds
        begun = http.begin(secure, g_url);
    } else {
        begun = http.begin(plain, g_url);
    }
    if (!begun) return false;

    http.setConnectTimeout(6000);
    http.setTimeout(8000);
    http.addHeader("Content-Type", "application/json");
    if (g_token.length()) http.addHeader("X-Device-Token", g_token);

    int code = http.POST(body);
    http.end();

    if (code >= 200 && code < 300) return true;

    Serial.printf("history push failed: HTTP %d (heap %u)\n", code, ESP.getFreeHeap());
    return false;
}
