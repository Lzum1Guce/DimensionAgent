#include "dimension/model.hpp"
#include "dimension/network_proxy.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>
#include <wincodec.h>

#ifdef _MSC_VER
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowscodecs.lib")
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace dimension {
namespace {

constexpr std::size_t tool_limit = 128U;
constexpr auto request_text_error = "模型请求文本超过大小上限（Model text request exceeds size limit）";
constexpr auto request_image_error = "模型含图请求超过总大小上限（Model image request exceeds size limit）";
constexpr auto response_error = "模型响应流累计传输量超过大小上限（Model response transport exceeds size limit）";
constexpr auto output_error = "模型正文、思考和工具数据合计超过大小上限（Model decoded output exceeds size limit）";
constexpr auto sse_line_error = "模型 SSE 单行超过大小上限（Model SSE line exceeds size limit）";
constexpr auto sse_event_error = "模型 SSE 单事件超过大小上限（Model SSE event exceeds size limit）";
using Clock = std::chrono::steady_clock;

[[noreturn]] void fail(const char* message) { throw std::runtime_error(message); }

[[noreturn]] void network_error(DWORD code) {
    if (code == ERROR_WINHTTP_TIMEOUT) throw ModelError(ModelFailure::Timeout, "Model request timed out");
    // Neither an HTTP body, URL, nor a header is included in errors.
    if (code == ERROR_WINHTTP_NAME_NOT_RESOLVED || code == ERROR_WINHTTP_CANNOT_CONNECT ||
        code == ERROR_WINHTTP_CONNECTION_ERROR)
        throw ModelError(ModelFailure::Transport, "Model network error (WinHTTP " + std::to_string(code) + ")");
    throw std::runtime_error("Model network error (WinHTTP " + std::to_string(code) + ")");
}

void check_active(std::stop_token stop, Clock::time_point deadline) {
    if (stop.stop_requested()) throw ModelError(ModelFailure::Cancelled, "Model request cancelled");
    if (Clock::now() >= deadline) throw ModelError(ModelFailure::Timeout, "Model request timed out");
}

void image_dimensions(const ModelImage& image) {
    if (!image.width || !image.height || image.width > 8192U || image.height > 8192U ||
        static_cast<std::uint64_t>(image.width) * image.height > 16U * 1024U * 1024U)
        fail("Invalid model image dimensions");
}

constexpr auto base64_values = [] {
    std::array<int, 256> result{};
    result.fill(-1);
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (std::size_t i = 0; i < alphabet.size(); ++i)
        result[static_cast<unsigned char>(alphabet[i])] = static_cast<int>(i);
    return result;
}();

std::vector<std::uint8_t> image_bytes(const ModelImage& image, std::stop_token stop,
                                    Clock::time_point deadline) {
    if (image.mime_type != "image/png") fail("Model images require image/png");
    image_dimensions(image);
    const auto& source = image.base64_data;
    constexpr auto encoded_limit = ((model_image_binary_limit + 2U) / 3U) * 4U;
    if (source.empty() || source.size() > encoded_limit || source.size() % 4U)
        fail("Invalid model image base64 size");
    const auto padding = source.back() == '=' ? (source[source.size() - 2U] == '=' ? 2U : 1U) : 0U;
    const auto decoded_size = source.size() / 4U * 3U - padding;
    if (decoded_size > model_image_binary_limit) fail("Model image exceeds 5 MiB");
    std::vector<std::uint8_t> result;
    result.reserve(decoded_size);
    for (std::size_t i = 0; i < source.size(); i += 4U) {
        if ((i & 65535U) == 0U) check_active(stop, deadline);
        const auto a = base64_values[static_cast<unsigned char>(source[i])];
        const auto b = base64_values[static_cast<unsigned char>(source[i + 1U])];
        const auto c = base64_values[static_cast<unsigned char>(source[i + 2U])];
        const auto d = base64_values[static_cast<unsigned char>(source[i + 3U])];
        const bool pad_c = source[i + 2U] == '=';
        const bool pad_d = source[i + 3U] == '=';
        if (a < 0 || b < 0 || (c < 0 && !pad_c) || (d < 0 && !pad_d) ||
            (pad_c && !pad_d) || ((pad_c || pad_d) && i + 4U != source.size()) ||
            (pad_c && (b & 15)) || (!pad_c && pad_d && (c & 3)))
            fail("Invalid model image base64 encoding");
        result.push_back(static_cast<std::uint8_t>((a << 2) | (b >> 4)));
        if (!pad_c) result.push_back(static_cast<std::uint8_t>((b << 4) | (c >> 2)));
        if (!pad_d) result.push_back(static_cast<std::uint8_t>((c << 6) | d));
    }
    return result;
}

std::uint32_t big_endian(const std::uint8_t* value) {
    return (static_cast<std::uint32_t>(value[0]) << 24U) |
        (static_cast<std::uint32_t>(value[1]) << 16U) |
        (static_cast<std::uint32_t>(value[2]) << 8U) | value[3];
}

constexpr auto crc_values = [] {
    std::array<std::uint32_t, 256> result{};
    for (std::uint32_t i = 0; i < result.size(); ++i) {
        auto value = i;
        for (int bit = 0; bit < 8; ++bit) value = (value >> 1U) ^ ((value & 1U) ? 0xedb88320U : 0U);
        result[i] = value;
    }
    return result;
}();

void png_structure(const ModelImage& image, const std::vector<std::uint8_t>& bytes,
                   std::stop_token stop, Clock::time_point deadline) {
    constexpr std::array<std::uint8_t, 8> signature{137, 80, 78, 71, 13, 10, 26, 10};
    if (bytes.size() < 45U || !std::equal(signature.begin(), signature.end(), bytes.begin()))
        fail("Invalid model PNG signature");
    unsigned color = 0, depth = 0;
    bool palette = false, saw_data = false, ended_data = false;
    std::size_t data_bytes = 0;
    for (std::size_t offset = 8U; offset < bytes.size();) {
        check_active(stop, deadline);
        if (bytes.size() - offset < 12U) fail("Invalid model PNG chunk boundary");
        const auto length = static_cast<std::size_t>(big_endian(bytes.data() + offset));
        if (length > bytes.size() - offset - 12U) fail("Invalid model PNG chunk boundary");
        const auto* type_bytes = bytes.data() + offset + 4U;
        const std::string_view type(reinterpret_cast<const char*>(type_bytes), 4U);
        for (const auto c : type)
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')))
                fail("Invalid model PNG chunk type");
        if (type[2] < 'A' || type[2] > 'Z') fail("Invalid model PNG reserved chunk bit");
        std::uint32_t crc = 0xffffffffU;
        for (std::size_t i = 0; i < length + 4U; ++i) {
            if ((i & 65535U) == 0U) check_active(stop, deadline);
            crc = crc_values[(crc ^ type_bytes[i]) & 255U] ^ (crc >> 8U);
        }
        if ((crc ^ 0xffffffffU) != big_endian(type_bytes + length + 4U))
            fail("Invalid model PNG chunk checksum");
        const auto* payload = type_bytes + 4U;
        if (offset == 8U && type != "IHDR") fail("Invalid model PNG IHDR");
        if (type == "IHDR") {
            if (offset != 8U || length != 13U) fail("Invalid model PNG IHDR");
            if (big_endian(payload) != image.width || big_endian(payload + 4U) != image.height)
                fail("Model PNG dimensions do not match declaration");
            depth = payload[8]; color = payload[9];
            const bool valid_depth = color == 0U ? (depth == 1U || depth == 2U || depth == 4U || depth == 8U || depth == 16U) :
                color == 3U ? (depth == 1U || depth == 2U || depth == 4U || depth == 8U) :
                (color == 2U || color == 4U || color == 6U) && (depth == 8U || depth == 16U);
            if (!valid_depth || payload[10] || payload[11] || payload[12] > 1U)
                fail("Invalid model PNG IHDR format");
        } else if (type == "PLTE") {
            if (palette || saw_data || color == 0U || color == 4U || !length || length > 768U || length % 3U ||
                (color == 3U && length / 3U > (std::size_t{1} << depth))) fail("Invalid model PNG palette");
            palette = true;
        } else if (type == "IDAT") {
            if (ended_data || (color == 3U && !palette)) fail("Invalid model PNG image data order");
            saw_data = true;
            data_bytes += length;
        } else if (type == "IEND") {
            if (length || !data_bytes || offset + 12U != bytes.size()) fail("Invalid model PNG end");
            return;
        } else {
            if (type == "acTL" || type == "fcTL" || type == "fdAT") fail("Animated model PNG is not supported");
            if (type[0] >= 'A' && type[0] <= 'Z') fail("Unsupported model PNG critical chunk");
            if (saw_data) ended_data = true;
        }
        offset += length + 12U;
    }
    fail("Model PNG is missing IEND");
}

template<class T> struct ComRef {
    T* value = nullptr;
    ~ComRef() { if (value) value->Release(); }
    ComRef() = default;
    ComRef(const ComRef&) = delete;
    ComRef& operator=(const ComRef&) = delete;
    T** out() { return &value; }
    T* operator->() const { return value; }
};

struct ComApartment {
    HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ComApartment() {
        if (FAILED(result) && result != RPC_E_CHANGED_MODE) fail("Model PNG decoder initialization failed");
    }
    ~ComApartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};

// Decode through Windows' system PNG codec, within the prevalidated resource
// bounds. WIC can tolerate some malformed compressed streams; this is system
// decoding, not a claim of strict zlib/PNG conformance. Output is copied in
// cancellable strips and never persisted here.
void png_pixels(const ModelImage& image, std::vector<std::uint8_t>& bytes,
                std::stop_token stop, Clock::time_point deadline) {
    ComApartment apartment;
    ComRef<IWICImagingFactory> factory;
    ComRef<IWICStream> stream;
    ComRef<IWICBitmapDecoder> decoder;
    ComRef<IWICBitmapFrameDecode> frame;
    ComRef<IWICFormatConverter> rgba;
    const auto valid = [](HRESULT result) {
        if (FAILED(result)) fail("Invalid model PNG pixel data");
    };
    valid(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                          IID_PPV_ARGS(factory.out())));
    valid(factory->CreateStream(stream.out()));
    valid(stream->InitializeFromMemory(bytes.data(), static_cast<DWORD>(bytes.size())));
    valid(factory->CreateDecoderFromStream(stream.value, nullptr, WICDecodeMetadataCacheOnDemand, decoder.out()));
    UINT count = 0, width = 0, height = 0;
    valid(decoder->GetFrameCount(&count));
    if (count != 1U) fail("Model PNG requires one frame");
    valid(decoder->GetFrame(0, frame.out()));
    valid(frame->GetSize(&width, &height));
    if (width != image.width || height != image.height) fail("Model PNG decoder dimension mismatch");
    valid(factory->CreateFormatConverter(rgba.out()));
    valid(rgba->Initialize(frame.value, GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone,
                           nullptr, 0.0, WICBitmapPaletteTypeCustom));
    const UINT stride = width * 4U;
    std::vector<BYTE> pixels(static_cast<std::size_t>(stride) * std::min(height, 64U));
    for (UINT y = 0; y < height; y += 64U) {
        check_active(stop, deadline);
        const UINT rows = std::min(height - y, 64U);
        WICRect rect{0, static_cast<INT>(y), static_cast<INT>(width), static_cast<INT>(rows)};
        valid(rgba->CopyPixels(&rect, stride, stride * rows, pixels.data()));
    }
    check_active(stop, deadline);
}

void validate_image(const ModelImage& image, std::stop_token stop, Clock::time_point deadline) {
    check_active(stop, deadline);
    auto bytes = image_bytes(image, stop, deadline);
    png_structure(image, bytes, stop, deadline);
    png_pixels(image, bytes, stop, deadline);
}

void charge(std::size_t& used, std::size_t amount, std::size_t limit, const char* message) {
    if (amount > limit || used > limit - amount) fail(message);
    used += amount;
}

void validate_payload_limits(const ModelPayloadLimits& limits) {
    const auto& maximum = work_model_payload_limits;
    if (!limits.text_request_bytes || limits.text_request_bytes > maximum.text_request_bytes ||
        !limits.image_request_bytes || limits.image_request_bytes > maximum.image_request_bytes ||
        !limits.response_bytes || limits.response_bytes > maximum.response_bytes ||
        !limits.output_bytes || limits.output_bytes > maximum.output_bytes ||
        !limits.sse_line_bytes || limits.sse_line_bytes > maximum.sse_line_bytes ||
        !limits.sse_event_bytes || limits.sse_event_bytes > maximum.sse_event_bytes)
        fail("模型载荷配置超出支持范围（Invalid model payload limits）");
}

// Validate before copying caller-owned values into the request JSON. Counting
// escaped string sizes also bounds serialization, including control characters.
void charge_string(std::size_t& used, std::string_view text, std::size_t limit,
                   std::stop_token stop, Clock::time_point deadline) {
    charge(used, 2U, limit, request_text_error);
    for (std::size_t i = 0; i < text.size(); ++i) {
        if ((i & 65535U) == 0U) check_active(stop, deadline);
        const auto c = static_cast<unsigned char>(text[i]);
        charge(used, c < 0x20U ? 6U : (c == '"' || c == '\\' ? 2U : 1U), limit, request_text_error);
    }
}

void charge_json(std::size_t& used, const Json& value, std::size_t limit,
                 std::stop_token stop, Clock::time_point deadline, unsigned depth = 0) {
    check_active(stop, deadline);
    if (depth > 56U) fail("Model tool schema is nested too deeply");
    charge(used, 2U, limit, request_text_error);
    if (value.is_string()) charge_string(used, value.as_string(), limit, stop, deadline);
    else if (value.is_array()) {
        for (const auto& child : value.as_array()) charge_json(used, child, limit, stop, deadline, depth + 1U);
    } else if (value.is_object()) {
        for (const auto& [key, child] : value.as_object()) {
            charge_string(used, key, limit, stop, deadline);
            charge(used, 2U, limit, request_text_error);
            charge_json(used, child, limit, stop, deadline, depth + 1U);
        }
    } else charge(used, 32U, limit, request_text_error);
}

std::string request_body(const ModelConfig& config,
                         const std::vector<ModelMessage>& messages,
                         const std::vector<ModelTool>& tools, bool responses,
                         std::stop_token stop, Clock::time_point deadline) {
    if (config.model.empty() || config.model.size() > 512U) fail("Invalid model name");
    if (config.max_output_tokens <= 0) fail("Invalid model output token limit");
    if (messages.empty() || messages.size() > 2048U || tools.size() > tool_limit)
        fail("Invalid model message or tool count");
    std::size_t used = 256U;
    std::size_t image_count = 0U, image_size = 0U;
    const auto text_limit = config.payload_limits.text_request_bytes;
    const auto image_limit = config.payload_limits.image_request_bytes;
    const auto text = [&](std::string_view value) { charge_string(used, value, text_limit, stop, deadline); };
    text(config.model);
    for (const auto& message : messages) {
        check_active(stop, deadline);
        if (message.role != "system" && message.role != "developer" && message.role != "user" &&
            message.role != "assistant" && message.role != "tool") fail("Invalid model message role");
        if (message.tool_calls.size() > tool_limit) fail("Too many model tool calls");
        if (!message.tool_calls.empty() && message.role != "assistant") fail("Tool calls require assistant role");
        if (message.role == "tool" && message.tool_call_id.empty()) fail("Tool output is missing its call ID");
        if (!message.images.empty() && message.role != "user") fail("Model images require user role");
        if (message.images.size() > model_image_count_limit - image_count) fail("Too many model images (maximum 2)");
        image_count += message.images.size();
        for (const auto& image : message.images) {
            charge(image_size, 128U, image_limit, request_image_error);
            charge(image_size, image.base64_data.size(), image_limit, request_image_error);
        }
        charge(used, 128U, text_limit, request_text_error);
        text(message.content);
        text(message.tool_call_id);
        if (config.preserve_reasoning_content) text(message.reasoning_content);
        for (const auto& call : message.tool_calls) {
            if (call.id.empty() || call.name.empty()) fail("Incomplete model tool call in history");
            charge(used, 128U, text_limit, request_text_error);
            text(call.id);
            text(call.name);
            text(call.arguments);
        }
    }
    for (const auto& tool : tools) {
        if (tool.name.empty() || !tool.parameters.is_object()) fail("Invalid model tool definition");
        charge(used, 128U, text_limit, request_text_error);
        text(tool.name);
        text(tool.description);
        charge_json(used, tool.parameters, text_limit, stop, deadline);
    }
    const auto request_limit = image_count ? image_limit : text_limit;
    const auto request_error = image_count ? request_image_error : request_text_error;
    auto combined_size = used;
    charge(combined_size, image_size, request_limit, request_error);
    for (const auto& message : messages)
        for (const auto& image : message.images) validate_image(image, stop, deadline);

    Json::Array input;
    for (const auto& message : messages) {
        check_active(stop, deadline);
        Json content = message.content;
        if (!message.images.empty()) {
            Json::Array parts;
            parts.emplace_back(Json::Object{{"type", responses ? "input_text" : "text"}, {"text", message.content}});
            for (const auto& image : message.images) {
                auto url = "data:image/png;base64," + image.base64_data;
                if (responses)
                    parts.emplace_back(Json::Object{{"type", "input_image"}, {"image_url", std::move(url)}});
                else
                    parts.emplace_back(Json::Object{{"type", "image_url"},
                        {"image_url", Json::Object{{"url", std::move(url)}}}});
            }
            content = Json(std::move(parts));
        }
        if (responses) {
            if (message.role == "tool") {
                input.emplace_back(Json::Object{{"type", "function_call_output"},
                    {"call_id", message.tool_call_id}, {"output", message.content}});
            } else {
                if (!message.content.empty() || message.tool_calls.empty())
                    input.emplace_back(Json::Object{{"role", message.role}, {"content", std::move(content)}});
                for (const auto& call : message.tool_calls)
                    input.emplace_back(Json::Object{{"type", "function_call"}, {"call_id", call.id},
                        {"name", call.name}, {"arguments", call.arguments}});
            }
        } else {
            Json::Object item{{"role", message.role}, {"content", std::move(content)}};
            if (message.role == "tool") item.emplace("tool_call_id", message.tool_call_id);
            if (message.role == "assistant" && config.preserve_reasoning_content)
                item.emplace("reasoning_content", message.reasoning_content);
            if (!message.tool_calls.empty()) {
                Json::Array calls;
                for (const auto& call : message.tool_calls)
                    calls.emplace_back(Json::Object{{"id", call.id}, {"type", "function"},
                        {"function", Json::Object{{"name", call.name}, {"arguments", call.arguments}}}});
                item.emplace("tool_calls", std::move(calls));
            }
            input.emplace_back(std::move(item));
        }
    }
    if (config.temperature &&
        (!std::isfinite(*config.temperature) || *config.temperature < 0.0 || *config.temperature > 2.0))
        fail("Invalid model temperature");
    Json::Object body{{"model", config.model}, {"stream", true},
        {responses ? "input" : "messages", std::move(input)},
        {responses ? "max_output_tokens" : "max_tokens", config.max_output_tokens}};
    if (!responses) {
        body.emplace("stream_options", Json::Object{{"include_usage", true}});
        if (config.thinking_enabled)
            body.emplace("thinking", Json::Object{{"type", *config.thinking_enabled ? "enabled" : "disabled"}});
        if (!config.reasoning_effort.empty()) body.emplace("reasoning_effort", config.reasoning_effort);
    }
    if (config.temperature) body.emplace("temperature", *config.temperature);
    if (!tools.empty()) {
        Json::Array definitions;
        for (const auto& tool : tools) {
            Json::Object function{{"name", tool.name}, {"description", tool.description},
                {"parameters", tool.parameters}};
            if (responses) {
                function.emplace("type", "function");
                function.emplace("strict", false);
                definitions.emplace_back(std::move(function));
            } else {
                definitions.emplace_back(Json::Object{{"type", "function"}, {"function", std::move(function)}});
            }
        }
        body.emplace("tools", std::move(definitions));
    }
    auto result = Json(std::move(body)).dump();
    if (result.size() > request_limit) fail(request_error);
    check_active(stop, deadline);
    return result;
}

std::wstring wide(std::string_view text) {
    if (text.empty()) return {};
    if (text.size() > static_cast<std::size_t>((std::numeric_limits<int>::max)()) ||
        text.find('\0') != std::string_view::npos) fail("Invalid model configuration text");
    const auto size = static_cast<int>(text.size());
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), size, nullptr, 0);
    if (!count) fail("Invalid UTF-8 in model configuration");
    std::wstring result(static_cast<std::size_t>(count), L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), size, result.data(), count))
        fail("Invalid UTF-8 in model configuration");
    return result;
}

