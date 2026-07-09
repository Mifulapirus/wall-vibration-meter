#pragma once
#include <Arduino.h>
#include "VibeDsp.h"

// ============================================================================
//  HistoryClient - pushes vibration readings to the history server so that
//  long-term data is stored off-device (the ESP32-C3 has no room to keep it).
//  Supports both http:// and https:// endpoints.
// ============================================================================

namespace HistoryClient {
    void begin(const char* url, const char* token, const char* deviceId);

    // POST one reading (optionally with its spectrum). Returns true on HTTP 2xx.
    // Non-blocking-ish: does a synchronous request but only when called, which
    // the main loop schedules on an interval.
    bool push(const VibeResult& r, unsigned long uptimeMs, bool includeSpectrum);

    const char* deviceId();
}
