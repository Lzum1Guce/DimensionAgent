#include "dimension/image_assets.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <source_location>
#include <thread>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
std::size_t checks = 0;
void check(bool value, const char* text, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + text);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(F action, int expected = 0, std::source_location location = std::source_location::current()) {
    ++checks;
    try { action(); }
    catch (const ImageAssetError& error) {
        if (expected && error.status() != expected) throw std::runtime_error("Wrong image error status: " + std::to_string(error.status()) + " " + error.what());
        return;
    }
    throw std::runtime_error("Expected image rejection at line " + std::to_string(location.line()));
}
std::wstring native(const fs::path& path) {
    auto result = path.lexically_normal(); result.make_preferred(); return L"\\\\?\\" + result.wstring();
}
std::string read(const fs::path& path) {
    std::ifstream in(native(path), std::ios::binary);
    if (!in) throw std::runtime_error("Cannot read synthetic fixture");
    return {std::istreambuf_iterator<char>(in), {}};
}
void write(const fs::path& path, std::string_view text) {
    fs::create_directories(native(path.parent_path()));
    std::ofstream out(native(path), std::ios::binary | std::ios::trunc);
    out.write(text.data(), static_cast<std::streamsize>(text.size()));
    if (!out) throw std::runtime_error("Cannot write synthetic fixture");
}
std::string unbase64(std::string_view input) {
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    unsigned value = 0, bits = 0;
    std::string out;
    for (char c : input) {
        if (c == '=') break;
        const auto index = alphabet.find(c);
        if (index == std::string_view::npos) throw std::runtime_error("Bad embedded fixture");
        value = (value << 6U) | static_cast<unsigned>(index); bits += 6;
        if (bits >= 8) { bits -= 8; out.push_back(static_cast<char>((value >> bits) & 255U)); }
    }
    return out;
}
// Original 2x2 solid-color fixtures generated with Pillow, with no downloaded or
// production assets. The animated fixtures alternate red and blue frames.
const auto png = unbase64("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN8ZqPBwMDAxAAGABBgAU6wYIpsAAAAAElFTkSuQmCC");
const auto jpeg = unbase64("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDMooor5w/TT//Z");
const auto gif = unbase64("R0lGODlhAgACAIEAAOY8KAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEeZPAAAAAAAAAAAAAIBgABCAQQEAA7");
const auto webp_lossless = unbase64("UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQnpoXpf+BiOh/AAA=");
const auto webp_lossy = unbase64("UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+6tR//KVeCxu5n/72C+7Bfdgv9bAA");
const auto webp_animated = unbase64("UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSAAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMAAAADABAJ0BKgIAAgABQCYloAADcAD+6tR///KV/8bv92XQb//97Bf/7sF//uwX+tgAAEFOTUZIAAAAAAAAAAAAAQAAAQAAZAAAAFZQOCAwAAAANAEAnQEqAgACAAAAJiWgAANwAP7vUS///dk//+2T//7ZP/k0//+dg/+9H/pj4zAA");
const std::array<std::pair<const std::string*, const char*>, 6> fixtures{{
    {&png, "image/png"}, {&jpeg, "image/jpeg"}, {&gif, "image/gif"},
    {&webp_lossless, "image/webp"}, {&webp_lossy, "image/webp"}, {&webp_animated, "image/webp"}}};