struct Endpoint {
    std::wstring host;
    std::wstring path;
    INTERNET_PORT port{};
    bool secure{};
};

Endpoint endpoint(const std::string& base_url, bool responses, bool catalog = false) {
    if (base_url.empty() || base_url.size() > 16384U) fail("Invalid model base URL");
    for (unsigned char c : base_url)
        if (c <= 0x20U || c == 0x7FU || c == '#' || c == '\\') fail("Invalid model base URL");
    const auto url = wide(base_url);
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = parts.dwHostNameLength = parts.dwUserNameLength =
        parts.dwPasswordLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts))
        fail("Invalid model base URL");
    if ((parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS) ||
        !parts.dwHostNameLength || parts.dwUserNameLength || parts.dwPasswordLength)
        fail("Model URL requires HTTP(S) without embedded credentials");
    Endpoint result;
    result.host.assign(parts.lpszHostName, parts.dwHostNameLength);
    if (parts.dwUrlPathLength) result.path.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
    while (!result.path.empty() && result.path.back() == L'/') result.path.pop_back();
    const std::wstring_view suffix = responses ? L"/responses" : L"/chat/completions";
    const std::wstring_view other = responses ? L"/chat/completions" : L"/responses";
    if (result.path.ends_with(other)) fail("Model endpoint does not match protocol");
    if (catalog) {
        if (result.path.ends_with(suffix)) result.path.resize(result.path.size() - suffix.size());
        result.path += L"/models";
    } else if (!result.path.ends_with(suffix)) result.path += suffix;
    if (parts.dwExtraInfoLength) result.path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    result.port = parts.nPort;
    result.secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
    return result;
}

