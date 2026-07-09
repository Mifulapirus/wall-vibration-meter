#include "MeterUi.h"
#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>
#include <Adafruit_NeoPixel.h>
#include "MeterConfig.h"
#include <math.h>

static Adafruit_GC9A01A display(TFT_CS, TFT_DC);
static GFXcanvas16     canvas(SCREEN_WIDTH, SCREEN_HEIGHT);
static Adafruit_NeoPixel ring(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
}

// Zone -> screen accent colour and RGB for the LED ring.
static uint16_t zoneColor565(int zone) {
    switch (zone) {
        case 0: return rgb565(0, 220, 90);     // green
        case 1: return rgb565(230, 210, 0);    // yellow
        case 2: return rgb565(255, 130, 0);    // orange
        default:return rgb565(255, 40, 40);    // red
    }
}
static void zoneRGB(int zone, uint8_t& r, uint8_t& g, uint8_t& b) {
    switch (zone) {
        case 0: r = 0;   g = 220; b = 90;  break;
        case 1: r = 230; g = 200; b = 0;   break;
        case 2: r = 255; g = 110; b = 0;   break;
        default:r = 255; g = 30;  b = 30;  break;
    }
}

// Draw text horizontally centred at a given Y using the canvas.
static void centerText(const String& s, int y, uint8_t size, uint16_t color) {
    int16_t x1, y1; uint16_t w, h;
    canvas.setTextSize(size);
    canvas.setTextColor(color);
    canvas.getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
    canvas.setCursor((SCREEN_WIDTH - w) / 2 - x1, y);
    canvas.print(s);
}

void MeterUi::begin() {
    display.begin(80000000);
    display.setRotation(0);
    display.fillScreen(GC9A01A_BLACK);

    ring.begin();
    ring.setBrightness(LED_BRIGHTNESS);
    ring.clear();
    ring.show();
}

void MeterUi::splash(const String& line1, const String& line2) {
    canvas.fillScreen(GC9A01A_BLACK);
    centerText(line1, 100, 3, rgb565(0, 200, 255));
    if (line2.length()) centerText(line2, 140, 2, GC9A01A_WHITE);
    display.drawRGBBitmap(0, 0, canvas.getBuffer(), SCREEN_WIDTH, SCREEN_HEIGHT);
}

void MeterUi::message(const String& text, uint16_t color) {
    canvas.fillScreen(GC9A01A_BLACK);
    centerText(text, SCREEN_HEIGHT / 2 - 8, 2, color);
    display.drawRGBBitmap(0, 0, canvas.getBuffer(), SCREEN_WIDTH, SCREEN_HEIGHT);
}

void MeterUi::wifiPortal(const String& ssid, const String& ip) {
    canvas.fillScreen(GC9A01A_BLACK);
    centerText("WiFi Setup", 55, 2, GC9A01A_YELLOW);
    centerText("Connect to:", 90, 1, GC9A01A_WHITE);
    centerText(ssid, 108, 2, rgb565(0, 200, 255));
    centerText("then open", 150, 1, GC9A01A_WHITE);
    centerText(ip, 168, 2, GC9A01A_WHITE);
    display.drawRGBBitmap(0, 0, canvas.getBuffer(), SCREEN_WIDTH, SCREEN_HEIGHT);

    for (int i = 0; i < NUM_LEDS; i++) ring.setPixelColor(i, ring.Color(255, 120, 0));
    ring.show();
}

void MeterUi::render(const VibeResult& r) {
    uint16_t accent = zoneColor565(r.zone);

    canvas.fillScreen(GC9A01A_BLACK);

    // Outer arc ring in the accent colour (a thin severity halo).
    canvas.drawCircle(120, 120, 118, accent);
    canvas.drawCircle(120, 120, 117, accent);

    // Headline: RMS velocity (mm/s) -> the "how bad is it" number.
    char buf[16];
    snprintf(buf, sizeof(buf), "%.2f", r.velRmsMmS);
    centerText(buf, 46, 5, accent);
    centerText("mm/s RMS", 96, 1, GC9A01A_WHITE);

    // Dominant frequency.
    snprintf(buf, sizeof(buf), "%.1f Hz", r.domFreqHz);
    centerText(buf, 116, 3, GC9A01A_WHITE);
    centerText("dominant", 146, 1, rgb565(150, 150, 150));

    // Acceleration RMS in mg.
    snprintf(buf, sizeof(buf), "accel %.0f mg", r.accelRmsG * 1000.0f);
    centerText(buf, 160, 1, rgb565(180, 180, 180));

    // --- Mini spectrum along the bottom --------------------------------------
    const int gx = 34, gw = 172;         // graph x, width
    const int gy = 210, gh = 34;         // baseline y, height
    // Find a scale from the visible bins (skip DC bin 0).
    float maxAmp = 1e-6f;
    for (int k = 1; k < r.nBins; k++) if (r.spectrum[k] > maxAmp) maxAmp = r.spectrum[k];

    int bars = 84;
    for (int bx = 0; bx < bars; bx++) {
        // Map bar -> spectrum bin (linear across the kept bins).
        int k = 1 + (int)((float)bx / bars * (r.nBins - 1));
        float amp = r.spectrum[k];
        // Log-ish compression so small signals are visible.
        float norm = amp / maxAmp;
        int hgt = (int)(sqrtf(norm) * gh);
        if (hgt < 1 && amp > 0) hgt = 1;
        int px = gx + (int)((float)bx / bars * gw);
        canvas.drawFastVLine(px, gy - hgt, hgt, accent);
    }
    canvas.drawFastHLine(gx, gy + 1, gw, rgb565(70, 70, 70));

    display.drawRGBBitmap(0, 0, canvas.getBuffer(), SCREEN_WIDTH, SCREEN_HEIGHT);

    // --- LED ring as a severity VU meter ------------------------------------
    uint8_t rr, gg, bb;
    zoneRGB(r.zone, rr, gg, bb);
    // Fraction of the ring lit scales with velocity up to the red threshold.
    float level = r.velRmsMmS / VEL_ZONE3;
    if (level > 1.0f) level = 1.0f;
    int lit = (int)ceilf(level * NUM_LEDS);
    ring.clear();
    for (int i = 0; i < lit; i++) ring.setPixelColor(i, ring.Color(rr, gg, bb));
    ring.show();
}
