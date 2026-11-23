#pragma once

#include "dimension/json.hpp"

#include <cstdint>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

struct CheckpointEntryInfo {
    std::string id;                 // e.g. "cp-1", "cp-2"
    int version_number = 1;         // 1-based human label: v1, v2, v3...
    std::string label;              // Short summary of user prompt for this turn
    std::int64_t created_at_ms = 0;
    std::size_t file_count = 0;
    std::uintmax_t total_bytes = 0;
    std::string primary_html_rel;   // Relative path of main .html / .svg deliverable if present
    Json to_json() const;
};

struct CheckpointRestoreResult {
    bool ok = false;
    std::string checkpoint_id;
    int version_number = 0;
    std::size_t restored_files = 0;
    std::size_t removed_extra_files = 0;
    std::string backup_checkpoint_id; // Automatic safety snapshot captured right before restore
    Json to_json() const;
};

// Time-Machine Workspace Checkpoint Service:
// Automatically captures lightweight per-turn workspace snapshots (v1, v2, v3...)
// so users can preview historical HTML/SVG versions side-by-side in Live Canvas
// or roll back the entire workspace to any previous turn in one click.
class WorkCheckpointService final {
public:
    explicit WorkCheckpointService(std::filesystem::path storage_root);

    // Captures a snapshot of `workspace_dir` under `root_run_id`.
    // Skips build caches (.git, node_modules, build, .venv, scratch, etc.).
    std::optional<CheckpointEntryInfo> capture(
        const std::string& root_run_id,
        std::string_view label,
        const std::filesystem::path& workspace_dir,
        bool is_auto_backup = false);

    // Lists all user-facing checkpoints (v1, v2, ...) for `root_run_id` in chronological order.
    [[nodiscard]] std::vector<CheckpointEntryInfo> list(const std::string& root_run_id) const;

    // Reads a single file's historical content from a specific checkpoint (e.g. for Live Canvas v1/v2 preview).
    [[nodiscard]] std::optional<std::string> read_checkpoint_file(
        const std::string& root_run_id,
        const std::string& checkpoint_id,
        std::string_view relative_path) const;

    // Restores `workspace_dir` to match `checkpoint_id` (creates an automatic safety backup first).
    CheckpointRestoreResult restore(
        const std::string& root_run_id,
        const std::string& checkpoint_id,
        const std::filesystem::path& workspace_dir);

private:
    std::filesystem::path storage_root_;
    mutable std::mutex mutex_;
};

} // namespace dimension
