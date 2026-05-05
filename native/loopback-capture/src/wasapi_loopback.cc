#ifdef _WIN32

#include "wasapi_loopback.h"

#include <windows.h>
#ifdef ERROR
#undef ERROR
#endif

#include <mmdeviceapi.h>
#include <audioclient.h>
#include <cmath>
#include <vector>
#include <string>

#pragma comment(lib, "Ole32.lib")
#pragma comment(lib, "Avrt.lib")

template<typename T>
struct AutoRelease {
    T* p = nullptr;
    ~AutoRelease() { if (p) { p->Release(); p = nullptr; } }
    T** addr() { return &p; }
    T*  operator->() { return p; }
    explicit operator bool() const { return p != nullptr; }
};

WasapiLoopback::WasapiLoopback() {
    wakeEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
}

WasapiLoopback::~WasapiLoopback() {
    stop();
    if (wakeEvent_) {
        CloseHandle(static_cast<HANDLE>(wakeEvent_));
        wakeEvent_ = nullptr;
    }
}

bool WasapiLoopback::start(const std::string& sessionDir,
                            int chunkSeconds,
                            int vuIntervalMs,
                            Callback cb)
{
    if (running_.load()) return false;
    running_.store(true);
    ResetEvent(static_cast<HANDLE>(wakeEvent_));
    thread_ = std::thread(&WasapiLoopback::captureThread, this,
                          sessionDir, chunkSeconds, vuIntervalMs, std::move(cb));
    return true;
}

void WasapiLoopback::stop() {
    if (!running_.load()) return;
    running_.store(false);
    if (wakeEvent_) SetEvent(static_cast<HANDLE>(wakeEvent_));
    if (thread_.joinable()) thread_.join();
}

static std::string runCapture(
    HANDLE             wakeEvent,
    std::atomic<bool>& running,
    const std::string& sessionDir,
    int                chunkSeconds,
    int                vuIntervalMs,
    WasapiLoopback::Callback& cb)
{
    AutoRelease<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  (void**)enumerator.addr());
    if (FAILED(hr)) return "CoCreateInstance failed";

    AutoRelease<IMMDevice> device;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device.addr());
    if (FAILED(hr)) return "GetDefaultAudioEndpoint failed";

    AutoRelease<IAudioClient> audioClient;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          (void**)audioClient.addr());
    if (FAILED(hr)) return "Activate(IAudioClient) failed";

    WAVEFORMATEX* mixFmt = nullptr;
    hr = audioClient->GetMixFormat(&mixFmt);
    if (FAILED(hr)) return "GetMixFormat failed";

    DWORD nativeSampleRate = mixFmt->nSamplesPerSec;
    WORD  nativeChannels   = mixFmt->nChannels;

    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        10000000LL,
        0, mixFmt, nullptr);
    CoTaskMemFree(mixFmt);
    if (FAILED(hr)) return "IAudioClient::Initialize failed";

    hr = audioClient->SetEventHandle(wakeEvent);
    if (FAILED(hr)) return "SetEventHandle failed";

    AutoRelease<IAudioCaptureClient> captureClient;
    hr = audioClient->GetService(__uuidof(IAudioCaptureClient),
                                 (void**)captureClient.addr());
    if (FAILED(hr)) return "GetService(IAudioCaptureClient) failed";

    const int OUT_RATE = 16000;
    int vuIntervalSamples = (OUT_RATE * vuIntervalMs) / 1000;
    int chunkSamples      = chunkSeconds > 0 ? chunkSeconds * OUT_RATE : 0;

    RingProcessor proc(vuIntervalSamples, chunkSamples, sessionDir);

    hr = audioClient->Start();
    if (FAILED(hr)) return "IAudioClient::Start failed";

    std::vector<float> left, right;

    while (running.load()) {
        WaitForSingleObject(wakeEvent, 200);
        if (!running.load()) break;

        UINT32 packetFrames = 0;
        while (SUCCEEDED(captureClient->GetNextPacketSize(&packetFrames))
               && packetFrames > 0)
        {
            BYTE*  data      = nullptr;
            UINT32 numFrames = 0;
            DWORD  flags     = 0;
            hr = captureClient->GetBuffer(&data, &numFrames, &flags,
                                          nullptr, nullptr);
            if (FAILED(hr) || numFrames == 0) {
                if (numFrames == 0 && SUCCEEDED(hr))
                    captureClient->ReleaseBuffer(0);
                break;
            }
            if (numFrames > 480000) {
                captureClient->ReleaseBuffer(numFrames);
                break;
            }

            bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
            left.resize(numFrames);
            right.resize(numFrames);

            if (silent || !data) {
                std::fill(left.begin(),  left.end(),  0.0f);
                std::fill(right.begin(), right.end(), 0.0f);
            } else {
                const auto* src = reinterpret_cast<const float*>(data);
                WORD ch = nativeChannels;
                if (ch >= 2) {
                    for (UINT32 f = 0; f < numFrames; ++f) {
                        left[f]  = src[f * ch + 0];
                        right[f] = src[f * ch + 1];
                    }
                } else {
                    for (UINT32 f = 0; f < numFrames; ++f) {
                        left[f] = right[f] = src[f];
                    }
                }
            }

            proc.pushStereoFloat(
                left.data(), right.data(), numFrames,
                [&](double rmsDb) {
                    CaptureEvent e;
                    e.kind     = EventKind::VU;
                    e.vu.rmsDb = rmsDb;
                    cb(e);
                },
                [&](ChunkMeta meta) {
                    CaptureEvent e;
                    e.kind       = EventKind::CHUNK;
                    e.chunk.meta = meta;
                    cb(e);
                }
            );

            captureClient->ReleaseBuffer(numFrames);
        }
    }

    proc.flush([&](ChunkMeta meta) {
        CaptureEvent e;
        e.kind       = EventKind::CHUNK;
        e.chunk.meta = meta;
        cb(e);
    });

    audioClient->Stop();
    return "";
}

void WasapiLoopback::captureThread(std::string sessionDir,
                                    int chunkSeconds,
                                    int vuIntervalMs,
                                    Callback cb)
{
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    std::string err = runCapture(
        static_cast<HANDLE>(wakeEvent_),
        running_,
        sessionDir, chunkSeconds, vuIntervalMs, cb);

    if (!err.empty()) {
        CaptureEvent e;
        e.kind         = EventKind::ERR;
        e.error.message= err;
        cb(e);
    }

    CoUninitialize();
}

#endif // _WIN32
