#ifdef _WIN32

#include "wasapi_devices.h"

#include <windows.h>
#ifdef ERROR
#undef ERROR
#endif

#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propidl.h>
#include <string>
#include <vector>

template<typename T>
struct DevAR {
    T* p = nullptr;
    ~DevAR() { if (p) { p->Release(); p = nullptr; } }
    T** addr() { return &p; }
    T*  operator->() { return p; }
    explicit operator bool() const { return p != nullptr; }
};

static std::string wideToUtf8(const wchar_t* w, int wlen = -1) {
    if (!w || !*w) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w, wlen, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return {};
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, wlen, s.data(), n, nullptr, nullptr);
    // WideCharToMultiByte with -1 includes the null terminator in the count
    if (!s.empty() && s.back() == '\0') s.pop_back();
    return s;
}

std::vector<InputDevice> listInputDevices() {
    std::vector<InputDevice> out;

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    DevAR<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  (void**)enumerator.addr());
    if (FAILED(hr)) return out;

    // Get default capture device id for comparison
    std::string defaultId;
    {
        DevAR<IMMDevice> def;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, def.addr()))) {
            LPWSTR wid = nullptr;
            if (SUCCEEDED(def->GetId(&wid)) && wid) {
                defaultId = wideToUtf8(wid);
                CoTaskMemFree(wid);
            }
        }
    }

    DevAR<IMMDeviceCollection> collection;
    hr = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, collection.addr());
    if (FAILED(hr)) return out;

    UINT count = 0;
    collection->GetCount(&count);

    for (UINT i = 0; i < count; ++i) {
        DevAR<IMMDevice> device;
        if (FAILED(collection->Item(i, device.addr()))) continue;

        LPWSTR wid = nullptr;
        if (FAILED(device->GetId(&wid)) || !wid) continue;
        std::string id = wideToUtf8(wid);
        CoTaskMemFree(wid);

        std::string name;
        {
            DevAR<IPropertyStore> props;
            if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, props.addr()))) {
                PROPVARIANT pv;
                PropVariantInit(&pv);
                if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &pv))
                    && pv.vt == VT_LPWSTR && pv.pwszVal)
                {
                    name = wideToUtf8(pv.pwszVal);
                }
                PropVariantClear(&pv);
            }
        }

        out.push_back({ id, name, id == defaultId });
    }

    return out;
}

#endif // _WIN32
