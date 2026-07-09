#pragma once
#include <Arduino.h>

// ============================================================================
//  OtaClient - remote firmware updates. Periodically checks a JSON manifest on
//  the history server; if it advertises a higher version than the running
//  firmware, downloads and installs the new .bin (ESP32 OTA, plain HTTP).
//
//  This is *pull* OTA (device fetches from the server), which works from
//  anywhere the device can reach the server. ArduinoOTA (LAN push) is also
//  available for direct `pio run -t upload --upload-port <ip>` flashing.
// ============================================================================

namespace OtaClient {
    void begin(const char* manifestUrl, uint32_t currentVersion);
    void loop();   // call frequently; internally rate-limited
}
