#include "WebUi.h"
#include <WebServer.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include "MeterConfig.h"

namespace {
    WebServer server(80);
    const VibeResult* g_latest = nullptr;

    void handleVibration() {
        if (!g_latest || !g_latest->valid) {
            server.send(503, "application/json", "{\"valid\":false}");
            return;
        }
        const VibeResult& r = *g_latest;

        // Reserve enough for the spectrum array (~256 numbers).
        JsonDocument doc;
        doc["valid"]       = true;
        doc["accel_rms_g"] = r.accelRmsG;
        doc["accel_rms_ms2"] = r.accelRmsMs2;
        doc["accel_peak_g"]= r.accelPeakG;
        doc["vel_rms_mm_s"]= r.velRmsMmS;
        doc["dom_freq_hz"] = r.domFreqHz;
        doc["dom_amp_ms2"] = r.domAmpMs2;
        doc["zone"]        = r.zone;
        doc["fs"]          = r.fs;
        doc["n"]           = r.n;
        doc["bin_hz"]      = r.binHz;
        doc["n_bins"]      = r.nBins;
        doc["z1"]          = VEL_ZONE1;
        doc["z2"]          = VEL_ZONE2;
        doc["z3"]          = VEL_ZONE3;

        JsonArray spec = doc["spectrum"].to<JsonArray>();
        for (int k = 0; k < r.nBins; k++) spec.add(r.spectrum[k]);

        String out;
        serializeJson(doc, out);
        server.send(200, "application/json", out);
    }

    void handleNotFound() {
        server.send(404, "text/plain", "Not found");
    }
}

void WebUi::begin(const VibeResult* latest) {
    g_latest = latest;

    server.on("/api/vibration", HTTP_GET, handleVibration);

    // Static dashboard from LittleFS.
    server.serveStatic("/", LittleFS, "/index.html");
    server.serveStatic("/index.html", LittleFS, "/index.html");
    server.serveStatic("/app.js", LittleFS, "/app.js");
    server.serveStatic("/style.css", LittleFS, "/style.css");

    server.onNotFound(handleNotFound);
    server.begin();
}

void WebUi::handle() {
    server.handleClient();
}