class InternetHandle {
public:
    explicit InternetHandle(HINTERNET value) : value_(value) { if (!value_) network_error(GetLastError()); }
    ~InternetHandle() { WinHttpCloseHandle(value_); }
    InternetHandle(const InternetHandle&) = delete;
    InternetHandle& operator=(const InternetHandle&) = delete;
    HINTERNET get() const noexcept { return value_; }
private:
    HINTERNET value_;
};

// The asynchronous handle allows cancellation while DNS, TLS, headers or body
// reads are pending. Its callback touches only this state, never caller code.
// HANDLE_CLOSING is the final callback; we wait for it before destroying state
// and the receive buffer, including exception/cancellation paths.
class AsyncRequest {
public:
    explicit AsyncRequest(HINTERNET value) : value_(value) {
        if (!value_) network_error(GetLastError());
        DWORD_PTR context = reinterpret_cast<DWORD_PTR>(this);
        if (!WinHttpSetOption(value_, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context))) {
            const DWORD error = GetLastError();
            WinHttpCloseHandle(value_);
            network_error(error);
        }
        if (WinHttpSetStatusCallback(value_, callback,
                WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS | WINHTTP_CALLBACK_FLAG_HANDLES, 0) ==
                WINHTTP_INVALID_STATUS_CALLBACK) {
            const DWORD error = GetLastError();
            WinHttpCloseHandle(value_);
            network_error(error);
        }
    }
    ~AsyncRequest() {
        if (WinHttpCloseHandle(value_)) {
            std::unique_lock lock(mutex_);
            changed_.wait(lock, [this] { return closed_; });
        }
    }
    AsyncRequest(const AsyncRequest&) = delete;
    AsyncRequest& operator=(const AsyncRequest&) = delete;
    HINTERNET get() const noexcept { return value_; }

    template<class Start>
    DWORD perform(DWORD expected, Start&& start, std::stop_token stop, Clock::time_point deadline) {
        check_active(stop, deadline);
        {
            std::lock_guard lock(mutex_);
            expected_ = expected;
            completed_ = false;
            error_ = 0;
            transferred_ = 0;
        }
        if (!start()) {
            const DWORD error = GetLastError();
            if (error != ERROR_IO_PENDING) {
                check_active(stop, deadline);
                network_error(error);
            }
        }
        std::unique_lock lock(mutex_);
        changed_.wait_until(lock, stop, deadline, [this] { return completed_; });
        check_active(stop, deadline);
        if (!completed_) throw ModelError(ModelFailure::Timeout, "Model request timed out");
        if (error_) network_error(error_);
        return transferred_;
    }

    std::string_view read(std::stop_token stop, Clock::time_point deadline) {
        // Read only the currently available bytes. Asking WinHTTP to fill the
        // entire buffer can defer a small SSE event until a later event/EOF.
        const DWORD available = perform(WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE, [&] {
            return WinHttpQueryDataAvailable(value_, nullptr);
        }, stop, deadline);
        if (!available) return {};
        const DWORD requested = (std::min)(available, static_cast<DWORD>(buffer_.size()));
        const DWORD size = perform(WINHTTP_CALLBACK_STATUS_READ_COMPLETE, [&] {
            return WinHttpReadData(value_, buffer_.data(), requested, nullptr);
        }, stop, deadline);
        if (size > buffer_.size()) fail("Invalid model response read size");
        return {buffer_.data(), size};
    }

