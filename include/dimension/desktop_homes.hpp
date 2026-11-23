#pragma once

#include "dimension/json.hpp"

#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

struct DesktopHome {
    std::filesystem::path windows_path;
    std::string linux_path;
    std::string storage; // "windows" or "linux"
};

// Trusted test seam, never a model tool. The default worker is private fixed
// Python over a hidden JsonProcessSession; root/path values travel in JSON.
using NativeHomePrepare = std::function<Json(
    const std::filesystem::path& wsl_executable,
    const std::vector<std::wstring>& arguments,
    const std::filesystem::path& cwd,
    const Json& request, std::stop_token)>;

class DesktopHomes final {
public:
    DesktopHomes(std::filesystem::path data_directory, std::string distribution,
                 std::optional<std::string> linux_root = {},
                 std::filesystem::path wsl_executable = {},
                 NativeHomePrepare prepare = {});
    ~DesktopHomes();
    DesktopHomes(const DesktopHomes&) = delete;
    DesktopHomes& operator=(const DesktopHomes&) = delete;

    // Legacy path must be data_directory/desktops/<botHash>/home. A previously
    // chosen location is sticky; missing recorded homes fail instead of reset.
    // Linux root must already exist under the actual default WSL user's home.
    // Host ownership is distinct from the sandbox's internal guest UID/GID.
    [[nodiscard]] DesktopHome resolve(std::string_view bot_hash,
                                     const std::filesystem::path& legacy_windows_home,
                                     std::stop_token stop = {});
    // Empty launch configuration can inherit the previously bound distribution.
    [[nodiscard]] std::string distribution() const;

    static void validate_linux_root(std::string_view);
    static void validate_distribution(std::string_view);
    static void validate_bot_hash(std::string_view);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dimension
