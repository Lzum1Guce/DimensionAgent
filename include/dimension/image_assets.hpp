#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

class ImageAssetError final : public std::runtime_error {
public:
    ImageAssetError(int status, std::string code, std::string message);
    [[nodiscard]] int status() const noexcept { return status_; }
    [[nodiscard]] const std::string& code() const noexcept { return code_; }
private:
    int status_;
    std::string code_;
};

struct ImageLimits {
    std::size_t max_bytes = 8U * 1024U * 1024U;
    std::uint32_t max_axis = 8192;
    std::uint64_t max_decoded_pixels = 40U * 1024U * 1024U;
    std::uint32_t max_frames = 256;
};

struct ImageInfo {
    std::string mime;
    std::uint32_t width = 0, height = 0, frames = 1;
    bool animated = false;
    bool operator==(const ImageInfo&) const = default;
};

// No disk writes. Checks PNG/JPEG/GIF/WebP structure and decodes every frame
// through the Windows system codec in bounded strips. MIME is detected from
// bytes, never taken from a filename or the request header. APNG is rejected
// explicitly because the system PNG codec does not validate its extra frames.
// Decoder tolerance is not a claim of complete compressed-bitstream conformance.
[[nodiscard]] ImageInfo inspect_image(std::string_view bytes, ImageLimits = {});

enum class AvatarScope { Bot, Group };

struct ImageAsset {
    std::string id, name, revision;
    ImageInfo image;
    std::size_t byte_size = 0;
};
struct ImageAssetContent {
    ImageAsset asset;
    std::string bytes;
};
struct ImageAssetLimits {
    ImageLimits image;
    std::size_t max_stickers = 512;
    std::size_t max_avatars = 4096;
    std::size_t max_total_bytes = 256U * 1024U * 1024U;
};

// Owns data/image-assets only. Each record is one atomic file containing strict
// metadata and the original image bytes. User strings never become paths;
// avatars use a scope/identity hash and stickers use random opaque IDs.
// A per-directory owner lock prevents two writers; all operations serialize.
// Does not migrate old assets, fetch URLs, modify Bot/group data or run a model.
class ImageAssets final {
public:
    explicit ImageAssets(const std::filesystem::path& data, ImageAssetLimits = {});
    ~ImageAssets();
    ImageAssets(const ImageAssets&) = delete;
    ImageAssets& operator=(const ImageAssets&) = delete;

    [[nodiscard]] std::optional<ImageAsset> avatar(AvatarScope, std::string_view owner) const;
    [[nodiscard]] ImageAssetContent read_avatar(AvatarScope, std::string_view owner) const;
    [[nodiscard]] ImageAsset put_avatar(AvatarScope, std::string_view owner,
        std::string_view bytes, std::string_view declared_mime);
    bool remove_avatar(AvatarScope, std::string_view owner);

    [[nodiscard]] std::vector<ImageAsset> stickers() const;
    [[nodiscard]] ImageAssetContent read_sticker(std::string_view id) const;
    [[nodiscard]] ImageAsset add_sticker(std::string_view name,
        std::string_view bytes, std::string_view declared_mime);
    bool remove_sticker(std::string_view id);
    [[nodiscard]] std::uint64_t revision() const noexcept;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