private:
    HINTERNET value_;
    std::mutex mutex_;
    std::condition_variable_any changed_;
    bool closed_ = false;
    bool completed_ = false;
    DWORD expected_ = 0;
    DWORD error_ = 0;
    DWORD transferred_ = 0;
    std::array<char, 16384> buffer_{};

    static void CALLBACK callback(HINTERNET, DWORD_PTR context, DWORD status,
                                   void* info, DWORD size) noexcept {
        if (!context) return;
        auto& self = *reinterpret_cast<AsyncRequest*>(context);
        std::lock_guard lock(self.mutex_);
        if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) self.closed_ = true;
        else if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR) {
            self.error_ = info && size >= sizeof(WINHTTP_ASYNC_RESULT)
                ? static_cast<WINHTTP_ASYNC_RESULT*>(info)->dwError : ERROR_WINHTTP_INTERNAL_ERROR;
            self.completed_ = true;
        } else if (status == self.expected_) {
            self.completed_ = true;
            if (status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE) self.transferred_ = size;
            else if (status == WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE) {
                if (info && size >= sizeof(DWORD)) self.transferred_ = *static_cast<DWORD*>(info);
                else self.error_ = ERROR_WINHTTP_INTERNAL_ERROR;
            }
        }
        self.changed_.notify_all();
    }
};

void set_option(HINTERNET handle, DWORD option, DWORD value) {
    if (!WinHttpSetOption(handle, option, &value, sizeof(value))) network_error(GetLastError());
}

std::wstring header(HINTERNET request, DWORD kind) {
    DWORD size = 0;
    if (!WinHttpQueryHeaders(request, kind, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size,
                            WINHTTP_NO_HEADER_INDEX)) {
        const auto error = GetLastError();
        if (error == ERROR_WINHTTP_HEADER_NOT_FOUND) return {};
        if (error != ERROR_INSUFFICIENT_BUFFER) network_error(error);
    }
    if (size > 16384U) fail("Model response header is too long");
    std::wstring value(size / sizeof(wchar_t) + 1U, L'\0');
    if (!WinHttpQueryHeaders(request, kind, WINHTTP_HEADER_NAME_BY_INDEX, value.data(), &size,
                             WINHTTP_NO_HEADER_INDEX)) network_error(GetLastError());
    value.resize(size / sizeof(wchar_t));
    while (!value.empty() && value.back() == L'\0') value.pop_back();
    return value;
}

