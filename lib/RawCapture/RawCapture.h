#pragma once
#include <Arduino.h>

// ============================================================================
//  RawCapture - periodically captures a long single-axis time-domain snippet
//  and POSTs it raw to the server, which runs a high-resolution FFT to try to
//  resolve individual compressors (the on-device FFT is too short/low-memory).
// ============================================================================

class ImuVibe;

namespace RawCapture {
    void begin(const char* url, const char* deviceId);
    void loop(ImuVibe& imu);   // call frequently; internally rate-limited
}
