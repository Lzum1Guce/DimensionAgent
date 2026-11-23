#pragma once
#include <filesystem>
#include <memory>
#include <string>
namespace dimension {
// Own loopback origin. Grants expose only local web resources under the
// delivered HTML's directory; they expire and never expose application APIs.
class PreviewService {
public:
    PreviewService();
    ~PreviewService();
    std::string url(const std::filesystem::path& html);
    void shutdown() noexcept;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
