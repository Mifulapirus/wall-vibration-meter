#pragma once
#include <Arduino.h>

// ============================================================================
//  ImuVibe - minimal BMI160 accelerometer driver for vibration capture.
//
//  The DFRobot library used by Activity Dice locks the accelerometer to a
//  100 Hz output data rate (50 Hz Nyquist) and hides the rate/range settings
//  behind private methods. For vibration analysis we need a higher, precisely
//  known sample rate, so this talks to the BMI160 directly over I2C:
//    - configurable ODR and full-scale range
//    - data-ready (drdy) synchronised reads for jitter-free uniform sampling
// ============================================================================

class ImuVibe {
public:
    // Initialise I2C and configure the accelerometer.
    // sampleRateHz must be a BMI160 ODR step (25,50,100,200,400,800,1600).
    // rangeG is 2, 4, 8 or 16.
    // Returns false if the chip is not found / does not respond.
    bool begin(float sampleRateHz, int rangeG);

    // Capture `count` accelerometer samples into ax/ay/az (units: g),
    // each sample synchronised to the sensor's data-ready flag so the
    // spacing is exactly 1/sampleRate. Returns false on I2C timeout.
    bool capture(float* ax, float* ay, float* az, int count);

    // Read one instantaneous sample (g). Handy for a live "is it alive" check.
    bool readOnce(float& ax, float& ay, float& az);

    // Capture `count` raw int16 counts of a single axis (0=x,1=y,2=z),
    // drdy-synchronised. Used for the high-resolution raw snippet the server
    // analyses. Returns false on I2C timeout.
    bool captureRawAxis(int16_t* buf, int count, int axis);

    float sampleRate() const { return _sampleRate; }
    bool  ok() const { return _ok; }

private:
    float   _sampleRate = 0.0f;
    float   _lsbPerG    = 16384.0f;   // set from range
    bool    _ok         = false;

    bool    writeReg(uint8_t reg, uint8_t val);
    bool    readRegs(uint8_t reg, uint8_t* buf, uint8_t len);
    bool    dataReady();
    bool    waitDataReady(uint32_t timeoutUs);
    bool    readRaw(int16_t& x, int16_t& y, int16_t& z);
};
