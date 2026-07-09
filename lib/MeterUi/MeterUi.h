#pragma once
#include <Arduino.h>
#include "VibeDsp.h"

// ============================================================================
//  MeterUi - renders vibration results to the round GC9A01A display and the
//  NeoPixel ring (used as a green->red severity meter).
// ============================================================================

namespace MeterUi {
    void begin();

    // Boot / status splash screens.
    void splash(const String& line1, const String& line2 = "");
    void wifiPortal(const String& ssid, const String& ip);
    void message(const String& text, uint16_t color);

    // Render a completed measurement (screen + LED ring).
    void render(const VibeResult& r);
}