const std::string& string_member(const Json& value, std::string_view key) {
    static const std::string empty;
    const auto* member = value.find(key);
    if (!member || member->is_null()) return empty;
    if (!member->is_string()) fail("Invalid string in model response");
    return member->as_string();
}

int nonnegative_integer(const Json& value) {
    if (!value.is_number()) fail("Invalid integer in model response");
    const double n = value.as_number();
    if (n < 0 || n > (std::numeric_limits<int>::max)() || std::floor(n) != n)
        fail("Invalid integer in model response");
    return static_cast<int>(n);
}

int index_member(const Json& value, std::string_view key, bool required = true) {
    const auto* index = value.find(key);
    if (!index && !required) return 0;
    if (!index) fail("Missing index in model response");
    const auto result = nonnegative_integer(*index);
    if (result >= static_cast<int>(tool_limit)) fail("Model response index exceeds limit");
    return result;
}

bool context_window_error(const Json& value) {
    const auto* nested = value.find("error");
    const auto& error = nested && nested->is_object() ? *nested : value;
    const auto lower_string = [](const Json* field) {
        if (!field || !field->is_string() || field->as_string().size() > 16384U) return std::string{};
        auto text = field->as_string();
        for (auto& c : text) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
        return text;
    };
    for (const auto* key : {"code", "type"}) {
        const auto code = lower_string(error.find(key));
        if (code == "context_length_exceeded" || code == "context_window_exceeded" ||
            code == "max_context_length_exceeded" || code == "maximum_context_length_exceeded") return true;
    }
    const auto message = lower_string(error.find("message"));
    const auto has = [&](std::string_view term) { return message.find(term) != std::string::npos; };
    if (has("not exceed") || has("not been exceeded") || has("not too long")) return false;
    return ((has("context length") || has("context window")) &&
                (has("exceed") || has("too long") || has("too large"))) ||
        (has("maximum context length") && has("tokens") && has("please reduce") &&
            (has("you requested") || has("messages resulted in"))) ||
        (has("prompt is too long") && has("tokens") && has("maximum"));
}

[[noreturn]] void provider_error(const Json& value, const char* fallback) {
    if (context_window_error(value))
        throw ModelError(ModelFailure::ContextWindowExceeded,
            "模型服务报告上下文窗口已超限（Model context window exceeded）");
    fail(fallback);
}

class ReplyReader {
public:
    ReplyReader(bool responses, ModelChunk callback, std::stop_token stop, Clock::time_point deadline,
                const ModelPayloadLimits& limits)
        : responses_(responses), callback_(std::move(callback)), stop_(stop), deadline_(deadline), limits_(limits) {}

    bool done() const noexcept { return done_; }
    void active() const { check_active(stop_, deadline_); }

    void event(std::string_view text, std::string_view event_name) {
        check_active(stop_, deadline_);
        if (done_) return;
        if (text == "[DONE]") {
            if (responses_ && !terminal_) fail("Responses stream ended without completion");
            done_ = true;
            terminal_ = true;
            return;
        }
        const auto value = Json::parse(text, limits_.sse_event_bytes);
        active();
        if (!value.is_object()) fail("Model response is not an object");
        if (event_name == "error") provider_error(value, "Model provider returned a stream error");
        if (const auto* error = value.find("error"); error && !error->is_null())
            provider_error(value, "Model provider returned an error");
        if (responses_) read_responses_event(value, event_name);
        else read_chat(value, true);
    }

    void json(std::string_view text) {
        active();
        const auto value = Json::parse(text, limits_.response_bytes);
        active();
        if (!value.is_object()) fail("Model response is not an object");
        if (const auto* error = value.find("error"); error && !error->is_null())
            provider_error(value, "Model provider returned an error");
        if (responses_) read_response_object(value);
        else read_chat(value, false);
        terminal_ = true;
        done_ = true;
    }

    ModelReply finish() {
        check_active(stop_, deadline_);
        if (!terminal_ || !seen_) fail("Model stream ended before a complete response");
        for (auto& [index, call] : calls_) {
            (void)index;
            if (call.id.empty() || call.name.empty() || call.arguments.empty())
                fail("Model returned an incomplete tool call");
            // Never return a partial function argument document to the runner.
            if (!Json::parse(call.arguments, limits_.output_bytes).is_object())
                fail("Model tool arguments must be a JSON object");
            active();
            reply_.tool_calls.push_back(std::move(call));
        }
        return std::move(reply_);
    }

private:
    bool responses_;
    ModelChunk callback_;
    std::stop_token stop_;
    Clock::time_point deadline_;
    ModelPayloadLimits limits_;
    ModelReply reply_;
    std::map<int, ToolCall> calls_;
    std::size_t emitted_ = 0;
    bool done_ = false;
    bool terminal_ = false;
    bool seen_ = false;
    bool thinking_emitted_ = false;

    void emit(std::string_view kind, std::string_view text) {
        if (text.empty()) return;
        charge(emitted_, text.size(), limits_.output_bytes, output_error);
        check_active(stop_, deadline_);
        if (kind == "text") reply_.text += text;
        else {
            reply_.reasoning_content += text;
            thinking_emitted_ = true;
        }
        if (callback_) callback_(kind, text);
        check_active(stop_, deadline_);
    }

    void append_tool(std::string& target, std::string_view fragment) {
        charge(emitted_, fragment.size(), limits_.output_bytes, output_error);
        active();
        target += fragment;
    }

    void tool_snapshot(std::string& target, const std::string& snapshot, bool require_prefix) {
        if (require_prefix && !snapshot.starts_with(target)) fail("Inconsistent model tool argument snapshot");
        // Responses repeats complete tool snapshots. Only newly retained bytes
        // count, so normal delta/done/completed sequences are not charged twice.
        if (snapshot.size() > target.size())
            charge(emitted_, snapshot.size() - target.size(), limits_.output_bytes, output_error);
        else emitted_ -= target.size() - snapshot.size();
        active();
        target = snapshot;
    }

    void text_content(const Json& value) {
        const auto* content = value.find("content");
        if (!content || content->is_null()) return;
        if (content->is_string()) emit("text", content->as_string());
        else if (content->is_array()) {
            for (const auto& item : content->as_array()) {
                const auto& type = string_member(item, "type");
                if (type == "text" || type == "output_text") emit("text", string_member(item, "text"));
            }
        } else fail("Invalid content in model response");
    }

    void usage(const Json& value, bool responses) {
        const auto* item = value.find("usage");
        if (!item || item->is_null()) return;
        if (!item->is_object()) fail("Invalid model usage object");
        if (const auto* input = item->find(responses ? "input_tokens" : "prompt_tokens"))
            if (!input->is_null()) reply_.input_tokens = nonnegative_integer(*input);
        if (const auto* output = item->find(responses ? "output_tokens" : "completion_tokens"))
            if (!output->is_null()) reply_.output_tokens = nonnegative_integer(*output);
    }

