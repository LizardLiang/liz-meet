#include <node_api.h>
#include <string>
#include <cstring>

#ifdef _WIN32
#include "wasapi_loopback.h"
#include "wasapi_mic.h"
#include "wasapi_devices.h"
static WasapiLoopback* g_loopback = nullptr;
static WasapiMic*      g_mic      = nullptr;
#endif

// ---- Threadsafe callback machinery ----
struct TsfnData {
    napi_threadsafe_function tsfn = nullptr;
};
static TsfnData g_tsfn;
static TsfnData g_tsfn_mic;

struct EventPayload {
    enum Kind { VU, CHUNK, ERROR } kind;
    double      rmsDb;
    std::string path;
    int         seq;
    double      startSeconds;
    double      endSeconds;
    std::string message;
};

// Called on the JS thread by Node's event loop
static void tsfnCallback(napi_env env, napi_value jsCb, void* /*ctx*/, void* rawData) {
    EventPayload* payload = static_cast<EventPayload*>(rawData);

    napi_value obj;
    napi_create_object(env, &obj);

    auto setStr = [&](napi_value o, const char* key, const char* val) {
        napi_value v; napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, o, key, v);
    };
    auto setDbl = [&](napi_value o, const char* key, double val) {
        napi_value v; napi_create_double(env, val, &v);
        napi_set_named_property(env, o, key, v);
    };
    auto setInt = [&](napi_value o, const char* key, int val) {
        napi_value v; napi_create_int32(env, val, &v);
        napi_set_named_property(env, o, key, v);
    };

    if (payload->kind == EventPayload::VU) {
        setStr(obj, "type", "vu");
        setDbl(obj, "rmsDb", payload->rmsDb);
    } else if (payload->kind == EventPayload::CHUNK) {
        setStr(obj, "type", "chunk");
        setStr(obj, "path", payload->path.c_str());
        setInt(obj, "seq",  payload->seq);
        setDbl(obj, "startSeconds", payload->startSeconds);
        setDbl(obj, "endSeconds",   payload->endSeconds);
    } else {
        setStr(obj, "type", "error");
        setStr(obj, "message", payload->message.c_str());
    }

    napi_value args[] = { obj };
    napi_call_function(env, obj, jsCb, 1, args, nullptr);

    delete payload;
}

static void releaseTsfn(TsfnData& tsfn) {
    if (tsfn.tsfn) {
        napi_release_threadsafe_function(tsfn.tsfn, napi_tsfn_release);
        tsfn.tsfn = nullptr;
    }
}

static void abortTsfn(TsfnData& tsfn) {
    if (tsfn.tsfn) {
        napi_release_threadsafe_function(tsfn.tsfn, napi_tsfn_abort);
        tsfn.tsfn = nullptr;
    }
}

static void createTsfn(napi_env env, napi_value jsCb, const char* name, TsfnData& tsfn) {
    abortTsfn(tsfn);
    napi_value resourceName;
    napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resourceName);
    napi_create_threadsafe_function(env, jsCb, nullptr, resourceName,
                                    0, 1, nullptr, nullptr, nullptr,
                                    tsfnCallback, &tsfn.tsfn);
}

// Helper to build an EventPayload lambda for native capture callbacks
static auto makeCaptureCallback(TsfnData& tsfn) {
    return [&tsfn](CaptureEvent ev) {
        EventPayload* p = new EventPayload();
        if (ev.kind == EventKind::VU) {
            p->kind  = EventPayload::VU;
            p->rmsDb = ev.vu.rmsDb;
        } else if (ev.kind == EventKind::CHUNK) {
            p->kind         = EventPayload::CHUNK;
            p->path         = ev.chunk.meta.path;
            p->seq          = ev.chunk.meta.seq;
            p->startSeconds = ev.chunk.meta.startSeconds;
            p->endSeconds   = ev.chunk.meta.endSeconds;
        } else {
            p->kind    = EventPayload::ERROR;
            p->message = ev.error.message;
        }
        napi_call_threadsafe_function(tsfn.tsfn, p, napi_tsfn_nonblocking);
    };
}

