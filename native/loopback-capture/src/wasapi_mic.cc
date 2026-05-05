#ifdef _WIN32

#include "wasapi_mic.h"

#include <windows.h>
#ifdef ERROR
#undef ERROR
#endif

#include <mmdeviceapi.h>
#include <audioclient.h>
#include <cmath>
#include <vector>
#include <string>
#include "ring_processor.h"

#pragma comment(lib, "Ole32.lib")
#pragma comment(lib, "Avrt.lib")

template<typename T>
struct MicAR {
    T* p = nullptr;
    ~MicAR() { if (p) { p->Release(); p = nullptr; } }
    T** addr() { return &p; }
    T*  operator->() { return p; }
    explicit operator bool() const { return p != nullptr; }
};

WasapiMic::WasapiMic() {
    wakeEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
}

WasapiMic::~WasapiMic() {
    stop();
    if (wakeEvent_) {
        CloseHandle(static_cast<HANDLE>(wakeEvent_));
        wakeEvent_ = nullptr;
    }
}

bool WasapiMic::start(const std::string& sessionDir,
                       const std::string& deviceId,
                       int chunkSeconds,
                       int vuIntervalMs,
                       Callback cb)
{
    if (running_.load()) return false;
    running_.store(true);
    ResetEvent(static_cast<HANDLE>(wakeEvent_));
    thread_ = std::thread(&WasapiMic::captureThread, this,
                          sessionDir, deviceId, chunkSeconds, vuIntervalMs, std::move(cb));
    return true;
}

void WasapiMic::stop() {
    if (!running_.load()) return;
    running_.store(false);
    if (wakeEvent_) SetEvent(static_cast<HANDLE>(wakeEvent_));
    if (thread_.joinable()) thread_.join();
}

static std::string runMicCapture(
    HANDLE             wakeEvent,
    std::atomic<bool>& running,
    const std::string& sessionDir,
    const std::string& deviceId,
    int                chunkSeconds,
    int                vuIntervalMs,
    WasapiMic::Callback& cb)
{
    MicAR<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  (void**)enumerator.addr());
    if (FAILED(hr)) return "CoCreateInstance failed";

    MicAR<IMMDevice> device;
    if (!deviceId.empty()) {
        int wlen = MultiByteToWideChar(CP_UTF8, 0, deviceId.c_str(),
                                        static_cast<int>(deviceId.size()), nullptr, 0);
        std::wstring wid(wlen, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, deviceId.c_str(),
                            static_cast<int>(deviceId.size()), wid.data(), wlen);
        enumerator->GetDevice(wid.c_str(), device.addr());
    }
    if (!device) {
        hr = enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, device.addr());
    }
    if (FAILED(hr) || !device) return "GetAudioEndpoint(eCapture) failed";

    MicAR<IAudioClient> audioClient;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          (void**)audioClient.addr());
    if (FAILED(hr)) return "Activate(IAudioClient) failed";

    WAVEFORMATEX* mixFmt = nullptr;
    hr = audioClient->GetMixFormat(&mixFmt);
    if (FAILED(hr)) return "GetMixFormat failed";

    WORD nativeChannels = mixFmt->nChannels;

    // Shared capture mode — no AUDCLNT_STREAMFLAGS_LOOPBACK
    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        10000000LL, 0, mixFmt, nullptr);
    CoTaskMemFree(mixFmt);
    if (FAILED(hr)) return "IAudioClient::Initialize failed";

    hr = audioClient->SetEventHandle(wakeEvent);
    if (FAILED(hr)) return "SetEventHandle failed";

    MicAR<IAudioCaptureClient> captureClient;
    hr = audioClient->GetService(__uuidof(IAudioCaptureClient),
                                 (void**)captureClient.addr());
    if (FAILED(hr)) return "GetService(IAudioCaptureClient) failed";

    const int OUT_RATE = 16000;
    int vuIntervalSamples = (OUT_RATE * vuIntervalMs) / 1000;
    int chunkSamples      = chunkSeconds > 0 ? chunkSeconds * OUT_RATE : 0;

    RingProcessor proc(vuIntervalSamples, chunkSamples, sessionDir);

    hr = audioClient->Start();
    if (FAILED(hr)) return "IAudioClient::Start failed";

    // Mono buffer — we feed it as both L and R to pushStereoFloat
    // pushStereoFloat computes (L+R)*0.5, so mono + mono → mono, no change
    std::vector<float> mono;

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
            hr = captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
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
            mono.resize(numFrames);

            if (silent || !data) {
                std::fill(mono.begin(), mono.end(), 0.0f);
            } else {
                const auto* src = reinterpret_cast<const float*>(data);
                if (nativeChannels >= 2) {
                    for (UINT32 f = 0; f < numFrames; ++f)
                        mono[f] = (src[f * nativeChannels + 0] + src[f * nativeChannels + 1]) * 0.5f;
                } else {
                    for (UINT32 f = 0; f < numFrames; ++f)
                        mono[f] = src[f];
                }
            }

            proc.pushStereoFloat(
                mono.data(), mono.data(), numFrames,
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

void WasapiMic::captureThread(std::string sessionDir,
                               std::string deviceId,
                               int chunkSeconds,
                               int vuIntervalMs,
                               Callback cb)
{
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    std::string err = runMicCapture(
        static_cast<HANDLE>(wakeEvent_),
        running_,
        sessionDir, deviceId, chunkSeconds, vuIntervalMs, cb);

    if (!err.empty()) {
        CaptureEvent e;
        e.kind          = EventKind::ERR;
        e.error.message = err;
        cb(e);
    }

    CoUninitialize();
}

#endif // _WIN32
