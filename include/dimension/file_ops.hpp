#pragma once

#include "dimension/json.hpp"

#include <filesystem>
#include <functional>
#include <stop_token>
#include <string>
#include <string_view>

namespace dimension {

struct FileEditRequest {
    std::filesystem::path root;
    std::filesystem::path target_path;
    std::string relative_path;
    std::string target_text;
    std::string replacement_text;
    bool replace_all = false;
    std::string expected_sha256{};
};

struct FileEditResult {
    bool ok = false;
    std::size_t replacements = 0;
    std::string before_sha256;
    std::string after_sha256;
    std::string line_ending; // "LF" or "CRLF"
    std::string message;
};

using BeforeFileWriteHook = std::function<void(std::string_view before_bytes, std::string_view after_bytes)>;

// Acquires a fine-grained per-file mutex so concurrent Bots editing different
// files never block each other, while concurrent edits to the same file
// serialize safely without silent overwrite. Automatically adapts LF target
// blocks to CRLF files while preserving the file's original line endings.
FileEditResult edit_file_locked(const FileEditRequest& request,
                                const BeforeFileWriteHook& on_before_write = {},
                                std::stop_token stop = {});

// Acquires the same per-file mutex for full-file writes so write_file and
// edit_file also coordinate safely across concurrent Work group Bots.
void write_file_locked(const std::filesystem::path& root,
                       const std::filesystem::path& target_path,
                       std::string_view content,
                       const BeforeFileWriteHook& on_before_write = {},
                       std::stop_token stop = {});

struct GrepOptions {
    std::string pattern;
    std::string sub_path{};
    std::string file_filter{};
    bool case_sensitive = true;
    bool use_regex = false;
    std::size_t max_matches = 60;
};

// Fast bounded C++20 native search skipping heavy cache/build/VCS directories
// and binary files. Safe for both local Windows paths and managed WSL paths.
Json grep_files(const std::filesystem::path& root,
                const GrepOptions& options,
                std::stop_token stop = {});

// Moves a local Windows file or directory to the Windows Recycle Bin
// (FOF_ALLOWUNDO) rather than permanently unlinking it. Rejects UNC paths,
// root drives, reparse points, and critical Windows system directories.
Json recycle_windows_path(const std::filesystem::path& target_path);

// Computes lowercase hex SHA-256 of arbitrary bytes.
std::string sha256_hex(std::string_view bytes);

} // namespace dimension