    void read_chat(const Json& value, bool streaming) {
        usage(value, false);
        const auto* choices = value.find("choices");
        if (!choices || !choices->is_array()) fail("Model response is missing choices");
        for (const auto& choice : choices->as_array()) {
            if (index_member(choice, "index", false) != 0) continue;
            const auto* payload = choice.find(streaming ? "delta" : "message");
            if (payload && payload->is_object()) {
                seen_ = true;
                emit("thinking", string_member(*payload, "reasoning_content"));
                emit("thinking", string_member(*payload, "reasoning"));
                emit("thinking", string_member(*payload, "thinking"));
                text_content(*payload);
                emit("text", string_member(*payload, "refusal"));
                if (const auto* calls = payload->find("tool_calls"); calls && !calls->is_null()) {
                    if (!calls->is_array() || calls->as_array().size() > tool_limit)
                        fail("Invalid model tool call list");
                    int position = 0;
                    for (const auto& item : calls->as_array()) {
                        const int index = streaming ? index_member(item, "index") : position;
                        ++position;
                        auto& call = calls_[index];
                        append_tool(call.id, string_member(item, "id"));
                        const auto& type = string_member(item, "type");
                        if (!type.empty() && type != "function") fail("Unsupported model tool call type");
                        if (const auto* function = item.find("function")) {
                            if (!function->is_object()) fail("Invalid model tool call function");
                            append_tool(call.name, string_member(*function, "name"));
                            append_tool(call.arguments, string_member(*function, "arguments"));
                        }
                    }
                }
            } else if (!streaming) fail("Model response is missing a message");
            const auto& finish = string_member(choice, "finish_reason");
            if (!finish.empty()) {
                if (finish == "length") throw ModelError(ModelFailure::OutputLimit, "Model output token limit reached");
                if (finish == "content_filter") fail("Model output was filtered");
                terminal_ = true;
            }
        }
    }

    void complete_tool(int index, const Json& item) {
        auto& call = calls_[index];
        const auto& id = string_member(item, "call_id");
        const auto& name = string_member(item, "name");
        const auto& args = string_member(item, "arguments");
        if (!id.empty()) tool_snapshot(call.id, id, false);
        if (!name.empty()) tool_snapshot(call.name, name, false);
        if (!args.empty()) tool_snapshot(call.arguments, args, true);
    }

    void read_response_object(const Json& value) {
        const auto& status = string_member(value, "status");
        if (status == "incomplete") {
            const auto* details = value.find("incomplete_details");
            if (details && details->is_object() && string_member(*details, "reason") == "max_output_tokens")
                throw ModelError(ModelFailure::OutputLimit, "Model output token limit reached");
        }
        if (!status.empty() && status != "completed") fail("Model response did not complete");
        usage(value, true);
        const auto* output = value.find("output");
        if (!output || !output->is_array()) fail("Responses result is missing output");
        std::string full_text;
        std::string summary;
        int index = 0;
        for (const auto& item : output->as_array()) {
            if (index >= static_cast<int>(tool_limit)) fail("Too many model output items");
            const auto& type = string_member(item, "type");
            if (type == "function_call") complete_tool(index, item);
            else if (type == "reasoning") {
                if (const auto* parts = item.find("summary"); parts && !parts->is_null()) {
                    if (!parts->is_array()) fail("Invalid Responses reasoning summary");
                    for (const auto& part : parts->as_array())
                        if (string_member(part, "type") == "summary_text") summary += string_member(part, "text");
                }
            } else if (type == "message") {
                const auto* content = item.find("content");
                if (!content || !content->is_array()) fail("Invalid Responses message content");
                for (const auto& part : content->as_array()) {
                    const auto& part_type = string_member(part, "type");
                    if (part_type == "output_text") full_text += string_member(part, "text");
                    else if (part_type == "refusal") full_text += string_member(part, "refusal");
                }
            }
            ++index;
        }
        if (!full_text.starts_with(reply_.text)) fail("Inconsistent model text snapshot");
        // Non-streaming results can contain public reasoning summaries. The
        // completed snapshot must not repeat already-delivered thought deltas.
        if (!thinking_emitted_) emit("thinking", summary);
        emit("text", std::string_view(full_text).substr(reply_.text.size()));
        seen_ = true;
        terminal_ = true;
    }

    void read_responses_event(const Json& value, std::string_view event_name) {
        const auto& type_field = string_member(value, "type");
        const std::string_view type = type_field.empty() ? event_name : std::string_view(type_field);
        if (type == "response.incomplete") {
            const auto* response = value.find("response");
            if (response && response->is_object()) {
                const auto* details = response->find("incomplete_details");
                if (details && details->is_object() && string_member(*details, "reason") == "max_output_tokens")
                    throw ModelError(ModelFailure::OutputLimit, "Model output token limit reached");
            }
        }
        if (type == "error" || type == "response.failed" || type == "response.incomplete") {
            const auto* response = value.find("response");
            provider_error(response && response->is_object() ? *response : value,
                "Model provider returned an unsuccessful response");
        }
        if (type == "response.output_text.delta" || type == "response.refusal.delta") {
            emit("text", string_member(value, "delta"));
            seen_ = true;
        } else if (type == "response.reasoning_summary_text.delta" || type == "response.reasoning_text.delta") {
            emit("thinking", string_member(value, "delta"));
        } else if (type == "response.output_item.added" || type == "response.output_item.done") {
            const auto* item = value.find("item");
            if (!item || !item->is_object()) fail("Invalid Responses output item");
            if (string_member(*item, "type") == "function_call") {
                complete_tool(index_member(value, "output_index"), *item);
                seen_ = true;
            }
        } else if (type == "response.function_call_arguments.delta") {
            auto& call = calls_[index_member(value, "output_index")];
            append_tool(call.arguments, string_member(value, "delta"));
            seen_ = true;
        } else if (type == "response.function_call_arguments.done") {
            auto& call = calls_[index_member(value, "output_index")];
            const auto& args = string_member(value, "arguments");
            tool_snapshot(call.arguments, args, true);
        } else if (type == "response.completed") {
            const auto* response = value.find("response");
            if (!response || !response->is_object()) fail("Invalid Responses completion event");
            read_response_object(*response);
            done_ = true;
        }
    }
};

class SseReader {
public:
    SseReader(ReplyReader& reader, const ModelPayloadLimits& limits) : reader_(reader), limits_(limits) {}

    void feed(std::string_view bytes) {
        reader_.active();
        std::size_t scanned = 0;
        for (char c : bytes) {
            if ((scanned++ & 65535U) == 0U) reader_.active();
            if (reader_.done()) return;
            if (skip_lf_) {
                skip_lf_ = false;
                if (c == '\n') continue;
            }
            if (c == '\r' || c == '\n') {
                line();
                skip_lf_ = c == '\r';
            } else {
                if (line_.size() == limits_.sse_line_bytes) fail(sse_line_error);
                line_ += c;
            }
        }
    }