void be32(std::string& text, std::size_t p, unsigned value) {
    for (int shift : {24, 16, 8, 0}) text[p++] = static_cast<char>((value >> shift) & 255U);
}
void png_crc(std::string& text, std::size_t start, std::size_t length) {
    std::uint32_t crc = 0xffffffffU;
    for (std::size_t p = start; p < start + length; ++p) {
        crc ^= static_cast<unsigned char>(text[p]);
        for (int i = 0; i < 8; ++i) crc = (crc >> 1U) ^ ((crc & 1U) ? 0xedb88320U : 0U);
    }
    be32(text, start + length, crc ^ 0xffffffffU);
}
void validation() {
    for (const auto& [bytes, mime] : fixtures) {
        const auto info = inspect_image(*bytes);
        CHECK(info.mime == mime); CHECK(info.width == 2); CHECK(info.height == 2);
        CHECK(info.frames == ((bytes == &gif || bytes == &webp_animated) ? 2U : 1U));
        CHECK(info.animated == (bytes == &gif || bytes == &webp_animated));
        for (std::size_t length = 0; length < bytes->size(); ++length)
            rejected([&] { (void)inspect_image(std::string_view(*bytes).substr(0, length)); });
        rejected([&] { (void)inspect_image(*bytes + "trailing data"); });
        ImageLimits limits; limits.max_bytes = bytes->size() - 1;
        rejected([&] { (void)inspect_image(*bytes, limits); }, 413);
        limits = {}; limits.max_axis = 1;
        rejected([&] { (void)inspect_image(*bytes, limits); }, 413);
        limits = {}; limits.max_decoded_pixels = 3;
        rejected([&] { (void)inspect_image(*bytes, limits); }, 413);
    }
    ImageLimits frames; frames.max_frames = 1;
    rejected([&] { (void)inspect_image(gif, frames); }, 413);
    rejected([&] { (void)inspect_image(webp_animated, frames); }, 413);
    ImageLimits pixels; pixels.max_decoded_pixels = 4;
    rejected([&] { (void)inspect_image(gif, pixels); }, 413);
    for (const auto* text : {"<svg xmlns='http://www.w3.org/2000/svg'/>", "https://invalid/image.png", "BMfake", "GIFfake", "RIFFfakeWEBP", "PNG"})
        rejected([&] { (void)inspect_image(text); });
    auto corrupt = png; corrupt[16] ^= 1;
    rejected([&] { (void)inspect_image(corrupt); }, 400);
    corrupt = png; be32(corrupt, 16, 8193); png_crc(corrupt, 12, 17);
    rejected([&] { (void)inspect_image(corrupt); }, 413);
    corrupt = png; std::fill(corrupt.begin() + 41, corrupt.begin() + 59, '\0'); png_crc(corrupt, 37, 22);
    rejected([&] { (void)inspect_image(corrupt); }, 400);
    corrupt = gif; corrupt[6] = 1;
    rejected([&] { (void)inspect_image(corrupt); }, 400);
    corrupt = webp_lossless; corrupt[4] ^= 1;
    rejected([&] { (void)inspect_image(corrupt); }, 400);
    corrupt = webp_animated; corrupt[20] = static_cast<char>(0xff);
    rejected([&] { (void)inspect_image(corrupt); }, 400);
}
void lifecycle(const fs::path& output) {
    const auto data = output / L"lifecycle";
    const auto outside = output / L"outside-marker.txt";
    write(outside, "unrelated marker");
    std::vector<ImageAsset> saved;
    {
        ImageAssets images(data);
        CHECK(images.stickers().empty()); CHECK(!images.avatar(AvatarScope::Bot, "same-id"));
        rejected([&] { ImageAssets second(data); }, 500);
        rejected([&] { (void)images.read_avatar(AvatarScope::Bot, "same-id"); }, 404);
        const auto original = images.put_avatar(AvatarScope::Bot, "same-id", png, "image/png");
        CHECK(original.image.mime == "image/png"); CHECK(original.revision.size() == 64);
        CHECK(images.read_avatar(AvatarScope::Bot, "same-id").bytes == png);
        const auto group = images.put_avatar(AvatarScope::Group, "same-id", jpeg, "IMAGE/JPEG");
        CHECK(group.id != original.id); CHECK(images.read_avatar(AvatarScope::Group, "same-id").bytes == jpeg);
        (void)images.put_avatar(AvatarScope::Group, "synthetic:scope", png, "image/png");
        CHECK(images.read_avatar(AvatarScope::Group, "synthetic:scope").bytes == png);
        for (const auto& [bytes, mime] : fixtures) {
            const auto row = images.add_sticker("原样 <img src=x> /..\\ 不作为路径", *bytes, mime);
            CHECK(row.id.size() == 32); CHECK(row.name == "原样 <img src=x> /..\\ 不作为路径");
            CHECK(images.read_sticker(row.id).bytes == *bytes); saved.push_back(row);
        }
        CHECK(images.stickers().size() == fixtures.size());
        rejected([&] { (void)images.put_avatar(AvatarScope::Bot, "same-id", jpeg, "image/png"); }, 415);
        rejected([&] { (void)images.put_avatar(AvatarScope::Bot, "same-id", "fake", "image/png"); }, 415);
        CHECK(images.read_avatar(AvatarScope::Bot, "same-id").bytes == png);
        CHECK(images.avatar(AvatarScope::Bot, "same-id")->revision == original.revision);
        for (const auto* id : {"", ".", "..", "../outside", "a/b", "a\\b", "a:b"}) {
            rejected([&] { (void)images.put_avatar(AvatarScope::Bot, id, png, "image/png"); }, 400);
            rejected([&] { (void)images.read_sticker(id); }, 400);
            rejected([&] { (void)images.remove_sticker(id); }, 400);
        }
        rejected([&] { (void)images.add_sticker("bad\nname", png, "image/png"); }, 400);
        rejected([&] { (void)images.add_sticker(std::string(513, 'x'), png, "image/png"); }, 400);
        const auto avatar_path = data / L"image-assets" / L"bot" / fs::path(original.id + ".asset");
        const auto disk_before = read(avatar_path);
        const HANDLE locked = CreateFileW(native(avatar_path).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        CHECK(locked != INVALID_HANDLE_VALUE);
        try {
            rejected([&] { (void)images.put_avatar(AvatarScope::Bot, "same-id", gif, "image/gif"); }, 500);
            CHECK(read(avatar_path) == disk_before);
            CHECK(images.read_avatar(AvatarScope::Bot, "same-id").bytes == png);
        } catch (...) { CloseHandle(locked); throw; }
        CloseHandle(locked);
        (void)images.put_avatar(AvatarScope::Bot, "same-id", gif, "image/gif");
        CHECK(images.read_avatar(AvatarScope::Bot, "same-id").bytes == gif);
        CHECK(images.avatar(AvatarScope::Bot, "same-id")->image.animated);
        const auto alias = output / L"hardlink-to-owned-asset";
        CHECK(CreateHardLinkW(native(alias).c_str(), native(avatar_path).c_str(), nullptr));
        rejected([&] { (void)images.remove_avatar(AvatarScope::Bot, "same-id"); }, 500);
        CHECK(DeleteFileW(native(alias).c_str()));
        CHECK(images.avatar(AvatarScope::Bot, "same-id").has_value());
    }
    {
        ImageAssets images(data);
        CHECK(images.stickers().size() == saved.size());
        CHECK(images.read_avatar(AvatarScope::Bot, "same-id").bytes == gif);
        CHECK(images.read_avatar(AvatarScope::Group, "same-id").bytes == jpeg);
        CHECK(images.read_avatar(AvatarScope::Group, "synthetic:scope").bytes == png);
        for (std::size_t i = 0; i < saved.size(); ++i) {
            const auto content = images.read_sticker(saved[i].id);
            CHECK(content.bytes == *fixtures[i].first); CHECK(content.asset.revision == saved[i].revision);
        }
        CHECK(images.remove_avatar(AvatarScope::Bot, "same-id"));
        CHECK(!images.remove_avatar(AvatarScope::Bot, "same-id"));
        CHECK(!images.avatar(AvatarScope::Bot, "same-id"));
        CHECK(images.read_avatar(AvatarScope::Group, "same-id").bytes == jpeg);
        CHECK(images.remove_sticker(saved[2].id)); CHECK(!images.remove_sticker(saved[2].id));
        rejected([&] { (void)images.read_sticker(saved[2].id); }, 404);
        CHECK(images.stickers().size() == saved.size() - 1);
        CHECK(read(outside) == "unrelated marker");
    }
    {
        ImageAssets images(data);
        CHECK(!images.avatar(AvatarScope::Bot, "same-id"));
        rejected([&] { (void)images.read_sticker(saved[2].id); }, 404);
        CHECK(images.read_avatar(AvatarScope::Group, "same-id").bytes == jpeg);
    }
}
void directory_pins(const fs::path& output) {
    const auto data = output / L"directory-pins", root = data / L"image-assets";
    std::string sticker;
    {
        ImageAssets images(data);
        sticker = images.add_sticker("owned marker", png, "image/png").id;
        for (const auto* type : {"bot", "group", "sticker"}) {
            const auto source = root / fs::path(type), moved = root / fs::path(std::string(type) + "-moved");
            CHECK(source.is_absolute() && source.parent_path() == root && moved.parent_path() == root);
            const auto renamed = MoveFileExW(native(source).c_str(), native(moved).c_str(), 0);
            const auto error = GetLastError();
            if (renamed) CHECK(MoveFileExW(native(moved).c_str(), native(source).c_str(), 0));
            CHECK(!renamed && error == ERROR_SHARING_VIOLATION);
        }
        CHECK(images.read_sticker(sticker).bytes == png);
    }
    for (const auto* type : {"bot", "group", "sticker"}) {
        const auto source = root / fs::path(type), moved = root / fs::path(std::string(type) + "-moved");
        CHECK(MoveFileExW(native(source).c_str(), native(moved).c_str(), 0));
        CHECK(MoveFileExW(native(moved).c_str(), native(source).c_str(), 0));
    }
    ImageAssets reopened(data); CHECK(reopened.read_sticker(sticker).bytes == png);
}
void capacity_and_integrity(const fs::path& output) {
    ImageAssetLimits limits; limits.max_stickers = 2; limits.max_avatars = 1;
    {
        ImageAssets images(output / L"count", limits);
        const auto first = images.add_sticker("one", png, "image/png");
        const auto second = images.add_sticker("two", png, "image/png");
        rejected([&] { (void)images.add_sticker("three", png, "image/png"); }, 413);
        CHECK(images.stickers().size() == 2); CHECK(images.remove_sticker(first.id));
        (void)images.add_sticker("three", png, "image/png"); CHECK(images.stickers().size() == 2);
        (void)images.put_avatar(AvatarScope::Bot, "owner", png, "image/png");
        rejected([&] { (void)images.put_avatar(AvatarScope::Group, "owner", png, "image/png"); }, 413);
        (void)images.put_avatar(AvatarScope::Bot, "owner", jpeg, "image/jpeg");
        CHECK(images.read_avatar(AvatarScope::Bot, "owner").bytes == jpeg);
        CHECK(images.read_sticker(second.id).bytes == png);
    }
    {
        limits.max_total_bytes = png.size() * 2;
        ImageAssets images(output / L"bytes", limits);
        (void)images.put_avatar(AvatarScope::Bot, "owner", png, "image/png");
        (void)images.add_sticker("one", png, "image/png");
        rejected([&] { (void)images.add_sticker("two", png, "image/png"); }, 413);
        rejected([&] { (void)images.put_avatar(AvatarScope::Bot, "owner", jpeg, "image/jpeg"); }, 413);
        CHECK(images.read_avatar(AvatarScope::Bot, "owner").bytes == png);
        CHECK(images.stickers().size() == 1);
    }
    {
        ImageAssetLimits small; small.max_stickers = 2;
        ImageAssets images(output / L"concurrent", small);
        std::atomic<unsigned> accepted = 0, denied = 0, errors = 0;
        std::vector<std::thread> threads;
        for (int i = 0; i < 8; ++i) threads.emplace_back([&] {
            try { (void)images.add_sticker("concurrent", png, "image/png"); ++accepted; }
            catch (const ImageAssetError& error) { if (error.status() == 413) ++denied; else ++errors; }
            catch (...) { ++errors; }
        });
        for (auto& thread : threads) thread.join();
        CHECK(accepted == 2); CHECK(denied == 6); CHECK(errors == 0); CHECK(images.stickers().size() == 2);
    }
    const auto corrupt_data = output / L"corrupt";
    std::string id;
    { ImageAssets images(corrupt_data); id = images.add_sticker("must not disappear", png, "image/png").id; }
    const auto path = corrupt_data / L"image-assets" / L"sticker" / fs::path(id + ".asset");
    auto bytes = read(path); bytes.back() ^= 1; write(path, bytes);
    rejected([&] { ImageAssets images(corrupt_data); }, 500);
    CHECK(read(path) == bytes);
}
} // namespace
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass the configured isolated test output directory");
        const auto base = fs::absolute(fs::path(argv[1])).lexically_normal();
        const auto allowed = fs::absolute(fs::path(DIMENSION_TEST_ROOT)).lexically_normal();
        if (base != allowed || base == base.root_path())
            throw std::runtime_error("Synthetic test output must remain in its configured isolated directory");
        const auto output = base / fs::path("run-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(native(output));
        validation(); lifecycle(output); directory_pins(output); capacity_and_integrity(output);
        std::cout << checks << " image asset checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL after " << checks << " checks: " << error.what() << '\n';
        return 1;
    }
}
