#pragma once
#include <filesystem>
#include <memory>
#include <map>
#include <string>
namespace dimension {
// Own loopback origin. Grants expose only local web resources under the
// delivered HTML's directory; they expire and never expose application APIs.
class PreviewService {
public:
    PreviewService();
    ~PreviewService();
    using SnapshotPaths = std::map<std::filesystem::path, std::filesystem::path>;
    std::string url(const std::filesystem::path& html, const std::filesystem::path& entry = {},
                    const SnapshotPaths& snapshots = {});
    void shutdown() noexcept;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
