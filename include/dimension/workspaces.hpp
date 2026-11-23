#pragma once
#include "dimension/json.hpp"
#include <filesystem>
#include <memory>
#include <string>

namespace dimension {
// A run's project binding is immutable. Changing a Bot's preferred folder never
// redirects old task tools or artifact URLs into a different project.
class WorkspaceBindings {
public:
    WorkspaceBindings(std::filesystem::path metadata, std::filesystem::path tasks);
    ~WorkspaceBindings();
    std::filesystem::path bind(const std::string& run, const std::string& bot,
                               const std::filesystem::path& project);
    std::filesystem::path project(const std::string& run, const std::string& bot) const;
    // Non-blocking metadata lookup for read-only catalog/session views (never wakes asleep WSL UNC mounts).
    std::filesystem::path peek_project(const std::string& run, const std::string& bot) const;
    std::filesystem::path task(const std::string& run) const;
    Json describe(const std::string& run, const std::string& bot) const;
    static std::filesystem::path validate_project(const std::filesystem::path&, bool create = true);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
