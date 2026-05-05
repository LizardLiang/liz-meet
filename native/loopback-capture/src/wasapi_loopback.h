#pragma once
#ifdef _WIN32

#include <string>
#include <thread>
#include <atomic>
#include <functional>
#include "ring_processor.h"

struct VuEvent   { double rmsDb; };
struct ChunkEvt  { ChunkMeta meta; };
struct ErrorEvt  { std::string message; };

enum class EventKind { VU, CHUNK, ERR };

struct CaptureEvent {
    EventKind kind;
    VuEvent   vu;
    ChunkEvt  chunk;
    ErrorEvt  error;
};

class WasapiLoopback {
public:
    using Callback = std::function<void(CaptureEvent)>;

    WasapiLoopback();
    ~WasapiLoopback();

    bool start(const std::string& sessionDir,
               int chunkSeconds,
               int vuIntervalMs,
               Callback cb);
    void stop();
    bool isRunning() const { return running_.load(); }

private:
    void captureThread(std::string sessionDir, int chunkSeconds,
                       int vuIntervalMs, Callback cb);

    std::thread       thread_;
    std::atomic<bool> running_{ false };
    void*             wakeEvent_{ nullptr }; // HANDLE
};

#endif // _WIN32
