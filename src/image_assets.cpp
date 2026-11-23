#include "dimension/image_assets.hpp"
#include "dimension/json.hpp"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#include <wincodec.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <limits>
#include <map>
#include <mutex>
#include <utility>

namespace dimension {
ImageAssetError::ImageAssetError(int status, std::string code, std::string message)
    : std::runtime_error(std::move(message)), status_(status), code_(std::move(code)) {}
namespace {
namespace fs = std::filesystem;
using O = Json::Object;
[[noreturn]] void reject(int status, const char* code, const char* message) {
    throw ImageAssetError(status, code, message);
}
[[noreturn]] void invalid() { reject(400, "invalid_image", "图片格式不完整或内容无法解码"); }
[[noreturn]] void io_error() { reject(500, "image_storage", "图片存储不可用，原有图片未被覆盖"); }
unsigned byte(std::string_view s, std::size_t p) { return static_cast<unsigned char>(s[p]); }
std::uint32_t be32(std::string_view s, std::size_t p) {
    return (byte(s, p) << 24U) | (byte(s, p + 1) << 16U) | (byte(s, p + 2) << 8U) | byte(s, p + 3);
}
std::uint32_t le24(std::string_view s, std::size_t p) {
    return byte(s, p) | (byte(s, p + 1) << 8U) | (byte(s, p + 2) << 16U);
}
std::uint32_t le32(std::string_view s, std::size_t p) { return le24(s, p) | (byte(s, p + 3) << 24U); }
std::uint32_t le16(std::string_view s, std::size_t p) { return byte(s, p) | (byte(s, p + 1) << 8U); }
void append32(std::string& s, std::uint32_t value) {
    for (int shift : {24, 16, 8, 0}) s.push_back(static_cast<char>((value >> shift) & 255U));
}
void bounds(std::uint32_t width, std::uint32_t height, const ImageLimits& limits) {
    if (!width || !height) invalid();
    if (width > limits.max_axis || height > limits.max_axis ||
        static_cast<std::uint64_t>(width) * height > limits.max_decoded_pixels)
        reject(413, "image_dimensions", "图片尺寸超过限制");
}
struct Parsed {
    ImageInfo info;
    std::vector<std::pair<std::uint32_t, std::uint32_t>> sizes;
    std::uint64_t pixels = 0;
    void frame(std::uint32_t width, std::uint32_t height, const ImageLimits& limits) {
        bounds(width, height, limits);
        pixels += static_cast<std::uint64_t>(width) * height;
        if (sizes.size() >= limits.max_frames || pixels > limits.max_decoded_pixels)
            reject(413, "image_frames", "图片帧数或总解码尺寸超过限制");
        sizes.emplace_back(width, height);
    }
};
constexpr auto crc_values = [] {
    std::array<std::uint32_t, 256> values{};
    for (std::uint32_t i = 0; i < values.size(); ++i) {
        auto crc = i;
        for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1U) ^ ((crc & 1U) ? 0xedb88320U : 0U);
        values[i] = crc;
    }
    return values;
}();
Parsed png(std::string_view bytes, const ImageLimits& limits) {
    Parsed out; out.info.mime = "image/png";
    unsigned depth = 0, color = 0;
    bool palette = false, saw_data = false, ended_data = false;
    std::size_t data_size = 0;
    std::array<unsigned, 2> zlib_header{};
    std::size_t zlib_header_size = 0;
    for (std::size_t p = 8; p < bytes.size();) {
        if (bytes.size() - p < 12) invalid();
        const auto length = be32(bytes, p);
        if (length > bytes.size() - p - 12) invalid();
        const auto type = bytes.substr(p + 4, 4), payload = bytes.substr(p + 8, length);
        for (char c : type) if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) invalid();
        if (type[2] < 'A' || type[2] > 'Z') invalid();
        std::uint32_t crc = 0xffffffffU;
        for (std::size_t i = p + 4; i < p + 8 + length; ++i)
            crc = crc_values[(crc ^ byte(bytes, i)) & 255U] ^ (crc >> 8U);
        if ((crc ^ 0xffffffffU) != be32(bytes, p + 8 + length)) invalid();
        if (p == 8 && type != "IHDR") invalid();
        if (type == "IHDR") {
            if (p != 8 || length != 13) invalid();
            out.info.width = be32(payload, 0); out.info.height = be32(payload, 4);
            out.frame(out.info.width, out.info.height, limits);
            depth = byte(payload, 8); color = byte(payload, 9);
            const bool valid_depth = color == 0 ? (depth == 1 || depth == 2 || depth == 4 || depth == 8 || depth == 16) :
                color == 3 ? (depth == 1 || depth == 2 || depth == 4 || depth == 8) :
                (color == 2 || color == 4 || color == 6) && (depth == 8 || depth == 16);
            if (!valid_depth || byte(payload, 10) || byte(payload, 11) || byte(payload, 12) > 1) invalid();
        } else if (type == "PLTE") {
            if (palette || saw_data || color == 0 || color == 4 || !length || length > 768 || length % 3 ||
                (color == 3 && length / 3 > (std::size_t{1} << depth))) invalid();
            palette = true;
        } else if (type == "IDAT") {
            if (ended_data || (color == 3 && !palette)) invalid();
            saw_data = true; data_size += length;
            for (std::size_t i = 0; i < payload.size() && zlib_header_size < zlib_header.size(); ++i)
                zlib_header[zlib_header_size++] = byte(payload, i);
        } else if (type == "IEND") {
            if (length || data_size < 6 || p + 12 != bytes.size()) invalid();
            // WIC tolerates even an all-zero stream. PNG requires a zlib
            // DEFLATE header with a valid check word and no preset dictionary.
            const auto cmf = zlib_header[0], flg = zlib_header[1];
            if ((cmf & 15U) != 8U || (cmf >> 4U) > 7U || ((cmf << 8U) | flg) % 31U || (flg & 32U)) invalid();
            return out;
        } else {
            if (type == "acTL" || type == "fcTL" || type == "fdAT")
                reject(415, "image_animation", "暂不支持 APNG，请使用 PNG、JPEG、WebP 或 GIF");
            if (type[0] >= 'A' && type[0] <= 'Z') invalid();
            if (saw_data) ended_data = true;
        }
        p += static_cast<std::size_t>(length) + 12;
    }
    invalid();
}
Parsed jpeg(std::string_view bytes, const ImageLimits& limits) {
    Parsed out; out.info.mime = "image/jpeg";
    bool frame = false, scan = false;
    std::size_t p = 2;
    while (p < bytes.size()) {
        if (byte(bytes, p++) != 0xff) invalid();
        while (p < bytes.size() && byte(bytes, p) == 0xff) ++p;
        if (p == bytes.size()) invalid();
        const auto marker = byte(bytes, p++);
        if (marker == 0xd9) {
            if (!frame || !scan || p != bytes.size()) invalid();
            return out;
        }
        if (!marker || marker == 0xd8 || marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) || bytes.size() - p < 2) invalid();
        const auto length = (byte(bytes, p) << 8U) | byte(bytes, p + 1);
        if (length < 2 || length > bytes.size() - p) invalid();
        const auto part = bytes.substr(p + 2, length - 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc) {
            if (marker > 0xc2 || frame || scan || part.size() < 6 || byte(part, 0) != 8) invalid();
            const auto components = byte(part, 5);
            if ((components != 1 && components != 3 && components != 4) || part.size() != 6 + 3 * components) invalid();
            out.info.height = (byte(part, 1) << 8U) | byte(part, 2);
            out.info.width = (byte(part, 3) << 8U) | byte(part, 4);
            out.frame(out.info.width, out.info.height, limits); frame = true;
        }
        p += length;
        if (marker == 0xda) {
            if (!frame || part.size() < 6 || !byte(part, 0) || part.size() != 4 + 2 * byte(part, 0)) invalid();
            scan = true;
            // Scan entropy bytes until a non-stuffed, non-restart marker.
            while (p < bytes.size()) {
                if (byte(bytes, p) != 0xff) { ++p; continue; }
                const auto start = p++;
                while (p < bytes.size() && byte(bytes, p) == 0xff) ++p;
                if (p == bytes.size()) invalid();
                const auto next = byte(bytes, p);
                if (!next || (next >= 0xd0 && next <= 0xd7)) { ++p; continue; }
                p = start; break;
            }
        }
    }
    invalid();
}
Parsed gif(std::string_view bytes, const ImageLimits& limits) {
    if (bytes.size() < 14) invalid();
    Parsed out; out.info.mime = "image/gif";
    out.info.width = le16(bytes, 6); out.info.height = le16(bytes, 8);
    bounds(out.info.width, out.info.height, limits);
    std::size_t p = 13;
    const auto advance = [&](std::size_t count) { if (count > bytes.size() - p) invalid(); p += count; };
    const auto blocks = [&] {
        std::size_t total = 0;
        for (;;) {
            if (p == bytes.size()) invalid();
            const auto length = byte(bytes, p++);
            if (!length) return total;
            advance(length); total += length;
        }
    };
    const auto packed = byte(bytes, 10);
    if (packed & 0x80) advance(3U * (std::size_t{1} << ((packed & 7U) + 1U)));
    while (p < bytes.size()) {
        const auto tag = byte(bytes, p++);
        if (tag == 0x3b) {
            if (p != bytes.size() || out.sizes.empty()) invalid();
            out.info.frames = static_cast<std::uint32_t>(out.sizes.size());
            out.info.animated = out.info.frames > 1; return out;
        }
        if (tag == 0x21) {
            if (p == bytes.size()) invalid();
            const auto label = byte(bytes, p++);
            if (label == 0xf9) {
                if (bytes.size() - p < 6 || byte(bytes, p) != 4 || byte(bytes, p + 5) ||
                    (byte(bytes, p + 1) & 0xe0U) || ((byte(bytes, p + 1) >> 2U) & 7U) > 3) invalid();
                p += 6;
            } else {
                if ((label == 0xff && (p == bytes.size() || byte(bytes, p) != 11)) ||
                    (label == 0x01 && (p == bytes.size() || byte(bytes, p) != 12))) invalid();
                if (label != 0xff && label != 0x01 && label != 0xfe) invalid();
                (void)blocks();
            }
            continue;
        }
        if (tag != 0x2c || bytes.size() - p < 9) invalid();
        const auto x = le16(bytes, p), y = le16(bytes, p + 2), width = le16(bytes, p + 4), height = le16(bytes, p + 6);
        const auto flags = byte(bytes, p + 8); p += 9;
        if ((flags & 0x18U) || x + width > out.info.width || y + height > out.info.height) invalid();
        out.frame(width, height, limits);
        if (flags & 0x80) advance(3U * (std::size_t{1} << ((flags & 7U) + 1U)));
        else if (!(packed & 0x80)) invalid();
        if (p == bytes.size() || byte(bytes, p) < 2 || byte(bytes, p) > 8) invalid();
        ++p;
        if (!blocks()) invalid();
    }
    invalid();
}
std::pair<std::uint32_t, std::uint32_t> webp_frame(std::string_view type, std::string_view payload) {
    if (type == "VP8 ") {
        if (payload.size() < 10 || (byte(payload, 0) & 1U) || ((byte(payload, 0) >> 1U) & 7U) > 3 ||
            !(byte(payload, 0) & 16U) || payload.substr(3, 3) != std::string_view("\x9d\x01\x2a", 3)) invalid();
        const auto partition = le24(payload, 0) >> 5U;
        if (!partition || partition > payload.size() - 10) invalid();
        return {le16(payload, 6) & 0x3fffU, le16(payload, 8) & 0x3fffU};
    }
    if (payload.size() < 5 || byte(payload, 0) != 0x2f || (byte(payload, 4) & 0xe0U)) invalid();
    const auto bits = le32(payload, 1);
    return {(bits & 0x3fffU) + 1U, ((bits >> 14U) & 0x3fffU) + 1U};
}
Parsed webp(std::string_view bytes, const ImageLimits& limits) {
    if (bytes.size() < 20 || le32(bytes, 4) != bytes.size() - 8) invalid();
    Parsed out; out.info.mime = "image/webp";
    bool extended = false, animation = false, animation_header = false, alpha = false;
    std::map<std::string, unsigned> counts;
    for (std::size_t p = 12; p < bytes.size();) {
        if (bytes.size() - p < 8) invalid();
        const auto type = bytes.substr(p, 4);
        const auto length = le32(bytes, p + 4);
        if (length > bytes.size() - p - 8) invalid();
        const auto payload = bytes.substr(p + 8, length);
        const auto padded = static_cast<std::size_t>(length) + (length & 1U);
        if (padded > bytes.size() - p - 8 || ((length & 1U) && byte(bytes, p + 8 + length))) invalid();
        if (type != "ANMF" && ++counts[std::string(type)] > 1) invalid();
        if (type == "VP8X") {
            if (p != 12 || length != 10 || (byte(payload, 0) & 0xc1U) || byte(payload, 1) || byte(payload, 2) || byte(payload, 3)) invalid();
            extended = true; animation = (byte(payload, 0) & 2U) != 0;
            out.info.width = le24(payload, 4) + 1; out.info.height = le24(payload, 7) + 1;
            bounds(out.info.width, out.info.height, limits);
        } else if (type == "VP8 " || type == "VP8L") {
            if (animation || !out.sizes.empty()) invalid();
            const auto [width, height] = webp_frame(type, payload);
            if (extended && (width != out.info.width || height != out.info.height)) invalid();
            out.info.width = width; out.info.height = height; out.frame(width, height, limits);
            if (type == "VP8L" && alpha) invalid();
        } else if (type == "ANIM") {
            if (!animation || length != 6 || !out.sizes.empty()) invalid();
            animation_header = true;
        } else if (type == "ANMF") {
            if (!animation_header || length < 24 || (byte(payload, 15) & 0xfcU)) invalid();
            const auto x = le24(payload, 0) * 2U, y = le24(payload, 3) * 2U;
            const auto width = le24(payload, 6) + 1U, height = le24(payload, 9) + 1U;
            if (x + width > out.info.width || y + height > out.info.height) invalid();
            bool image = false, frame_alpha = false;
            for (std::size_t q = 16; q < payload.size();) {
                if (payload.size() - q < 8) invalid();
                const auto inner_type = payload.substr(q, 4);
                const auto inner_length = le32(payload, q + 4);
                if (inner_length > payload.size() - q - 8) invalid();
                const auto inner = payload.substr(q + 8, inner_length);
                const auto pad = static_cast<std::size_t>(inner_length) + (inner_length & 1U);
                if (pad > payload.size() - q - 8 || ((inner_length & 1U) && byte(payload, q + 8 + inner_length))) invalid();
                if (inner_type == "ALPH") {
                    if (frame_alpha || image || !inner_length || (byte(inner, 0) & 0xc0U)) invalid();
                    frame_alpha = true;
                } else if (inner_type == "VP8 " || inner_type == "VP8L") {
                    if (image || (frame_alpha && inner_type == "VP8L") || webp_frame(inner_type, inner) != std::pair{width, height}) invalid();
                    image = true;
                } else invalid();
                q += pad + 8;
            }
            if (!image) invalid();
            out.frame(width, height, limits);
        } else if (type == "ALPH") {
            if (!extended || animation || !out.sizes.empty() || !length || (byte(payload, 0) & 0xc0U)) invalid();
            alpha = true;
        } else if (type == "ICCP" || type == "EXIF" || type == "XMP ") {
            if (!extended || !length) invalid();
        } else invalid();
        p += padded + 8;
    }
    if (out.sizes.empty()) invalid();
    out.info.frames = static_cast<std::uint32_t>(out.sizes.size());
    out.info.animated = animation; return out;
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
struct Apartment {
    HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    Apartment() { if (FAILED(result) && result != RPC_E_CHANGED_MODE) io_error(); }
    ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};
void pixels(std::string_view input, const Parsed& parsed, const ImageLimits& limits) {
    Apartment apartment;
    ComRef<IWICImagingFactory> factory;
    ComRef<IWICStream> stream;
    ComRef<IWICBitmapDecoder> decoder;
    const auto valid = [](HRESULT status) { if (FAILED(status)) invalid(); };
    valid(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.out())));
    valid(factory->CreateStream(stream.out()));
    std::vector<BYTE> bytes(input.begin(), input.end());
    valid(stream->InitializeFromMemory(bytes.data(), static_cast<DWORD>(bytes.size())));
    const GUID* codec = parsed.info.mime == "image/png" ? &CLSID_WICPngDecoder :
        parsed.info.mime == "image/jpeg" ? &CLSID_WICJpegDecoder :
        parsed.info.mime == "image/gif" ? &CLSID_WICGifDecoder : &CLSID_WICWebpDecoder;
    valid(CoCreateInstance(*codec, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(decoder.out())));
    valid(decoder->Initialize(stream.value, WICDecodeMetadataCacheOnDemand));
    UINT count = 0;
    valid(decoder->GetFrameCount(&count));
    if (count != parsed.sizes.size()) invalid();
    std::uint64_t decoded = 0;
    for (UINT i = 0; i < count; ++i) {
        ComRef<IWICBitmapFrameDecode> frame;
        ComRef<IWICFormatConverter> rgba;
        UINT width = 0, height = 0;
        valid(decoder->GetFrame(i, frame.out())); valid(frame->GetSize(&width, &height));
        bounds(width, height, limits);
        if (std::pair{width, height} != parsed.sizes[i] &&
            std::pair{width, height} != std::pair{parsed.info.width, parsed.info.height}) invalid();
        decoded += static_cast<std::uint64_t>(width) * height;
        if (decoded > limits.max_decoded_pixels) reject(413, "image_frames", "图片总解码尺寸超过限制");
        valid(factory->CreateFormatConverter(rgba.out()));
        valid(rgba->Initialize(frame.value, GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom));
        const UINT stride = width * 4U;
        std::vector<BYTE> strip(static_cast<std::size_t>(stride) * std::min(height, 64U));
        for (UINT y = 0; y < height; y += 64U) {
            const UINT rows = std::min(height - y, 64U);
            WICRect rect{0, static_cast<INT>(y), static_cast<INT>(width), static_cast<INT>(rows)};
            valid(rgba->CopyPixels(&rect, stride, stride * rows, strip.data()));
        }
    }
}
void image_limits(const ImageLimits& limits) {
    if (!limits.max_bytes || limits.max_bytes > 64U * 1024U * 1024U || !limits.max_axis || limits.max_axis > 32768 ||
        !limits.max_decoded_pixels || limits.max_decoded_pixels > 1024ULL * 1024ULL * 1024ULL ||
        !limits.max_frames || limits.max_frames > 4096) throw std::invalid_argument("Invalid image limits");
}
} // namespace

