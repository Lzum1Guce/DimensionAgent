#pragma once

#include "dimension/json.hpp"
#include "dimension/store.hpp"

#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace dimension {

enum class ArchiveErrorCode {
    InvalidJson, InvalidFormat, UnsupportedVersion, UnsupportedType,
    InvalidRecord, InvalidReference, LimitExceeded
};

class ArchiveError final : public std::runtime_error {
public:
    ArchiveError(ArchiveErrorCode code, std::string path, std::string message);
    [[nodiscard]] ArchiveErrorCode code() const noexcept { return code_; }
    [[nodiscard]] const std::string& path() const noexcept { return path_; }
private:
    ArchiveErrorCode code_;
    std::string path_;
};

struct ArchiveLimits {
    std::size_t max_bytes = 4U * 1024U * 1024U;
    std::size_t max_bots = 1024;
    std::size_t max_conversations = 2048;
    std::size_t max_messages = 20000;
    std::size_t max_memories = 10000;
    std::size_t max_target_records = 50000;
    std::size_t max_target_bytes = 32U * 1024U * 1024U;
    std::size_t max_report_items = 256;
    std::size_t max_groups = 256;
    std::size_t max_mid_memories = mid_memory_total_limit;
};

struct ArchiveConversation {
    std::string bot_id;
    std::string group_id;
    Mode mode = Mode::Chat;
    std::vector<Message> messages; // IDs/timestamps are source values, not target IDs.
};

// A validated, immutable conversation-data document. Does not open a database
// or file. Copies share immutable storage; source records retain all supported
// fields. v1 has no group metadata; v2 includes explicit Group identities.
class ArchiveDocument final {
public:
    [[nodiscard]] int version() const noexcept;
    [[nodiscard]] const std::vector<Bot>& bots() const noexcept;
    [[nodiscard]] const std::vector<Group>& groups() const noexcept;
    [[nodiscard]] const std::vector<ArchiveConversation>& conversations() const noexcept;
    [[nodiscard]] const std::vector<Memory>& memories() const noexcept;
    [[nodiscard]] const std::vector<MidMemory>& mid_memories() const noexcept;
    [[nodiscard]] std::size_t size_bytes() const noexcept;
private:
    struct Data;
    std::shared_ptr<const Data> data_;
    explicit ArchiveDocument(std::shared_ptr<const Data> data);
    friend ArchiveDocument parse_archive(std::string_view, ArchiveLimits);
};

[[nodiscard]] ArchiveDocument parse_archive(std::string_view bytes, ArchiveLimits limits = {});
[[nodiscard]] std::string encode_archive(const ArchiveDocument& archive);

// Calls only Store's public read methods, never imports or mutates data.
// Target reads are bounded but are not one transaction/snapshot. All matches
// are preview candidates; commit must recheck state and explicitly choose a
// conflict policy. Existing memories are preserved by default.
// The report contains locators/counts/field names, never personas/message/memory
// bodies or group names. v1 group scopes remain blocked; v2 compares only the
// explicitly supplied group metadata and still requires staged conflict policy.
[[nodiscard]] Json preflight_archive(const ArchiveDocument& archive, const Store& target,
                                    ArchiveLimits limits = {});

} // namespace dimension
