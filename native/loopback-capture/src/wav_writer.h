#pragma once
#include <cstdint>
#include <cstring>

// Writes a 44-byte PCM WAV header into buf (must be at least 44 bytes).
// sampleRate: 16000, channels: 1, bitsPerSample: 16
inline void write_wav_header(uint8_t* buf, uint32_t pcmBytes,
                              uint32_t sampleRate = 16000,
                              uint16_t channels = 1,
                              uint16_t bitsPerSample = 16) {
    auto w32 = [&](int off, uint32_t v) { memcpy(buf + off, &v, 4); };
    auto w16 = [&](int off, uint16_t v) { memcpy(buf + off, &v, 2); };

    uint32_t byteRate   = sampleRate * channels * (bitsPerSample / 8);
    uint16_t blockAlign = channels * (bitsPerSample / 8);

    memcpy(buf,     "RIFF", 4);
    w32(4,  36 + pcmBytes);          // ChunkSize
    memcpy(buf + 8, "WAVE", 4);
    memcpy(buf + 12, "fmt ", 4);
    w32(16, 16);                      // Subchunk1Size (PCM = 16)
    w16(20, 1);                       // AudioFormat (PCM = 1)
    w16(22, channels);
    w32(24, sampleRate);
    w32(28, byteRate);
    w16(32, blockAlign);
    w16(34, bitsPerSample);
    memcpy(buf + 36, "data", 4);
    w32(40, pcmBytes);
}
