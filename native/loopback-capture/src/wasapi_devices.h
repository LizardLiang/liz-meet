#pragma once
#ifdef _WIN32

#include <string>
#include <vector>

struct InputDevice {
    std::string id;
    std::string name;
    bool        isDefault;
};

// Enumerate all active WASAPI capture (microphone) endpoints.
// Must be called from a thread with COM initialized.
std::vector<InputDevice> listInputDevices();

#endif // _WIN32
