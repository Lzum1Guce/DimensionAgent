#pragma once

#include "dimension/json.hpp"

#include <filesystem>
#include <stop_token>
#include <string>
#include <string_view>

namespace dimension {

struct HostCommandRisk {
    bool requires_approval = true;
    std::string risk_level; // "safe_in_project" | "elevated_review"
    std::string reason;
};

// Classifies a Windows native command according to user policy:
// In-project build/test/read/script commands run without popups in `auto` mode;
// destructive deletions, OS/registry/process mutations, or unconfined paths
// require explicit user approval.
HostCommandRisk classify_host_command(std::string_view command,
                                      const std::filesystem::path& project_root,
                                      bool confined_to_project);

struct HostExecRequest {
    std::filesystem::path cwd;
    std::string command;
    std::string shell = "powershell"; // "powershell" or "cmd"
    int timeout_seconds = 120;
};

// Executes a native Windows command inside a hidden process tree managed by a
// Kill-on-Close Job Object. Captures bounded UTF-8 stdout/stderr and terminates
// the entire process tree on timeout or cancellation.
Json execute_host_command(const HostExecRequest& request, std::stop_token stop = {});

} // namespace dimension
