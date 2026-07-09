#include "OtaClient.h"
#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include "MeterConfig.h"

namespace {
    String   g_url;
    uint32_t g_cur       = 0;
    uint32_t g_lastCheck = 0;
    bool     g_first     = true;

    void check() {
        if (WiFi.status() != WL_CONNECTED) return;

        // Fetch the manifest: { "version": <int>, "url": "http://.../x.bin" }.
        WiFiClient client;
        HTTPClient http;
        if (!http.begin(client, g_url)) return;
        http.setConnectTimeout(6000);
        http.setTimeout(8000);
        int code = http.GET();
        if (code != 200) { http.end(); return; }
        String body = http.getString();
        http.end();

        JsonDocument doc;
        if (deserializeJson(doc, body)) return;
        uint32_t ver = doc["version"] | 0u;
        const char* url = doc["url"] | "";
        if (ver <= g_cur || strlen(url) == 0) return;

        Serial.printf("OTA: server v%u > running v%u — updating from %s\n", ver, g_cur, url);

        // Streams straight to the inactive OTA partition; only switches on a
        // verified, complete image, so a failed download leaves us running.
        WiFiClient upClient;
        httpUpdate.rebootOnUpdate(true);
        t_httpUpdate_return ret = httpUpdate.update(upClient, url);
        if (ret == HTTP_UPDATE_FAILED) {
            Serial.printf("OTA failed (%d): %s\n",
                          httpUpdate.getLastError(),
                          httpUpdate.getLastErrorString().c_str());
        }
        // On success the device reboots into the new firmware and never returns.
    }
}

void OtaClient::begin(const char* manifestUrl, uint32_t currentVersion) {
    g_url = manifestUrl;
    g_cur = currentVersion;
    g_lastCheck = 0;
    g_first = true;
}

void OtaClient::loop() {
    uint32_t now = millis();
    uint32_t due = g_first ? OTA_FIRST_CHECK_MS : OTA_CHECK_INTERVAL_MS;
    if (now - g_lastCheck < due) return;
    g_lastCheck = now;
    g_first = false;
    check();
}
