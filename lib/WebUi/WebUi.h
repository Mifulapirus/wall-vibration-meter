#pragma once
#include <Arduino.h>
#include "VibeDsp.h"

// ============================================================================
//  WebUi - HTTP server exposing a live dashboard and a JSON metrics endpoint.
//  Static assets (index.html, app.js, style.css) are served from LittleFS.
// ============================================================================

namespace WebUi {
    // `latest` must point to the most recent result, updated by the main loop.
    void begin(const VibeResult* latest);
    void handle();
}
