#pragma once

#include "dimension/archive.hpp"
#include <chrono>
#include <functional>
#include <memory>

namespace dimension {

class ArchiveStageError final : public std::runtime_error {
public:
    ArchiveStageError(int status, std::string code, std::string message);
    [[nodiscard]] int status() const noexcept { return status_; }
    [[nodiscard]] const std::string& code() const noexcept { return code_; }
private:
    int status_;
    std::string code_;
};

struct ArchiveStageLimits {
    std::size_t max_stages = 4;
    std::size_t max_source_bytes = 16U * 1024U * 1024U;
    std::size_t max_request_bytes = 4U * 1024U * 1024U;
    std::chrono::milliseconds lifetime = std::chrono::minutes(10);
};

// One process-local staging area per target Store. Parse/prepare/commit/discard
// are serialized before parsing, bounding concurrent decoded documents. Source
// bytes are a budget for JSON input, not an estimate of total resident memory.
// Nothing is written to a staging file; restart drops uncommitted stages.
// A trusted optional guard checks application metadata before prepare/commit.
class ArchiveStaging final {
public:
    explicit ArchiveStaging(Store&, ArchiveStageLimits = {},
        std::function<void(const ArchiveDocument&)> guard = {});
    ~ArchiveStaging();
    ArchiveStaging(const ArchiveStaging&) = delete;
    ArchiveStaging& operator=(const ArchiveStaging&) = delete;

    // Strict envelope: {sourceId, archive, policies:{bots,memories}}.
    // Both policy strings must be selected: preserve-existing/reject-conflicts.
    // Version 2 also requires a groups policy, frozen with the same stage.
    [[nodiscard]] Json stage(std::string_view request);
    // Strict verified-export envelope: {package, policies:{bots,memories,groups}}.
    // Checksum verification and parsing share the existing admission/slot lock.
    [[nodiscard]] Json stage_package(std::string_view request);
    // Token-only input: content/policies cannot change between stage and commit.
    [[nodiscard]] Json commit(std::string_view token);
    // Discard never rolls back committed data. If commit won the race this
    // returns committed=true; the caller must not present it as cancellation.
    [[nodiscard]] Json discard(std::string_view token);
private:
    [[nodiscard]] Json stage_request(std::string_view request, bool packaged);
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace dimension
