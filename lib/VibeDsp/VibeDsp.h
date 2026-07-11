#pragma once
#include <Arduino.h>
#include "MeterConfig.h"

// ============================================================================
//  VibeDsp - turns a block of 3-axis acceleration samples into vibration
//  metrics: RMS acceleration, peak, RMS velocity (mm/s), dominant frequency,
//  and a combined acceleration spectrum for display.
// ============================================================================

struct VibeResult {
    bool  valid = false;

    float accelRmsG   = 0;   // overall AC RMS acceleration (g), orientation-independent
    float accelRmsMs2 = 0;   // same in m/s^2
    float accelPeakG  = 0;   // peak AC acceleration magnitude (g)
    float velRmsMmS   = 0;   // overall RMS velocity (mm/s) - the ISO-style severity number
    float band1RmsG   = 0;   // RMS accel in band 1 (low, ~25-40 Hz) - 4-pole/fan units
    float band1LoHz   = 0;
    float band1HiHz   = 0;
    float band2RmsG   = 0;   // RMS accel in band 2 (compressor, ~50-65 Hz) - 2-pole units
    float band2LoHz   = 0;
    float band2HiHz   = 0;
    float domFreqHz   = 0;   // dominant frequency (Hz), sub-bin interpolated
    float domAmpMs2   = 0;   // acceleration amplitude at the dominant frequency (m/s^2)
    float noiseFloorMs2 = 0; // median spectral noise floor (m/s^2) - sensor noise
    float snr         = 0;   // dominant peak / noise floor - real-signal strength
    int   zone        = 0;   // 0 good / 1 fair / 2 high / 3 severe

    float fs     = 0;        // sample rate used (Hz)
    int   n      = 0;        // FFT length
    int   nBins  = 0;        // number of valid entries in spectrum[]
    float binHz  = 0;        // Hz per bin

    // Combined single-sided acceleration amplitude spectrum (m/s^2 peak per bin).
    float spectrum[SPECTRUM_BINS] = {0};
};

class VibeDsp {
public:
    // Precompute the Hann window. Call once in setup().
    void begin();

    // Analyse `n` samples (must equal FFT_SIZE) at sample rate `fs`.
    void analyze(const float* ax, const float* ay, const float* az,
                 int n, float fs, VibeResult& out);

private:
    float _window[FFT_SIZE];   // Hann window
    float _re[FFT_SIZE];       // FFT working buffers (reused per axis)
    float _im[FFT_SIZE];
    float _power[FFT_SIZE / 2];// combined |X|^2 this frame (summed over axes)
    float _pavg[FFT_SIZE / 2]; // exponential average of _power across frames
    float _accelAvg = 0;       // exponential average of accel RMS (g)
    bool  _havg     = false;   // has the average been seeded yet?

    void  fft(float* re, float* im, int n);
    static int zoneFor(float velMmS);
};