// ---- start(opts, cb) ----
static napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

#ifndef _WIN32
    napi_value typeStr, msgStr, errObj;
    napi_create_string_utf8(env, "error", NAPI_AUTO_LENGTH, &typeStr);
    napi_create_string_utf8(env, "WASAPI loopback is Windows-only", NAPI_AUTO_LENGTH, &msgStr);
    napi_create_object(env, &errObj);
    napi_set_named_property(env, errObj, "type", typeStr);
    napi_set_named_property(env, errObj, "message", msgStr);
    napi_value cbArgs[] = { errObj };
    napi_call_function(env, errObj, argv[1], 1, cbArgs, nullptr);
    return nullptr;
#else
    if (g_loopback && g_loopback->isRunning()) return nullptr;

    std::string sessionDir;
    int chunkSeconds = 10;
    int vuIntervalMs = 50;

    napi_value opts = argv[0];
    {
        napi_value v;
        char buf[1024];
        size_t len;

        if (napi_get_named_property(env, opts, "sessionDir", &v) == napi_ok) {
            napi_valuetype vt; napi_typeof(env, v, &vt);
            if (vt == napi_string) {
                napi_get_value_string_utf8(env, v, buf, sizeof(buf), &len);
                sessionDir = std::string(buf, len);
            }
        }
        if (napi_get_named_property(env, opts, "chunkSeconds", &v) == napi_ok) {
            napi_valuetype vt; napi_typeof(env, v, &vt);
            if (vt == napi_number) { double d; napi_get_value_double(env, v, &d); chunkSeconds = static_cast<int>(d); }
        }
        if (napi_get_named_property(env, opts, "vuIntervalMs", &v) == napi_ok) {
            napi_valuetype vt; napi_typeof(env, v, &vt);
            if (vt == napi_number) { double d; napi_get_value_double(env, v, &d); vuIntervalMs = static_cast<int>(d); }
        }
    }

    createTsfn(env, argv[1], "loopbackCapture", g_tsfn);

    if (!g_loopback) g_loopback = new WasapiLoopback();
    g_loopback->start(sessionDir, chunkSeconds, vuIntervalMs, makeCaptureCallback(g_tsfn));

    return nullptr;
#endif
}

// ---- stop() ----
static napi_value Stop(napi_env env, napi_callback_info /*info*/) {
#ifdef _WIN32
    if (g_loopback) g_loopback->stop();
    releaseTsfn(g_tsfn);
#endif
    return nullptr;
}

// ---- isRunning() ----
static napi_value IsRunning(napi_env env, napi_callback_info /*info*/) {
    bool running = false;
#ifdef _WIN32
    if (g_loopback) running = g_loopback->isRunning();
#endif
    napi_value result;
    napi_get_boolean(env, running, &result);
    return result;
}

// ---- listInputDevices() → Array<{id,name,isDefault}> ----
static napi_value ListInputDevices(napi_env env, napi_callback_info /*info*/) {
    napi_value arr;
    napi_create_array(env, &arr);

#ifdef _WIN32
    auto devices = listInputDevices();
    for (uint32_t i = 0; i < static_cast<uint32_t>(devices.size()); ++i) {
        napi_value obj;
        napi_create_object(env, &obj);

        napi_value id, name, isDef;
        napi_create_string_utf8(env, devices[i].id.c_str(),   NAPI_AUTO_LENGTH, &id);
        napi_create_string_utf8(env, devices[i].name.c_str(), NAPI_AUTO_LENGTH, &name);
        napi_get_boolean(env, devices[i].isDefault, &isDef);

        napi_set_named_property(env, obj, "id",        id);
        napi_set_named_property(env, obj, "name",      name);
        napi_set_named_property(env, obj, "isDefault", isDef);
        napi_set_element(env, arr, i, obj);
    }
#endif

    return arr;
}