ImageInfo inspect_image(std::string_view bytes, ImageLimits limits) {
    image_limits(limits);
    if (bytes.empty()) invalid();
    if (bytes.size() > limits.max_bytes) reject(413, "image_size", "图片文件超过大小限制");
    Parsed parsed;
    if (bytes.starts_with(std::string_view("\x89PNG\r\n\x1a\n", 8))) parsed = png(bytes, limits);
    else if (bytes.starts_with(std::string_view("\xff\xd8\xff", 3))) parsed = jpeg(bytes, limits);
    else if (bytes.starts_with("GIF87a") || bytes.starts_with("GIF89a")) parsed = gif(bytes, limits);
    else if (bytes.size() >= 12 && bytes.starts_with("RIFF") && bytes.substr(8, 4) == "WEBP") parsed = webp(bytes, limits);
    else reject(415, "image_type", "只支持 PNG、JPEG、WebP 和 GIF 图片");
    pixels(bytes, parsed, limits);
    return parsed.info;
}

namespace {
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE handle = INVALID_HANDLE_VALUE) : value(handle) {}
    ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
};
std::wstring native(const fs::path& path) {
    auto normalized = path.lexically_normal(); normalized.make_preferred();
    return L"\\\\?\\" + normalized.wstring();
}
void ordinary(HANDLE handle, bool directory) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle, &info) ||
        (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
        (!directory && info.nNumberOfLinks != 1)) io_error();
}
Handle open_file(const fs::path& path, DWORD access, DWORD creation = OPEN_EXISTING, DWORD sharing = FILE_SHARE_READ) {
    Handle handle(CreateFileW(native(path).c_str(), access, sharing, nullptr, creation,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    ordinary(handle.value, false); return handle;
}
std::vector<Handle> ensure_directory(const fs::path& path) {
    if (!path.is_absolute() || path.root_name().wstring().size() != 2 || path.root_name().wstring()[1] != L':') io_error();
    std::vector<Handle> handles;
    const auto pin = [&](const fs::path& directory) {
        handles.emplace_back(CreateFileW(native(directory).c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        ordinary(handles.back().value, true);
    };
    auto current = path.root_path();
    pin(current);
    for (const auto& part : path.relative_path()) {
        current /= part;
        if (!CreateDirectoryW(native(current).c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) io_error();
        pin(current);
    }
    return handles;
}
std::string hash(std::string_view value) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) io_error();
    struct Close { BCRYPT_ALG_HANDLE value; ~Close() { BCryptCloseAlgorithmProvider(value, 0); } } close{algorithm};
    std::array<UCHAR, 32> digest{};
    if (BCryptHash(algorithm, nullptr, 0, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())),
        static_cast<ULONG>(value.size()), digest.data(), static_cast<ULONG>(digest.size())) < 0) io_error();
    constexpr char hex[] = "0123456789abcdef";
    std::string output; output.reserve(64);
    for (auto item : digest) { output.push_back(hex[item >> 4]); output.push_back(hex[item & 15]); }
    return output;
}
std::string random_id() {
    std::array<UCHAR, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) io_error();
    constexpr char hex[] = "0123456789abcdef";
    std::string output; output.reserve(32);
    for (auto item : bytes) { output.push_back(hex[item >> 4]); output.push_back(hex[item & 15]); }
    return output;
}
bool hex_id(std::string_view id, std::size_t length) {
    return id.size() == length && std::all_of(id.begin(), id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
void owner_id(std::string_view id, bool group) {
    if (id.empty() || id.size() > 128 || id == "." || id == ".." ||
        !std::all_of(id.begin(), id.end(), [group](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || (group && c == ':'); }))
        reject(400, "image_owner", "图片所属身份无效");
}
void sticker_id(std::string_view id) { if (!hex_id(id, 32)) reject(400, "sticker_id", "表情编号无效"); }
std::string kind(AvatarScope scope) {
    if (scope == AvatarScope::Bot) return "bot";
    if (scope == AvatarScope::Group) return "group";
    throw std::invalid_argument("Invalid avatar scope");
}
std::string avatar_id(AvatarScope scope, std::string_view owner) {
    owner_id(owner, scope == AvatarScope::Group); return hash(kind(scope) + ":" + std::string(owner));
}
std::string name_text(std::string_view input) {
    if (input.empty()) return "表情";
    if (input.size() > 512 || std::any_of(input.begin(), input.end(), [](unsigned char c) { return c < 32 || c == 127; }) ||
        !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), nullptr, 0))
        reject(400, "sticker_name", "表情名称无效或过长");
    return std::string(input);
}
void mime_matches(std::string_view declared, const ImageInfo& info) {
    std::string normalized(declared);
    for (auto& c : normalized) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
    if (normalized != info.mime) reject(415, "image_mime", "声明的图片类型与文件内容不一致");
}
constexpr std::string_view magic("DIMIMG1\n", 8);
constexpr std::size_t max_header = 4096;
struct Record { ImageAsset asset; std::string type, owner; fs::path path; };
std::string encode(const Record& record, std::string_view bytes) {
    const auto& a = record.asset;
    const auto header = Json(O{{"version", 1}, {"id", a.id}, {"type", record.type}, {"owner", record.owner},
        {"name", a.name}, {"mime", a.image.mime}, {"width", static_cast<double>(a.image.width)},
        {"height", static_cast<double>(a.image.height)}, {"frames", static_cast<double>(a.image.frames)},
        {"animated", a.image.animated}, {"bytes", static_cast<double>(a.byte_size)}, {"sha256", a.revision}}).dump();
    if (header.size() > max_header) io_error();
    std::string out(magic); append32(out, static_cast<std::uint32_t>(header.size())); out += header; out += bytes; return out;
}
std::string read_file(const fs::path& path, std::size_t limit) {
    auto handle = open_file(path, GENERIC_READ);
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(handle.value, &size) || size.QuadPart < 0 || static_cast<std::uint64_t>(size.QuadPart) > limit) io_error();
    std::string out(static_cast<std::size_t>(size.QuadPart), '\0');
    for (std::size_t p = 0; p < out.size();) {
        DWORD done = 0;
        const auto count = static_cast<DWORD>(std::min(out.size() - p, std::size_t{1024U * 1024U}));
        if (!ReadFile(handle.value, out.data() + p, count, &done, nullptr) || !done) io_error();
        p += done;
    }
    return out;
}
std::pair<Record, std::string> decode(const fs::path& path, const std::string& type, const ImageLimits& limits, bool validate_pixels) {
    try {
        const auto file = read_file(path, limits.max_bytes + max_header + 12);
        if (file.size() < 12 || !file.starts_with(magic)) io_error();
        const auto length = be32(file, 8);
        if (!length || length > max_header || length > file.size() - 12) io_error();
        const auto meta = Json::parse(std::string_view(file).substr(12, length), max_header);
        if (meta.as_object().size() != 12 || meta.at("version").as_number() != 1) io_error();
        Record record; record.type = meta.at("type").as_string(); record.owner = meta.at("owner").as_string(); record.path = path;
        auto& a = record.asset;
        a.id = meta.at("id").as_string(); a.name = meta.at("name").as_string(); a.revision = meta.at("sha256").as_string();
        if (record.type != type || path.filename() != fs::path(a.id + ".asset") || !hex_id(a.revision, 64)) io_error();
        if (type == "sticker") { sticker_id(a.id); if (!record.owner.empty() || name_text(a.name) != a.name) io_error(); }
        else if (a.id != avatar_id(type == "bot" ? AvatarScope::Bot : AvatarScope::Group, record.owner) || !a.name.empty()) io_error();
        const auto integer = [&](const char* field, std::uint64_t maximum) {
            const auto value = meta.at(field).as_number();
            if (!std::isfinite(value) || value < 1 || value > static_cast<double>(maximum) || std::floor(value) != value) io_error();
            return static_cast<std::uint64_t>(value);
        };
        a.byte_size = static_cast<std::size_t>(integer("bytes", limits.max_bytes));
        a.image = {meta.at("mime").as_string(), static_cast<std::uint32_t>(integer("width", limits.max_axis)),
            static_cast<std::uint32_t>(integer("height", limits.max_axis)), static_cast<std::uint32_t>(integer("frames", limits.max_frames)),
            meta.at("animated").as_bool()};
        std::string bytes = file.substr(12 + length);
        if (bytes.size() != a.byte_size || hash(bytes) != a.revision) io_error();
        if (validate_pixels && inspect_image(bytes, limits) != a.image) io_error();
        return {std::move(record), std::move(bytes)};
    } catch (const std::exception&) { io_error(); }
}
void atomic_file(const fs::path& path, std::string_view bytes) {
    const auto directory_guards = ensure_directory(path.parent_path());
    const auto existing = GetFileAttributesW(native(path).c_str());
    if (existing != INVALID_FILE_ATTRIBUTES) { auto check = open_file(path, FILE_READ_ATTRIBUTES); }
    else if (GetLastError() != ERROR_FILE_NOT_FOUND) io_error();
    auto temporary = path.parent_path() / fs::path("tmp-" + random_id() + ".part");
    try {
        {
            auto handle = open_file(temporary, GENERIC_WRITE, CREATE_NEW, 0);
            for (std::size_t p = 0; p < bytes.size();) {
                DWORD done = 0;
                const auto count = static_cast<DWORD>(std::min(bytes.size() - p, std::size_t{1024U * 1024U}));
                if (!WriteFile(handle.value, bytes.data() + p, count, &done, nullptr) || !done) io_error();
                p += done;
            }
            if (!FlushFileBuffers(handle.value)) io_error();
        }
        if (!MoveFileExW(native(temporary).c_str(), native(path).c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) io_error();
    } catch (...) { DeleteFileW(native(temporary).c_str()); throw; }
}
} // namespace

