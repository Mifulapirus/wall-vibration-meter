#include "VibeDsp.h"
#include <math.h>
#include <algorithm>   // std::nth_element (median noise floor)

void VibeDsp::begin() {
    // Hann window: w[n] = 0.5 * (1 - cos(2*pi*n/(N-1)))
    for (int i = 0; i < FFT_SIZE; i++) {
        _window[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (FFT_SIZE - 1)));
    }
    _havg = false;   // reseed the running average on (re)start
}

// In-place iterative radix-2 Cooley-Tukey FFT (forward).
// n must be a power of two. re/im hold the complex input and receive output.
void VibeDsp::fft(float* re, float* im, int n) {
    // Bit-reversal permutation.
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float tr = re[i]; re[i] = re[j]; re[j] = tr;
            float ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }

    // Butterflies.
    for (int len = 2; len <= n; len <<= 1) {
        float ang = -2.0f * (float)M_PI / len;
        float wr = cosf(ang);
        float wi = sinf(ang);
        for (int i = 0; i < n; i += len) {
            float curR = 1.0f, curI = 0.0f;
            for (int k = 0; k < len / 2; k++) {
                int a = i + k;
                int b = i + k + len / 2;
                float tr = re[b] * curR - im[b] * curI;
                float ti = re[b] * curI + im[b] * curR;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                float nextR = curR * wr - curI * wi;
                curI = curR * wi + curI * wr;
                curR = nextR;
            }
        }
    }
}

int VibeDsp::zoneFor(float velMmS) {
    if (velMmS >= VEL_ZONE3) return 3;
    if (velMmS >= VEL_ZONE2) return 2;
    if (velMmS >= VEL_ZONE1) return 1;
    return 0;
}

