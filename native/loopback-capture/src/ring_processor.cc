#include "ring_processor.h"
#include "wav_writer.h"

#include <cmath>
#include <algorithm>
#include <chrono>
#include <fstream>

#ifdef _WIN32
#include <windows.h>

static std::wstring utf8ToWide(const std::string& utf8) {
    if (utf8.empty()) return {};
    int need = MultiByteToWideChar(CP_UTF8, 0,
                                   utf8.c_str(), static_cast<int>(utf8.size()),
                                   nullptr, 0);
    std::wstring wide(need, L'\0');
    MultiByteToWideChar(CP_UTF8, 0,
                        utf8.c_str(), static_cast<int>(utf8.size()),
                        wide.data(), need);
    return wide;
}

// Recursive directory creation without std::filesystem
static void createDirsW(const std::wstring& path) {
    if (path.empty()) return;
    if (CreateDirectoryW(path.c_str(), nullptr)) return;
    DWORD err = GetLastError();
    if (err == ERROR_ALREADY_EXISTS) return;
    if (err == ERROR_PATH_NOT_FOUND) {
        // Try creating parent first
        auto pos = path.find_last_of(L"\\/");
        if (pos != std::wstring::npos) {
            createDirsW(path.substr(0, pos));
            CreateDirectoryW(path.c_str(), nullptr);
        }
    }
}
#endif

static double nowSeconds() {
    using namespace std::chrono;
    return duration<double>(steady_clock::now().time_since_epoch()).count();
}

RingProcessor::RingProcessor(int vuIntervalSamples,
                             int chunkSamples,
                             const std::string& sessionDir)
    : vuIntervalSamples_(vuIntervalSamples)
    , chunkSamples_(chunkSamples)
    , sessionDir_(sessionDir)
{
    sessionStartSec_ = nowSeconds();
    if (chunkSamples_ > 0)
        pcmBuf_.reserve(chunkSamples_);
}

void RingProcessor::pushStereoFloat(const float* L, const float* R,
                                    uint32_t nFrames,
                                    std::function<void(double)>      onVu,
                                    std::function<void(ChunkMeta)>   onChunk)
{
    for (uint32_t i = 0; i < nFrames; ++i) {
        float mono = (L[i] + R[i]) * 0.5f;

        decimate_[decimatePos_++] = mono;
        if (decimatePos_ < 3) continue;
        decimatePos_ = 0;

        float s = (decimate_[0] + decimate_[1] + decimate_[2]) / 3.0f;

        vuSumSq_ += static_cast<double>(s) * s;
        ++vuSampleCount_;
        if (vuSampleCount_ >= vuIntervalSamples_) {
            onVu(computeRmsDb());
            vuSumSq_       = 0.0;
            vuSampleCount_ = 0;
        }

        if (chunkSamples_ > 0) {
            float clamped = std::max(-1.0f, std::min(1.0f, s));
            pcmBuf_.push_back(static_cast<int16_t>(clamped * 32767.0f));
            totalSamples_ += 1.0;

            if (static_cast<int>(pcmBuf_.size()) >= chunkSamples_)
                flushChunk(onChunk);
        }
    }
}

void RingProcessor::flush(std::function<void(ChunkMeta)> onChunk) {
    if (chunkSamples_ > 0 && !pcmBuf_.empty())
        flushChunk(onChunk);
}

double RingProcessor::computeRmsDb() const {
    if (vuSampleCount_ == 0) return -100.0;
    double rms = std::sqrt(vuSumSq_ / vuSampleCount_);
    if (rms < 1e-7) return -100.0;
    return std::max(-100.0, std::min(0.0, 20.0 * std::log10(rms)));
}

void RingProcessor::flushChunk(std::function<void(ChunkMeta)> onChunk) {
    if (pcmBuf_.empty()) return;

#ifdef _WIN32
    createDirsW(utf8ToWide(sessionDir_));
#endif

    char name[64];
    snprintf(name, sizeof(name), "%06d.wav", seq_);

    std::string filePath = sessionDir_ + "\\" + name;

    uint32_t pcmBytes = static_cast<uint32_t>(pcmBuf_.size() * sizeof(int16_t));
    uint8_t  header[44];
    write_wav_header(header, pcmBytes);

    {
#ifdef _WIN32
        std::ofstream f(utf8ToWide(filePath), std::ios::binary);
#else
        std::ofstream f(filePath, std::ios::binary);
#endif
        if (!f.is_open()) {
            ++seq_;
            chunkStartSec_ = nowSeconds() - sessionStartSec_;
            pcmBuf_.clear();
            return;
        }
        f.write(reinterpret_cast<const char*>(header), sizeof(header));
        f.write(reinterpret_cast<const char*>(pcmBuf_.data()), pcmBytes);
    }

    double now      = nowSeconds();
    double chunkEnd = now - sessionStartSec_;

    ChunkMeta meta{ filePath, seq_, chunkStartSec_, chunkEnd };
    onChunk(meta);

    ++seq_;
    chunkStartSec_ = chunkEnd;
    pcmBuf_.clear();
}
