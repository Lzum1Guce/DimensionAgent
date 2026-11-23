#pragma once
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>

namespace dimension {
namespace managed_workspaces {
namespace fs = std::filesystem;
inline std::string utf8(const fs::path& path) {
    const auto value = path.u8string();
    return {reinterpret_cast<const char*>(value.data()), value.size()};
}
inline bool valid_distribution(const std::string& distribution) {
    return std::regex_match(distribution, std::regex("[A-Za-z0-9_.-]{1,80}"));
}
inline bool valid_key(const std::string& key) {
    return std::regex_match(key, std::regex("bot-[0-9a-f]{32}"));
}
inline fs::path windows_path(const std::string& distribution, const std::string& key) {
    if (!valid_distribution(distribution) || !valid_key(key))
        throw std::runtime_error("托管工作区标识无效");
    return fs::path(L"\\\\wsl.localhost\\" + std::wstring(distribution.begin(), distribution.end()) +
                    L"\\var\\lib\\dimension\\managed\\" + std::wstring(key.begin(), key.end()));
}
inline std::string linux_path(const std::string& key) {
    if (!valid_key(key)) throw std::runtime_error("托管工作区标识无效");
    return "/var/lib/dimension/managed/" + key;
}
inline std::optional<std::string> key_from_windows(const fs::path& input,
                                                    const std::string& distribution) {
    if (!valid_distribution(distribution)) return std::nullopt;
    auto value = utf8(input.lexically_normal());
    std::replace(value.begin(), value.end(), '\\', '/');
    while (value.size() > 1 && value.back() == '/') value.pop_back();
    std::string prefix = "//wsl.localhost/" + distribution + "/var/lib/dimension/managed/";
    if (value.size() < prefix.size()) return std::nullopt;
    std::string host = value.substr(0, 15);
    std::transform(host.begin(), host.end(), host.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (host != "//wsl.localhost" || !value.starts_with(prefix)) return std::nullopt;
    const auto key = value.substr(prefix.size());
    return valid_key(key) ? std::optional<std::string>(key) : std::nullopt;
}
inline std::optional<std::string> key_from_windows_any(const fs::path& input) {
    auto value = utf8(input.lexically_normal());
    std::replace(value.begin(), value.end(), '\\', '/');
    const std::string host = "//wsl.localhost/";
    if (value.size() <= host.size()) return std::nullopt;
    std::string actual_host = value.substr(0, host.size());
    std::transform(actual_host.begin(), actual_host.end(), actual_host.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (actual_host != host) return std::nullopt;
    const auto end = value.find('/', host.size());
    if (end == std::string::npos) return std::nullopt;
    return key_from_windows(input, value.substr(host.size(), end - host.size()));
}
inline std::optional<std::string> key_from_windows_descendant(const fs::path& input,
                                                               const std::string& distribution) {
    if (!valid_distribution(distribution)) return std::nullopt;
    auto value = utf8(input.lexically_normal());
    std::replace(value.begin(), value.end(), '\\', '/');
    const std::string prefix = "//wsl.localhost/" + distribution + "/var/lib/dimension/managed/";
    if (value.size() < prefix.size() + 36) return std::nullopt;
    std::string actual_host = value.substr(0, 15);
    std::transform(actual_host.begin(), actual_host.end(), actual_host.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (actual_host != "//wsl.localhost" || !value.starts_with(prefix)) return std::nullopt;
    const auto key = value.substr(prefix.size(), 36);
    const auto offset = prefix.size() + key.size();
    if (!valid_key(key) || (value.size() > offset && value[offset] != '/')) return std::nullopt;
    return key;
}
inline std::optional<std::string> key_from_windows_any_descendant(const fs::path& input) {
    auto value = utf8(input.lexically_normal());
    std::replace(value.begin(), value.end(), '\\', '/');
    const std::string host = "//wsl.localhost/";
    if (value.size() <= host.size()) return std::nullopt;
    std::string actual_host = value.substr(0, host.size());
    std::transform(actual_host.begin(), actual_host.end(), actual_host.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (actual_host != host) return std::nullopt;
    const auto end = value.find('/', host.size());
    if (end == std::string::npos) return std::nullopt;
    return key_from_windows_descendant(input, value.substr(host.size(), end - host.size()));
}
inline std::optional<fs::path> root_from_windows_descendant(const fs::path& input) {
    auto value = utf8(input.lexically_normal());
    std::replace(value.begin(), value.end(), '\\', '/');
    const std::string host = "//wsl.localhost/";
    if (value.size() <= host.size()) return std::nullopt;
    std::string actual_host = value.substr(0, host.size());
    std::transform(actual_host.begin(), actual_host.end(), actual_host.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (actual_host != host) return std::nullopt;
    const auto end = value.find('/', host.size());
    if (end == std::string::npos) return std::nullopt;
    const auto distribution = value.substr(host.size(), end - host.size());
    const auto key = key_from_windows_descendant(input, distribution);
    if (!key) return std::nullopt;
    return windows_path(distribution, *key);
}
} // namespace managed_workspaces
} // namespace dimension