// ---- startMic(opts, cb) ----
static napi_value StartMic(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

#ifndef _WIN32
    napi_value typeStr, msgStr, errObj;
    napi_create_string_utf8(env, "error", NAPI_AUTO_LENGTH, &typeStr);
    napi_create_string_utf8(env, "WASAPI mic capture is Windows-only", NAPI_AUTO_LENGTH, &msgStr);
    napi_create_object(env, &errObj);
    napi_set_named_property(env, errObj, "type", typeStr);
    napi_set_named_property(env, errObj, "message", msgStr);
    napi_value cbArgs[] = { errObj };
    napi_call_function(env, errObj, argv[1], 1, cbArgs, nullptr);
    return nullptr;
#else
    if (g_mic && g_mic->isRunning()) return nullptr;

    std::string sessionDir;
    std::string deviceId;
    int chunkSeconds = 10;
    int vuIntervalMs = 50;

    napi_value opts = argv[0];
    {
        napi_value v;
        char buf[2048];
        size_t len;

        if (napi_get_named_property(env, opts, "sessionDir", &v) == napi_ok) {
            napi_valuetype vt; napi_typeof(env, v, &vt);
            if (vt == napi_string) {
                napi_get_value_string_utf8(env, v, buf, sizeof(buf), &len);
                sessionDir = std::string(buf, len);
            }
        }
        if (napi_get_named_property(env, opts, "deviceId", &v) == napi_ok) {
            napi_valuetype vt; napi_typeof(env, v, &vt);
            if (vt == napi_string) {
                napi_get_value_string_utf8(env, v, buf, sizeof(buf), &len);
                deviceId = std::string(buf, len);
            }
        }
        if (napi_get_named_property(env, opts, "chunkSeconds", &v) == napi_ok) {
            napi_valuetype vt; napi_typeof(env, v, &vt);
            if (vt == napi_number) { double d; napi_get_value_double(env, v, &d); chunkSeconds = static_cast<int>(d); }
        }
        if (napi_get_named_property(env, opts, "vuIntervalMs", &v) == napi_ok) {
            napi_valuetype vt; napi_typeof(env, v, &vt);
            if (vt == napi_number) { double d; napi_get_value_double(env, v, &d); vuIntervalMs = static_cast<int>(d); }
        }
    }

    createTsfn(env, argv[1], "micCapture", g_tsfn_mic);

    if (!g_mic) g_mic = new WasapiMic();
    g_mic->start(sessionDir, deviceId, chunkSeconds, vuIntervalMs, makeCaptureCallback(g_tsfn_mic));

    return nullptr;
#endif
}

// ---- stopMic() ----
static napi_value StopMic(napi_env env, napi_callback_info /*info*/) {
#ifdef _WIN32
    if (g_mic) g_mic->stop();
    releaseTsfn(g_tsfn_mic);
#endif
    return nullptr;
}

// ---- isMicRunning() ----
static napi_value IsMicRunning(napi_env env, napi_callback_info /*info*/) {
    bool running = false;
#ifdef _WIN32
    if (g_mic) running = g_mic->isRunning();
#endif
    napi_value result;
    napi_get_boolean(env, running, &result);
    return result;
}

// ---- Module init ----
static napi_value Init(napi_env env, napi_value exports) {
    auto expose = [&](const char* name, napi_callback fn) {
        napi_value func;
        napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &func);
        napi_set_named_property(env, exports, name, func);
    };
    expose("start",            Start);
    expose("stop",             Stop);
    expose("isRunning",        IsRunning);
    expose("listInputDevices", ListInputDevices);
    expose("startMic",         StartMic);
    expose("stopMic",          StopMic);
    expose("isMicRunning",     IsMicRunning);
    return exports;
}

NAPI_MODULE(loopback_capture, Init)
