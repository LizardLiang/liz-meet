#pragma once
#include <string>
#include <vector>
#include <functional>
#include <cstdint>

struct ChunkMeta {
    std::string path;
    int         seq;
    double      startSeconds;
    double      endSeconds;
};

// Accumulates downmixed/downsampled PCM16 frames.
// Emits VU (dBFS) on a time interval, flushes WAV chunks on size trigger.
class RingProcessor {
public:
    // vuIntervalSamples: how many 16kHz mono samples between VU emits
    // chunkSamples     : 0 = preview mode (no WAV writes)
    // sessionDir       : directory for WAV files (ignored in preview mode)
    RingProcessor(int vuIntervalSamples,
                  int chunkSamples,
                  const std::string& sessionDir);

    // Push one stereo float frame at 48 kHz.
    // Returns true if a chunk was flushed (fills *meta).
    void pushStereoFloat(const float* L, const float* R, uint32_t nFrames,
                         std::function<void(double rmsDb)>     onVu,
                         std::function<void(ChunkMeta)>        onChunk);

    // Flush remaining PCM as a final partial chunk (call on stop).
    void flush(std::function<void(ChunkMeta)> onChunk);

private:
    void flushChunk(std::function<void(ChunkMeta)> onChunk);
    double computeRmsDb() const;

    // 3:1 simple decimation from 48→16 kHz
    // We keep a 3-sample accumulator for anti-alias averaging
    float  decimate_[3] = {};
    int    decimatePos_ = 0;

    // VU accumulation
    double vuSumSq_         = 0.0;
    int    vuSampleCount_   = 0;
    int    vuIntervalSamples_;

    // Chunk accumulation
    std::vector<int16_t> pcmBuf_;
    int    chunkSamples_;       // 0 = preview mode
    int    seq_              = 0;
    double sessionStartSec_  = 0.0;   // filled lazily via clock
    double chunkStartSec_    = 0.0;
    double totalSamples_     = 0.0;   // mono 16kHz samples since start

    std::string sessionDir_;
};