struct ImageAssets::Impl {
    fs::path root;
    ImageAssetLimits limits;
    Handle lock;
    std::vector<Handle> directory_locks;
    mutable std::mutex mutex;
    std::map<std::string, Record> records;
    std::size_t bytes = 0;
    std::atomic<std::uint64_t> revision{1};

    explicit Impl(const fs::path& data, ImageAssetLimits value) : root(fs::absolute(data).lexically_normal() / L"image-assets"), limits(value) {
        image_limits(limits.image);
        if (!limits.max_stickers || !limits.max_avatars || !limits.max_total_bytes) throw std::invalid_argument("Invalid image asset limits");
        directory_locks = ensure_directory(root);
        lock.value = CreateFileW(native(root / L"owner.lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        ordinary(lock.value, false);
        for (const auto* type : {"bot", "group", "sticker"}) {
            const auto dir = root / fs::path(type);
            auto guards = ensure_directory(dir);
            for (auto& guard : guards) directory_locks.push_back(std::move(guard));
            std::size_t scanned = 0;
            for (const auto& entry : fs::directory_iterator(native(dir))) {
                if (++scanned > limits.max_avatars + limits.max_stickers + 1024) io_error();
                if (entry.path().extension() != L".asset") continue;
                const auto file = dir / entry.path().filename();
                auto [record, content] = decode(file, type, limits.image, true);
                bytes += record.asset.byte_size;
                if (bytes > limits.max_total_bytes || !records.emplace(key(type, record.asset.id), std::move(record)).second) io_error();
            }
        }
        if (count("sticker") > limits.max_stickers || records.size() - count("sticker") > limits.max_avatars) io_error();
    }
    static std::string key(std::string_view type, std::string_view id) { return std::string(type) + ":" + std::string(id); }
    std::size_t count(std::string_view type) const {
        return static_cast<std::size_t>(std::count_if(records.begin(), records.end(), [&](const auto& row) { return row.second.type == type; }));
    }
    ImageAssetContent read(std::string_view type, std::string_view id) const {
        const auto found = records.find(key(type, id));
        if (found == records.end()) reject(404, "image_missing", "图片不存在或已移除");
        const auto [disk, content] = decode(found->second.path, std::string(type), limits.image, false);
        if (disk.asset.revision != found->second.asset.revision || disk.asset.image != found->second.asset.image) io_error();
        return {disk.asset, content};
    }
    ImageAsset put(std::string type, std::string id, std::string owner, std::string name, std::string_view content, std::string_view mime) {
        const auto info = inspect_image(content, limits.image); mime_matches(mime, info);
        const auto identity = key(type, id); const auto old = records.find(identity);
        const auto prior = old == records.end() ? 0 : old->second.asset.byte_size;
        if (content.size() > limits.max_total_bytes - (bytes - prior)) reject(413, "image_capacity", "图片库容量已满，请先移除不需要的图片");
        if (old == records.end() && (type == "sticker" ? count("sticker") >= limits.max_stickers : records.size() - count("sticker") >= limits.max_avatars))
            reject(413, "image_count", "图片数量已达到限制");
        Record record{{id, std::move(name), hash(content), info, content.size()}, type, std::move(owner), root / fs::path(type) / fs::path(id + ".asset")};
        atomic_file(record.path, encode(record, content));
        records.insert_or_assign(identity, record); bytes = bytes - prior + content.size();
        revision.fetch_add(1, std::memory_order_release);
        return record.asset;
    }
    bool remove(std::string_view type, std::string_view id) {
        const auto found = records.find(key(type, id));
        if (found == records.end()) return false;
        const auto directory_guards = ensure_directory(found->second.path.parent_path());
        { auto check = open_file(found->second.path, FILE_READ_ATTRIBUTES); }
        if (!DeleteFileW(native(found->second.path).c_str())) io_error();
        bytes -= found->second.asset.byte_size; records.erase(found);
        revision.fetch_add(1, std::memory_order_release);
        return true;
    }
};

ImageAssets::ImageAssets(const fs::path& data, ImageAssetLimits limits) : impl_(std::make_unique<Impl>(data, limits)) {}
ImageAssets::~ImageAssets() = default;
std::optional<ImageAsset> ImageAssets::avatar(AvatarScope scope, std::string_view owner) const {
    const auto id = avatar_id(scope, owner); std::lock_guard guard(impl_->mutex);
    const auto found = impl_->records.find(Impl::key(kind(scope), id));
    if (found == impl_->records.end()) return std::nullopt;
    return found->second.asset;
}
ImageAssetContent ImageAssets::read_avatar(AvatarScope scope, std::string_view owner) const {
    const auto id = avatar_id(scope, owner); std::lock_guard guard(impl_->mutex); return impl_->read(kind(scope), id);
}
ImageAsset ImageAssets::put_avatar(AvatarScope scope, std::string_view owner, std::string_view bytes, std::string_view mime) {
    const auto id = avatar_id(scope, owner); std::lock_guard guard(impl_->mutex);
    return impl_->put(kind(scope), id, std::string(owner), {}, bytes, mime);
}
bool ImageAssets::remove_avatar(AvatarScope scope, std::string_view owner) {
    const auto id = avatar_id(scope, owner); std::lock_guard guard(impl_->mutex); return impl_->remove(kind(scope), id);
}
std::vector<ImageAsset> ImageAssets::stickers() const {
    std::lock_guard guard(impl_->mutex); std::vector<ImageAsset> values;
    for (const auto& [identity, record] : impl_->records) if (record.type == "sticker") values.push_back(record.asset);
    return values;
}
ImageAssetContent ImageAssets::read_sticker(std::string_view id) const {
    sticker_id(id); std::lock_guard guard(impl_->mutex); return impl_->read("sticker", id);
}
ImageAsset ImageAssets::add_sticker(std::string_view name, std::string_view bytes, std::string_view mime) {
    const auto normalized = name_text(name); std::lock_guard guard(impl_->mutex);
    std::string id; do { id = random_id(); } while (impl_->records.contains(Impl::key("sticker", id)));
    return impl_->put("sticker", id, {}, normalized, bytes, mime);
}
bool ImageAssets::remove_sticker(std::string_view id) {
    sticker_id(id); std::lock_guard guard(impl_->mutex); return impl_->remove("sticker", id);
}
std::uint64_t ImageAssets::revision() const noexcept {
    return impl_->revision.load(std::memory_order_acquire);
}
} // namespace dimension