    void finish() {
        if (reader_.done()) return;
        if (!line_.empty()) line();
        dispatch();
    }

private:
    ReplyReader& reader_;
    ModelPayloadLimits limits_;
    std::string line_;
    std::string data_;
    std::string event_;
    bool skip_lf_ = false;
    bool first_line_ = true;
    bool has_data_ = false;

    void dispatch() {
        if (has_data_) reader_.event(data_, event_);
        data_.clear();
        event_.clear();
        has_data_ = false;
    }

    void line() {
        std::string_view current(line_);
        if (first_line_) {
            first_line_ = false;
            if (current.starts_with("\xEF\xBB\xBF")) current.remove_prefix(3);
        }
        if (current.empty()) dispatch();
        else if (current.front() != ':') {
            const auto colon = current.find(':');
            const auto field = current.substr(0, colon);
            auto value = colon == std::string_view::npos ? std::string_view{} : current.substr(colon + 1U);
            if (!value.empty() && value.front() == ' ') value.remove_prefix(1);
            if (field == "data") {
                std::size_t used = data_.size();
                charge(used, value.size() + (has_data_ ? 1U : 0U), limits_.sse_event_bytes, sse_event_error);
                if (has_data_) data_ += '\n';
                data_ += value;
                has_data_ = true;
            } else if (field == "event") event_ = value;
        }
        line_.clear();
    }
};

} // namespace

void validate_model_image(const ModelImage& image, std::stop_token stop) {
    validate_image(image, stop, Clock::time_point::max());
}

void validate_model_images(const std::vector<ModelImage>& images, std::stop_token stop) {
    check_active(stop, Clock::time_point::max());
    if (images.size() > model_image_count_limit) fail("Too many model images (maximum 2)");
    for (const auto& image : images) validate_image(image, stop, Clock::time_point::max());
}

std::size_t model_image_context_cost(const ModelImage& image) {
    image_dimensions(image);
    return 2048U + 4U * ((static_cast<std::size_t>(image.width) + 31U) / 32U) *
        ((static_cast<std::size_t>(image.height) + 31U) / 32U);
}

ModelReply call_model(const ModelConfig& config, const std::vector<ModelMessage>& messages,
                      const std::vector<ModelTool>& tools, ModelChunk chunk, std::stop_token stop) {
    if (config.protocol != "chat-completions" && config.protocol != "responses")
        fail("Unsupported model protocol (expected chat-completions or responses)");
    if (config.timeout_ms <= 0) fail("Invalid model timeout");
    if (config.idle_timeout_ms < 0 || config.connect_timeout_ms < 0) fail("Invalid model phase timeout");
    validate_payload_limits(config.payload_limits);
    const auto deadline = Clock::now() + std::chrono::milliseconds(config.timeout_ms);
    const int idle_ms = config.idle_timeout_ms ? config.idle_timeout_ms : config.timeout_ms;
    const int connect_ms = config.connect_timeout_ms ? config.connect_timeout_ms : config.timeout_ms;
    const auto io_deadline = [&] {
        return (std::min)(deadline, Clock::now() + std::chrono::milliseconds(idle_ms));
    };
    check_active(stop, deadline);
    const bool responses = config.protocol == "responses";
    const auto target = endpoint(config.base_url, responses);
    const auto body = request_body(config, messages, tools, responses, stop, deadline);
    if (config.api_key.size() > 8192U) fail("Invalid model API key");
    for (unsigned char c : config.api_key)
        if (c < 0x21U || c > 0x7EU) fail("Invalid model API key");
    std::wstring headers = L"Content-Type: application/json\r\nAccept: text/event-stream, application/json\r\n";
    if (!config.api_key.empty()) headers += L"Authorization: Bearer " + wide(config.api_key) + L"\r\n";
    check_active(stop, deadline);

    auto acquire_model_session = []() -> std::shared_ptr<void> {
        static std::mutex session_mu;
        static std::uint64_t cached_gen = 0;
        static std::shared_ptr<void> cached_session;
        const std::uint64_t cur_gen = network_proxy_generation();
        std::lock_guard lk(session_mu);
        if (cached_session && cached_gen == cur_gen) {
            return cached_session;
        }
        HINTERNET h = open_configured_winhttp_session(L"DimensionAgentNative/0.4", WINHTTP_FLAG_ASYNC);
        if (!h) network_error(GetLastError());
        DWORD max_conns = 32;
        WinHttpSetOption(h, WINHTTP_OPTION_MAX_CONNS_PER_SERVER, &max_conns, sizeof(max_conns));
        WinHttpSetOption(h, WINHTTP_OPTION_MAX_CONNS_PER_1_0_SERVER, &max_conns, sizeof(max_conns));
#ifdef WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL
#ifdef WINHTTP_PROTOCOL_FLAG_HTTP2
        DWORD proto = WINHTTP_PROTOCOL_FLAG_HTTP2;
        WinHttpSetOption(h, WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL, &proto, sizeof(proto));
#endif
#endif
        cached_session = std::shared_ptr<void>(h, [](void* p) {
            if (p) WinHttpCloseHandle(static_cast<HINTERNET>(p));
        });
        cached_gen = cur_gen;
        return cached_session;
    };
    const auto shared_session_guard = acquire_model_session();
    InternetHandle connection(WinHttpConnect(static_cast<HINTERNET>(shared_session_guard.get()), target.host.c_str(), target.port, 0));
    AsyncRequest request(WinHttpOpenRequest(connection.get(), L"POST", target.path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, target.secure ? WINHTTP_FLAG_SECURE : 0));
    if (!WinHttpSetTimeouts(request.get(), connect_ms, connect_ms, idle_ms, idle_ms)) network_error(GetLastError());
    set_option(request.get(), WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER);
    set_option(request.get(), WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION);
    set_option(request.get(), WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE, 64U * 1024U);
    set_option(request.get(), WINHTTP_OPTION_AUTOLOGON_POLICY, WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH);
    // Deliberately never set SECURITY_FLAG_IGNORE_* or disable certificate checks.
    request.perform(WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, [&] {
        return WinHttpSendRequest(request.get(), headers.c_str(), static_cast<DWORD>(headers.size()),
            const_cast<char*>(body.data()), static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()),
            reinterpret_cast<DWORD_PTR>(&request));
    }, stop, io_deadline());
    request.perform(WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE,
        [&] { return WinHttpReceiveResponse(request.get(), nullptr); }, stop, io_deadline());

    DWORD status = 0;
    DWORD status_size = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX)) network_error(GetLastError());
    if (status >= 300U && status < 400U) fail("Model HTTP redirect refused");
    if (status < 200U || status >= 300U) {
        // Read only a small error envelope, never return/log provider text.
        // A generic 400/413 is not evidence of context overflow or a retry cue.
        if (status == 400U || status == 413U || status == 422U) {
            constexpr std::size_t error_limit = 64U * 1024U;
            std::string error_body;
            bool complete = false;
            while (error_body.size() <= error_limit) {
                const auto bytes = request.read(stop, io_deadline());
                if (bytes.empty()) { complete = true; break; }
                if (bytes.size() > error_limit - error_body.size()) break;
                error_body += bytes;
            }
            bool overflow = false;
            if (complete) {
                try { overflow = context_window_error(Json::parse(error_body, error_limit)); }
                catch (const std::runtime_error&) { /* Malformed error envelopes remain HTTP errors. */ }
            }
            check_active(stop, deadline);
            if (overflow) throw ModelError(ModelFailure::ContextWindowExceeded,
                "模型服务报告上下文窗口已超限（Model context window exceeded）", static_cast<int>(status));
        }
        throw ModelError(ModelFailure::Http, "Model HTTP error " + std::to_string(status), static_cast<int>(status));
    }

    auto content_type = header(request.get(), WINHTTP_QUERY_CONTENT_TYPE);
    for (auto& c : content_type) if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
    if (const auto semicolon = content_type.find(L';'); semicolon != std::wstring::npos)
        content_type.resize(semicolon);
    while (!content_type.empty() && content_type.back() == L' ') content_type.pop_back();
    const bool streaming = content_type == L"text/event-stream";
    if (!streaming && !content_type.empty() && content_type != L"application/json" && !content_type.ends_with(L"+json"))
        fail("Unsupported model response content type");

    ReplyReader reader(responses, std::move(chunk), stop, deadline, config.payload_limits);
    SseReader sse(reader, config.payload_limits);
    std::size_t received = 0;
    std::string json;
    while (!reader.done()) {
        const auto bytes = request.read(stop, io_deadline());
        if (bytes.empty()) break;
        charge(received, bytes.size(), config.payload_limits.response_bytes, response_error);
        if (streaming) sse.feed(bytes);
        else json += bytes;
    }
    if (streaming) sse.finish();
    else reader.json(json);
    return reader.finish();
}

