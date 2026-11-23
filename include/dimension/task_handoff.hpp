#pragma once
#include "dimension/json.hpp"
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace dimension {

class TaskHandoffError final : public std::runtime_error {
public:
    TaskHandoffError(int status, std::string code);
    const int status;
};

// Holds every ancestor directory with real directory-read access and without
// DELETE sharing, and the regular, single-link file without write/delete sharing.
// The path is never returned in an error or in a handoff document. Keeping this
// object alive also makes its directory/file identity stable for bounded reads.
class HandoffFileReader {
public:
    HandoffFileReader(const std::filesystem::path& root, const std::string& relative,
                      std::size_t maximum_bytes = 8U * 1024U * 1024U);
    ~HandoffFileReader();
    HandoffFileReader(const HandoffFileReader&) = delete;
    HandoffFileReader& operator=(const HandoffFileReader&) = delete;
    [[nodiscard]] std::size_t size() const noexcept;
    [[nodiscard]] std::string read();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

[[nodiscard]] std::string read_handoff_artifact(const std::filesystem::path& root,
    const std::string& relative, std::size_t maximum_bytes = 8U * 1024U * 1024U);

struct TaskHandoffArtifact {
    // Root/relative are trusted application mappings of already listed task,
    // project or child artifacts. Never accept an HTTP body path here.
    std::filesystem::path root;
    std::string relative;
    std::string name;
    std::string media_type;
    std::uint64_t declared_bytes{};
    bool available = true;
    // Set false for execution receipts/raw logs/accounts, even if listed as
    // evidence by the original tool. Only a generic omission code is exported.
    bool transferable = true;
};

struct TaskHandoffSource {
    // RunService::get(id) is already a value snapshot under its lock. The module
    // whitelists fields; messages/tools/requests/receipts are never serialized.
    Json run_snapshot;
    // [{key,runId,botId,job,status,answer,dependsOn:[job-key,...]}]. Root supplies
    // real child summaries and dependencies; missing dependencies stay unknown.
    Json children = Json::Array{};
    std::vector<TaskHandoffArtifact> artifacts;
    // Optional exact sensitive literals known to the caller. Never exported.
    // This is not a claim to find every secret inside arbitrary attachment bytes.
    std::vector<std::string> sensitive_values;
};

struct TaskHandoffOptions { bool include_files = false; };
struct TaskHandoffLimits {
    std::size_t max_files = 32;
    std::size_t max_file_bytes = 8U * 1024U * 1024U;
    std::size_t max_total_file_bytes = 16U * 1024U * 1024U;
    std::size_t max_package_bytes = 24U * 1024U * 1024U;
    std::size_t max_text_bytes = 1024U * 1024U;
    std::size_t max_children = 64;
};
struct TaskHandoffPackage {
    Json document;
    std::string bytes;
    std::string filename;
};

// Metadata-only export performs no file reads and explicitly labels sizes as
// declared and hashes as absent. The snapshot preserves all decisions, the clean
// latest decision, artifact references and factual unresolved run/child items.
// include_files reads only eligible artifacts using the pinned reader, includes
// exact bytes/base64 + their SHA256, and fails atomically if an eligible file is
// missing/changed/unsafe/over budget. There is no import, process restore,
// receipt export, external request or file write.
[[nodiscard]] TaskHandoffPackage make_task_handoff(const TaskHandoffSource&,
    TaskHandoffOptions = {}, TaskHandoffLimits = {});

} // namespace dimension
