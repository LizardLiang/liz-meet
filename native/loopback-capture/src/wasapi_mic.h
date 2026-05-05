#pragma once
#ifdef _WIN32

#include <string>
#include <thread>
#include <atomic>
#include <functional>
#include "wasapi_loopback.h"  // reuses CaptureEvent, EventKind, ChunkMeta

class WasapiMic {
public:
    using Callback = std::function<void(CaptureEvent)>;

    WasapiMic();
    ~WasapiMic();

    // deviceId: WASAPI endpoint id string, or empty string for default eCommunications device
    bool start(const std::string& sessionDir,
               const std::string& deviceId,
               int chunkSeconds,
               int vuIntervalMs,
               Callback cb);
    void stop();
    bool isRunning() const { return running_.load(); }

private:
    void captureThread(std::string sessionDir, std::string deviceId,
                       int chunkSeconds, int vuIntervalMs, Callback cb);

    std::thread       thread_;
    std::atomic<bool> running_{ false };
    void*             wakeEvent_{ nullptr }; // HANDLE
};

#endif // _WIN32