ModelError::ModelError(ModelFailure kind, std::string message, int http_status)
    : std::runtime_error(std::move(message)), kind_(kind), http_status_(http_status) {}
bool ModelError::may_upgrade() const noexcept {
    return kind_ == ModelFailure::Timeout || kind_ == ModelFailure::Transport ||
        (kind_ == ModelFailure::Http && (http_status_ == 408 || http_status_ == 429 ||
                                        (http_status_ >= 500 && http_status_ <= 599)));
}

static std::string bounded_get(const Endpoint& target,const std::wstring& headers,int timeout,bool json_only,std::stop_token stop) {
    const auto deadline=Clock::now()+std::chrono::milliseconds(timeout);
    InternetHandle session(open_configured_winhttp_session(L"DimensionAgentNative/0.2", WINHTTP_FLAG_ASYNC));
    if (!WinHttpSetTimeouts(session.get(), timeout, timeout, timeout, timeout)) network_error(GetLastError());
    InternetHandle connection(WinHttpConnect(session.get(), target.host.c_str(), target.port, 0));
    AsyncRequest request(WinHttpOpenRequest(connection.get(), L"GET", target.path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, target.secure ? WINHTTP_FLAG_SECURE : 0));
    set_option(request.get(), WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER);
    set_option(request.get(), WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION);
    set_option(request.get(), WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE, 64U * 1024U);
    set_option(request.get(), WINHTTP_OPTION_AUTOLOGON_POLICY, WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH);
    request.perform(WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, [&] {
        return WinHttpSendRequest(request.get(), headers.c_str(), static_cast<DWORD>(headers.size()),
            WINHTTP_NO_REQUEST_DATA, 0, 0, reinterpret_cast<DWORD_PTR>(&request));
    }, stop, deadline);
    request.perform(WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE,
        [&] { return WinHttpReceiveResponse(request.get(), nullptr); }, stop, deadline);
    DWORD status = 0, size = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX)) network_error(GetLastError());
    if (status >= 300U && status < 400U) fail("Model catalog redirect refused");
    if (status < 200U || status >= 300U)
        throw ModelError(ModelFailure::Http, "Model catalog HTTP error " + std::to_string(status), static_cast<int>(status));
    auto content_type = header(request.get(), WINHTTP_QUERY_CONTENT_TYPE);
    for (auto& c : content_type) if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
    if (const auto semicolon = content_type.find(L';'); semicolon != std::wstring::npos) content_type.resize(semicolon);
    while (!content_type.empty() && content_type.back() == L' ') content_type.pop_back();
    if (json_only && !content_type.empty() && content_type != L"application/json" && !content_type.ends_with(L"+json"))
        fail("Unsupported model catalog content type");
    std::string bytes;
    constexpr std::size_t maximum = 1024U * 1024U;
    for (;;) {
        const auto chunk = request.read(stop, deadline);
        if (chunk.empty()) break;
        if (chunk.size() > maximum - bytes.size()) fail("Model catalog exceeds byte budget");
        bytes.append(chunk);
    }
    return bytes;
}

std::string fetch_livebench_file(const std::string& name,std::stop_token stop){
    Endpoint target{L"api.github.com",L"/repos/LiveBench/LiveBench.github.io/contents/public",443,true};
    if(name!="index"){
        const auto csv=name.starts_with("table_") && name.ends_with(".csv");
        const auto json=name.starts_with("categories_") && name.ends_with(".json");
        if(!csv && !json)fail("Invalid leaderboard file");
        auto date=name.substr(csv?6:11,10);
        if(name!=(csv?"table_":"categories_")+date+(csv?".csv":".json") || date.size()!=10)fail("Invalid leaderboard date");
        for(size_t i=0;i<10;i++)if((i==4||i==7)?date[i]!='_':(date[i]<'0'||date[i]>'9'))fail("Invalid leaderboard date");
        target.host=L"raw.githubusercontent.com";
        target.path=L"/LiveBench/LiveBench.github.io/main/public/"+wide(name);
    }
    return bounded_get(target,L"Accept: */*\r\n",3500,false,stop);
}

Json fetch_model_catalog(const ModelConfig& config, std::stop_token stop) {
    if (config.protocol != "chat-completions" && config.protocol != "responses") fail("Unsupported model catalog protocol");
    if (config.timeout_ms <= 0) fail("Invalid model catalog timeout");
    const auto timeout = (std::min)(config.timeout_ms, 10000);
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeout);
    check_active(stop, deadline);
    const auto target = endpoint(config.base_url, config.protocol == "responses", true);
    if (config.api_key.size() > 8192U) fail("Invalid model API key");
    for (unsigned char c : config.api_key) if (c < 0x21U || c > 0x7EU) fail("Invalid model API key");
    std::wstring headers = L"Accept: application/json\r\n";
    if (!config.api_key.empty()) headers += L"Authorization: Bearer " + wide(config.api_key) + L"\r\n";
    const auto bytes=bounded_get(target,headers,timeout,true,stop);
    try { return Json::parse(bytes,1024U*1024U); }
    catch (...) { fail("Invalid model catalog JSON"); }
}

} // namespace dimension
