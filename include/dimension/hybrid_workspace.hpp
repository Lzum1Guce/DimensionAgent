#pragma once

#include "dimension/json.hpp"

#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

struct HybridWorkspaceOptions {
    std::filesystem::path state_root;
    std::filesystem::path wsl_executable{};
    std::string sandbox_distribution{};
    // Optional local directory override for deterministic unit testing without WSL.
    std::filesystem::path local_slots_override{};
};

struct ProjectModeDecision {
    std::string mode;   // "sandbox_checkout" | "windows_native"
    std::string reason; // Human-readable explanation in Simplified Chinese
    bool auto_detected = true;
};

using HostFileBackupHook = std::function<void(const std::string& relative_path,
                                              const std::filesystem::path& host_target,
                                              std::string_view new_bytes)>;

class HybridWorkspaceService {
public:
    explicit HybridWorkspaceService(HybridWorkspaceOptions options);

    // Recommends "windows_native" for MSVC/Win32/.NET solutions and
    // "sandbox_checkout" for general cross-platform projects, unless overridden.
    static ProjectModeDecision resolve_mode(const std::filesystem::path& host_project,
                                            std::string_view configured_mode = "auto");

    // Streams clean project source files (skipping node_modules, build, .git, etc.)
    // into an isolated per-run/per-Bot sandbox slot (`bot-<32hex>`) and records
    // baseline SHA-256 + CRLF/LF metadata. Idempotent if already checked out for `run_id`.
    Json checkout(const std::string& run_id,
                  const std::string& bot_id,
                  const std::filesystem::path& host_project);

    // Returns checkout metadata for `run_id`, or null Json if `run_id` does not
    // use sandbox checkout.
    bool has_checkout(const std::string& run_id) const;
    Json status(const std::string& run_id) const;

    // Computes added / modified / deleted source files in the sandbox slot
    // relative to checkout baseline (ignoring line-ending-only noise and build
    // caches generated inside the sandbox), plus Windows host conflict flags.
    Json diff(const std::string& run_id) const;

    // Applies sandbox changes back to the Windows host project:
    // - Restores original CRLF/LF style per file
    // - Invokes `on_backup` before overwriting host files
    // - Sends deleted host files to Windows Recycle Bin
    // - Optionally reclaims the sandbox slot immediately to prevent VHDX bloat
    Json sync_back(const std::string& run_id,
                   const std::vector<std::string>& only_paths = {},
                   bool force_conflicts = false,
                   bool cleanup_slot = true,
                   const HostFileBackupHook& on_backup = {});

    // Discards the sandbox slot without modifying the Windows host project.
    Json discard(const std::string& run_id);

    // Registry of external subscribed Agent CLIs & headless tools (Claude Code, Codex, Blender).
    Json cli_profiles() const;
    Json save_cli_profile(const Json& profile);

private:
    HybridWorkspaceOptions options_;
    mutable std::mutex mutex_;

    std::filesystem::path manifest_path(const std::string& run_id) const;
    std::filesystem::path ensure_slot_directory(const std::string& slot_key) const;
    void remove_slot_directory(const std::string& slot_key, const std::filesystem::path& slot_win_path) const;
};

} // namespace dimension
