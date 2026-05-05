{
  "targets": [{
    "target_name": "loopback_capture",
    "sources": [
      "src/addon.cc",
      "src/wasapi_loopback.cc",
      "src/wasapi_mic.cc",
      "src/wasapi_devices.cc",
      "src/ring_processor.cc"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
    "conditions": [
      ["OS=='win'", {
        "libraries": [ "-lOle32.lib", "-lAvrt.lib", "-lksuser.lib", "-lPropsys.lib" ],
        "msvs_settings": {
          "VCCLCompilerTool": {
            "ExceptionHandling": 1,
            "AdditionalOptions": [ "/std:c++17", "/utf-8" ]
          },
          "VCLinkerTool": {
            "AdditionalOptions": [ "/MAP" ]
          }
        }
      }],
      ["OS!='win'", {
        "sources!": [
          "src/wasapi_loopback.cc",
          "src/wasapi_mic.cc",
          "src/wasapi_devices.cc"
        ],
        "defines": [ "PLATFORM_UNSUPPORTED" ]
      }]
    ]
  }]
}
