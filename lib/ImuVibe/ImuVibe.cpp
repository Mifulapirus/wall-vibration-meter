#include "ImuVibe.h"
#include <Wire.h>
#include "MeterConfig.h"

// --- BMI160 register map (subset) ------------------------------------------
static const uint8_t REG_CHIP_ID  = 0x00;
static const uint8_t REG_STATUS    = 0x1B;
static const uint8_t REG_ACC_DATA  = 0x12;  // ACC_X_L, 6 bytes little-endian
static const uint8_t REG_ACC_CONF  = 0x40;
static const uint8_t REG_ACC_RANGE = 0x41;
static const uint8_t REG_CMD       = 0x7E;

static const uint8_t CHIP_ID_BMI160 = 0xD1;

static const uint8_t CMD_SOFT_RESET   = 0xB6;
static const uint8_t CMD_ACC_NORMAL   = 0x11;  // acc_set_pmu_mode = normal

static const uint8_t STATUS_DRDY_ACC  = 0x80;  // bit 7

// Map an ODR in Hz to the BMI160 acc_odr field (bits [3:0] of ACC_CONF).
static uint8_t odrCode(float hz) {
    if (hz <= 25.0f)   return 0x06;  // 25 Hz
    if (hz <= 50.0f)   return 0x07;  // 50 Hz
    if (hz <= 100.0f)  return 0x08;  // 100 Hz
    if (hz <= 200.0f)  return 0x09;  // 200 Hz
    if (hz <= 400.0f)  return 0x0A;  // 400 Hz
    if (hz <= 800.0f)  return 0x0B;  // 800 Hz
    return 0x0C;                     // 1600 Hz
}

// Map a full-scale range in g to the BMI160 acc_range field, and return
// LSB-per-g for the conversion.
static uint8_t rangeCode(int g, float& lsbPerG) {
    switch (g) {
        case 4:  lsbPerG = 8192.0f;  return 0x05;
        case 8:  lsbPerG = 4096.0f;  return 0x08;
        case 16: lsbPerG = 2048.0f;  return 0x0C;
        case 2:
        default: lsbPerG = 16384.0f; return 0x03;
    }
}

bool ImuVibe::writeReg(uint8_t reg, uint8_t val) {
    Wire.beginTransmission(BMI160_I2C_ADDRESS);
    Wire.write(reg);
    Wire.write(val);
    return Wire.endTransmission() == 0;
}

bool ImuVibe::readRegs(uint8_t reg, uint8_t* buf, uint8_t len) {
    Wire.beginTransmission(BMI160_I2C_ADDRESS);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;  // repeated start
    uint8_t got = Wire.requestFrom((int)BMI160_I2C_ADDRESS, (int)len);
    if (got != len) return false;
    for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
    return true;
}

bool ImuVibe::begin(float sampleRateHz, int rangeG) {
    _ok = false;
    _sampleRate = sampleRateHz;

    Wire.begin();                    // default ESP32-C3 I2C pins (SDA=8, SCL=9)
    Wire.setClock(I2C_CLOCK_HZ);

    // Soft reset and give the device time to come back.
    writeReg(REG_CMD, CMD_SOFT_RESET);
    delay(20);

    // Verify we are actually talking to a BMI160.
    uint8_t id = 0;
    if (!readRegs(REG_CHIP_ID, &id, 1) || id != CHIP_ID_BMI160) {
        return false;
    }

    // Power up the accelerometer (normal mode) and wait for it to settle.
    if (!writeReg(REG_CMD, CMD_ACC_NORMAL)) return false;
    delay(10);

    // Configure range then ODR.
    uint8_t rc = rangeCode(rangeG, _lsbPerG);
    if (!writeReg(REG_ACC_RANGE, rc)) return false;

    // ACC_CONF: acc_us=0 (no undersampling), acc_bwp=0b010 (normal filter),
    // acc_odr in the low nibble.
    uint8_t conf = (0x02 << 4) | odrCode(sampleRateHz);
    if (!writeReg(REG_ACC_CONF, conf)) return false;
    delay(10);

    _ok = true;
    return true;
}

bool ImuVibe::dataReady() {
    uint8_t s = 0;
    if (!readRegs(REG_STATUS, &s, 1)) return false;
    return (s & STATUS_DRDY_ACC) != 0;
}

bool ImuVibe::waitDataReady(uint32_t timeoutUs) {
    uint32_t start = micros();
    while (!dataReady()) {
        if ((uint32_t)(micros() - start) > timeoutUs) return false;
    }
    return true;
}

bool ImuVibe::readRaw(int16_t& x, int16_t& y, int16_t& z) {
    uint8_t b[6];
    if (!readRegs(REG_ACC_DATA, b, 6)) return false;
    x = (int16_t)((b[1] << 8) | b[0]);
    y = (int16_t)((b[3] << 8) | b[2]);
    z = (int16_t)((b[5] << 8) | b[4]);
    return true;
}

bool ImuVibe::readOnce(float& ax, float& ay, float& az) {
    int16_t x, y, z;
    if (!readRaw(x, y, z)) return false;
    ax = x / _lsbPerG;
    ay = y / _lsbPerG;
    az = z / _lsbPerG;
    return true;
}

bool ImuVibe::captureRawAxis(int16_t* buf, int count, int axis) {
    if (!_ok) return false;
    const uint32_t periodUs = (uint32_t)(1000000.0f / _sampleRate);
    const uint32_t timeoutUs = periodUs * 4 + 2000;
    for (int i = 0; i < count; i++) {
        if (!waitDataReady(timeoutUs)) return false;
        int16_t x, y, z;
        if (!readRaw(x, y, z)) return false;
        buf[i] = (axis == 0) ? x : (axis == 1) ? y : z;
    }
    return true;
}

bool ImuVibe::capture(float* ax, float* ay, float* az, int count) {
    if (!_ok) return false;
    // One data-ready period is 1/ODR; allow generous slack before timing out.
    const uint32_t periodUs = (uint32_t)(1000000.0f / _sampleRate);
    const uint32_t timeoutUs = periodUs * 4 + 2000;

    for (int i = 0; i < count; i++) {
        if (!waitDataReady(timeoutUs)) return false;
        int16_t x, y, z;
        if (!readRaw(x, y, z)) return false;
        ax[i] = x / _lsbPerG;
        ay[i] = y / _lsbPerG;
        az[i] = z / _lsbPerG;
    }
    return true;
}
