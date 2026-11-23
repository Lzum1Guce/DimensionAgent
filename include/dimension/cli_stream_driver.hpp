#pragma once

#include "dimension/json.hpp"

#include <filesystem>
#include <functional>
#include <stop_token>
#include <string>
#include <vector>

namespace dimension {

struct CliStreamRequest {
    std::string profile_id;
    std::string binary;                   // e.g. "/opt/dimension-tools/bin/claude" or "blender.exe"
    std::string platform = "wsl";         // "wsl" or "windows"
    std::vector<std::string> base_args;   // e.g. ["-p", "--output-format", "stream-json"]
    std::vector<std::string> task_args;   // Prompt or script arguments appended after base_args
    std::filesystem::path workspace_path; // Host or managed WSL workspace path
    std::string bot_linux_home{};         // Optional persistent isolated Bot home in WSL (e.g. /home/dimension/.dimension-native-.../bot-xxx)
    std::filesystem::path wsl_executable{};
    std::string sandbox_distribution{};
    int timeout_seconds = 300;
};

using CliStreamProgressCallback = std::function<void(std::size_t line_count,
                                                     const std::string& latest_line,
                                                     std::int64_t elapsed_ms)>;

// Runs an external subscribed Agent CLI (Claude Code, Codex, Gemini CLI) or
// headless pro tool (Blender -b -P) with real-time line streaming, persistent
// per-Bot credential home isolation, and instant JobObject cancellation.
Json execute_cli_stream(const CliStreamRequest& request,
                        const CliStreamProgressCallback& on_progress = {},
                        std::stop_token stop = {});

// Probes whether a registered CLI profile binary exists and is executable
// (without consuming subscription tokens or modifying files).
Json probe_cli_profile(const Json& profile,
                       const std::filesystem::path& wsl_executable,
                       const std::string& sandbox_distribution);

} // namespace dimension