void VibeDsp::analyze(const float* ax, const float* ay, const float* az,
                      int n, float fs, VibeResult& out) {
    const int half = n / 2;
    const float binHz = fs / n;

    for (int k = 0; k < half; k++) _power[k] = 0.0f;

    // --- Per-axis means (DC, includes gravity) ------------------------------
    double mean[3] = {0, 0, 0};
    for (int i = 0; i < n; i++) { mean[0] += ax[i]; mean[1] += ay[i]; mean[2] += az[i]; }
    mean[0] /= n; mean[1] /= n; mean[2] /= n;

    // --- Time-domain AC energy + peak (orientation independent) -------------
    double var[3] = {0, 0, 0};
    float peakMag = 0.0f;
    for (int i = 0; i < n; i++) {
        float dx = ax[i] - (float)mean[0];
        float dy = ay[i] - (float)mean[1];
        float dz = az[i] - (float)mean[2];
        var[0] += (double)dx * dx;
        var[1] += (double)dy * dy;
        var[2] += (double)dz * dz;
        float mag = sqrtf(dx * dx + dy * dy + dz * dz);  // AC vector magnitude
        if (mag > peakMag) peakMag = mag;
    }
    var[0] /= n; var[1] /= n; var[2] /= n;

    float accelRmsG = sqrtf((float)(var[0] + var[1] + var[2]));

    // --- FFT each axis, accumulate combined power spectrum ------------------
    const float* axes[3] = {ax, ay, az};
    for (int axis = 0; axis < 3; axis++) {
        const float* s = axes[axis];
        float m = (float)mean[axis];
        for (int i = 0; i < n; i++) {
            _re[i] = (s[i] - m) * _window[i];   // remove DC, apply Hann
            _im[i] = 0.0f;
        }
        fft(_re, _im, n);
        for (int k = 1; k < half; k++) {
            _power[k] += _re[k] * _re[k] + _im[k] * _im[k];
        }
    }

    // --- Exponential average across frames ----------------------------------
    // Averaging successive power spectra lowers the random-noise variance
    // (~1/sqrt(effective N)) so weak tonal peaks stand out and the metrics stop
    // jittering. accel RMS is smoothed the same way for consistency. All the
    // metrics below are derived from the averaged spectrum _pavg / _accelAvg.
    if (!_havg) {
        for (int k = 0; k < half; k++) _pavg[k] = _power[k];
        _accelAvg = accelRmsG;
        _havg = true;
    } else {
        const float a = SPEC_AVG_ALPHA;
        for (int k = 0; k < half; k++) _pavg[k] = _pavg[k] * (1.0f - a) + _power[k] * a;
        _accelAvg = _accelAvg * (1.0f - a) + accelRmsG * a;
    }

    // Convert combined power to single-sided acceleration amplitude (m/s^2).
    // For a Hann window the coherent gain is 0.5, so a tone of amplitude A (g)
    // produces |X[k]| = A * N * 0.5 / 2 = A*N/4  ->  A = 4*|X[k]|/N.
    const float ampScale = (4.0f / n) * GRAVITY_MS2;   // g-domain |X| -> m/s^2

    // --- Dominant peak (above the low-frequency floor) ----------------------
    int kMinDom = (int)ceilf(FREQ_MIN_DOM_HZ / binHz);
    if (kMinDom < 1) kMinDom = 1;
    int kPeak = kMinDom;
    float pPeak = 0.0f;
    for (int k = kMinDom; k < half; k++) {
        if (_pavg[k] > pPeak) { pPeak = _pavg[k]; kPeak = k; }
    }

    // Parabolic interpolation on the (sqrt of) power for a sub-bin frequency.
    float domFreq = kPeak * binHz;
    if (kPeak > 0 && kPeak < half - 1) {
        float a = sqrtf(_pavg[kPeak - 1]);
        float b = sqrtf(_pavg[kPeak]);
        float c = sqrtf(_pavg[kPeak + 1]);
        float denom = (a - 2 * b + c);
        if (fabsf(denom) > 1e-9f) {
            float delta = 0.5f * (a - c) / denom;   // in [-0.5, 0.5]
            domFreq = (kPeak + delta) * binHz;
        }
    }
    float domAmpMs2 = ampScale * sqrtf(_pavg[kPeak]);

    // --- Noise floor (median bin power) + SNR of the dominant peak ----------
    // The median bin is a robust estimate of the broadband sensor-noise floor
    // (immune to the few signal peaks). SNR = dominant peak / noise floor is the
    // honest "how much real signal is there" number, independent of the muddy
    // wideband accel total. _im is free to reuse as scratch after the FFTs.
    int cnt = 0;
    for (int k = kMinDom; k < half; k++) _im[cnt++] = _pavg[k];
    float noisePow = 0.0f;
    if (cnt > 0) {
        std::nth_element(_im, _im + cnt / 2, _im + cnt);
        noisePow = _im[cnt / 2];
    }
    float noiseFloorMs2 = ampScale * sqrtf(noisePow);
    float snr = noiseFloorMs2 > 1e-9f ? domAmpMs2 / noiseFloorMs2 : 0.0f;

    // --- RMS velocity via frequency-domain integration ----------------------
    // (Hann ENBW = 1.5 corrects the coherent-gain scaling; validated numerically.)
    const double HANN_ENBW = 1.5;
    int kMinVel = (int)ceilf(FREQ_MIN_VEL_HZ / binHz);
    if (kMinVel < 1) kMinVel = 1;
    double velSumSq = 0.0;    // (m/s)^2
    for (int k = kMinVel; k < half; k++) {
        float f = k * binHz;
        float aAmp = ampScale * sqrtf(_pavg[k]);   // m/s^2 peak
        float vAmp = aAmp / (2.0f * (float)M_PI * f);
        velSumSq += 0.5 * (double)vAmp * vAmp;      // peak^2/2 = rms^2
    }
    float velRmsMmS = sqrtf((float)(velSumSq / HANN_ENBW)) * 1000.0f;  // m/s -> mm/s

    // --- AC vibration bands (RMS acceleration per band) ---------------------
    // Partition the (smoothed) time-domain RMS by the spectral power fraction in
    // each band. Two bands separate the independently-cycling rooftop units.
    double totalPower = 0.0, b1Power = 0.0, b2Power = 0.0;
    int k1Lo = (int)roundf(BAND1_LO_HZ / binHz), k1Hi = (int)roundf(BAND1_HI_HZ / binHz);
    int k2Lo = (int)roundf(BAND2_LO_HZ / binHz), k2Hi = (int)roundf(BAND2_HI_HZ / binHz);
    if (k1Lo < 1) k1Lo = 1;   if (k1Hi > half - 1) k1Hi = half - 1;
    if (k2Lo < 1) k2Lo = 1;   if (k2Hi > half - 1) k2Hi = half - 1;
    for (int k = 1; k < half; k++) {
        totalPower += _pavg[k];
        if (k >= k1Lo && k <= k1Hi) b1Power += _pavg[k];
        if (k >= k2Lo && k <= k2Hi) b2Power += _pavg[k];
    }
    float band1RmsG = (totalPower > 0.0) ? _accelAvg * sqrtf((float)(b1Power / totalPower)) : 0.0f;
    float band2RmsG = (totalPower > 0.0) ? _accelAvg * sqrtf((float)(b2Power / totalPower)) : 0.0f;

    // --- Fill spectrum for display (averaged m/s^2 amplitude per bin) --------
    // Decimate the full-resolution spectrum to a coarser ~SPECTRUM_DISP_BIN_HZ
    // display grid (peak-hold over each group), so the spectrogram's frequency
    // span stays constant as FFT_SIZE grows. Peak-hold keeps tonal lines visible
    // instead of averaging them down. decim=1 (a no-op) at FFT_SIZE=1024.
    int decim = (int)roundf(SPECTRUM_DISP_BIN_HZ / binHz);
    if (decim < 1) decim = 1;
    int nBins = half / decim;
    if (nBins > SPECTRUM_BINS) nBins = SPECTRUM_BINS;
    for (int j = 0; j < nBins; j++) {
        float pMax = 0.0f;
        int base = j * decim;
        for (int d = 0; d < decim; d++) {
            float p = _pavg[base + d];
            if (p > pMax) pMax = p;
        }
        out.spectrum[j] = ampScale * sqrtf(pMax);
    }
    float dispBinHz = binHz * decim;

    // --- Populate result ----------------------------------------------------
    out.accelRmsG   = _accelAvg;
    out.accelRmsMs2 = _accelAvg * GRAVITY_MS2;
    out.accelPeakG  = peakMag;
    out.velRmsMmS   = velRmsMmS;
    out.band1RmsG   = band1RmsG;
    out.band1LoHz   = BAND1_LO_HZ;
    out.band1HiHz   = BAND1_HI_HZ;
    out.band2RmsG   = band2RmsG;
    out.band2LoHz   = BAND2_LO_HZ;
    out.band2HiHz   = BAND2_HI_HZ;
    out.domFreqHz   = domFreq;
    out.domAmpMs2   = domAmpMs2;
    out.noiseFloorMs2 = noiseFloorMs2;
    out.snr         = snr;
    out.zone        = zoneFor(velRmsMmS);
    out.fs          = fs;
    out.n           = n;
    out.nBins       = nBins;
    out.binHz       = dispBinHz;   // spacing of the exposed (decimated) spectrum
    out.valid       = true;
}
