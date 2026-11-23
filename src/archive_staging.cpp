#include "dimension/archive_staging.hpp"
#include "dimension/archive_export.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <initializer_list>
#include <map>
#include <mutex>
#include <optional>
#include <utility>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
using Clock = std::chrono::steady_clock;

[[noreturn]] void reject(int status, const char* code, const char* message) {
    throw ArchiveStageError(status, code, message);
}
void fields(const Json& value, std::initializer_list<std::string_view> expected) {
    if (!value.is_object() || value.as_object().size() != expected.size())
        reject(400, "archive_stage_request", "Invalid archive request fields");
    for (auto key : expected)
        if (!value.find(key)) reject(400, "archive_stage_request", "Missing archive request field");
}
std::string field_string(const Json& value, std::string_view key) {
    const auto* item = value.find(key);
    if (!item || !item->is_string())
        reject(400, "archive_stage_request", "Expected an archive request string");
    return item->as_string();
}
bool preserve_policy(const std::string& text) {
    if (text == "preserve-existing") return true;
    if (text == "reject-conflicts") return false;
    reject(400, "archive_stage_policy", "Unknown archive conflict policy");
}
void valid_token(std::string_view token) {
    if (token.size() != 32)
        reject(400, "archive_stage_token", "Invalid archive stage token");
    for (char c : token)
        if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f'))
            reject(400, "archive_stage_token", "Invalid archive stage token");
}
std::string new_token() {
    std::array<unsigned char, 16> random{};
    if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        reject(500, "archive_stage_random", "Cannot create archive stage identity");
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(32);
    for (auto byte : random) { result += hex[byte >> 4]; result += hex[byte & 15]; }
    return result;
}
Json counts(const StoreImportCounts& c) {
    return O{{"botsCreated", double(c.bots_created)}, {"botsPreserved", double(c.bots_preserved)},
             {"groupsCreated", double(c.groups_created)}, {"groupsPreserved", double(c.groups_preserved)},
             {"messagesCreated", double(c.messages_created)}, {"messagesReused", double(c.messages_reused)},
             {"messagesTombstoned", double(c.messages_tombstoned)},
             {"memoriesCreated", double(c.memories_created)}, {"memoriesPreserved", double(c.memories_preserved)},
             {"memoriesReused", double(c.memories_reused)}, {"memoriesTombstoned", double(c.memories_tombstoned)},
             {"midMemoriesCreated", double(c.mid_memories_created)}, {"midMemoriesPreserved", double(c.mid_memories_preserved)},
             {"midMemoriesReused", double(c.mid_memories_reused)}, {"midMemoriesTombstoned", double(c.mid_memories_tombstoned)}};
}
O coverage(int archive_version) {
    A excluded{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins",
               "accounts", "provider-settings", "application-settings"};
    if (archive_version == 1) excluded.emplace_back("group-metadata");
    return O{{"targetDataset", "native-store"}, {"archiveVersion", archive_version},
             {"coverage", archive_version >= 2 ? "conversation-and-group-data" : "private-conversation-data-only"},
             {"profileMetadataCompared", true}, {"groupMetadataCompared", archive_version >= 2},
             {"applicationMetadataCompared", false}, {"applicationMetadataPreserved", true},
             {"completeApplicationRestore", false}, {"defaultMemoryPolicy", "preserve-existing"},
             {"messageOrdering", "append-by-target-id"},
             {"deduplication", "stable-source-namespace-and-record-id"},
             {"excludedTypes", std::move(excluded)}};
}
Json plan_json(const StoreImportPlan& plan) {
    auto report = coverage(plan.archive_version);
    A issues;
    for (const auto& issue : plan.issues)
        issues.emplace_back(O{{"code", issue.code}, {"kind", issue.kind}, {"sourceId", issue.source_id}});
    report["targetRevision"] = std::to_string(plan.target_revision);
    report["digest"] = plan.digest;
    report["canCommit"] = plan.can_commit;
    report["counts"] = counts(plan.counts);
    report["issues"] = std::move(issues);
    report["issueCount"] = double(plan.issue_count);
    report["issuesTruncated"] = plan.issues_truncated;
    report["targetSnapshot"] = "sqlite-read-transaction";
    report["requiresCommitRecheck"] = true;
    return report;
}
Json result_json(const StoreImportResult& result, bool replayed) {
    auto report = coverage(result.archive_version);
    report["revisionBefore"] = std::to_string(result.revision_before);
    report["revisionAfter"] = std::to_string(result.revision_after);
    report["digest"] = result.digest;
    report["counts"] = counts(result.counts);
    // On a replay this is the receipt for the original operation, not new writes.
    report["countsDescribe"] = "original-commit";
    return O{{"committed", true}, {"replayed", replayed}, {"report", std::move(report)}};
}
} // namespace

ArchiveStageError::ArchiveStageError(int status, std::string code, std::string message)
    : std::runtime_error(std::move(message)), status_(status), code_(std::move(code)) {}

struct ArchiveStaging::Impl {
    struct Entry {
        std::optional<ArchiveDocument> archive;
        StoreImportOptions options;
        StoreImportPlan plan;
        Clock::time_point deadline;
        std::size_t bytes;
        std::optional<StoreImportResult> result;
    };
    Store& store;
    ArchiveStageLimits limits;
    std::function<void(const ArchiveDocument&)> guard;
    std::mutex mutex;
    std::map<std::string, Entry, std::less<>> entries;
    std::size_t bytes{};
    Impl(Store& target, ArchiveStageLimits caps, std::function<void(const ArchiveDocument&)> check)
        : store(target), limits(caps), guard(std::move(check)) {
        if (!limits.max_stages || limits.max_stages > 32 || !limits.max_source_bytes ||
            limits.max_source_bytes > 64U * 1024U * 1024U || !limits.max_request_bytes ||
            limits.max_request_bytes > 4U * 1024U * 1024U || limits.lifetime.count() <= 0 ||
            limits.lifetime > std::chrono::minutes(10))
            reject(400, "archive_stage_limits", "Invalid archive staging limits");
    }
    void prune() {
        const auto now = Clock::now();
        for (auto it = entries.begin(); it != entries.end();) {
            if (now >= it->second.deadline) {
                bytes -= it->second.bytes;
                it = entries.erase(it);
            } else ++it;
        }
    }
    auto find(std::string_view token) {
        valid_token(token);
        auto found = entries.find(token);
        if (found == entries.end())
            reject(404, "archive_stage_missing", "Archive stage is absent; prepare it again");
        if (Clock::now() >= found->second.deadline) {
            bytes -= found->second.bytes;
            entries.erase(found);
            reject(410, "archive_stage_expired", "Archive stage expired; prepare it again");
        }
        return found;
    }
};

ArchiveStaging::ArchiveStaging(Store& store, ArchiveStageLimits limits,
                             std::function<void(const ArchiveDocument&)> guard)
    : impl_(std::make_unique<Impl>(store, limits, std::move(guard))) {}
ArchiveStaging::~ArchiveStaging() = default;

Json ArchiveStaging::stage(std::string_view request) {
    return stage_request(request, false);
}
Json ArchiveStaging::stage_package(std::string_view request) {
    return stage_request(request, true);
}
Json ArchiveStaging::stage_request(std::string_view request, bool packaged) {
    if (request.size() > impl_->limits.max_request_bytes)
        reject(413, "archive_stage_size", "Archive request exceeds the byte limit");
    // Lock before any parse: only one decoded input/plan can be in flight.
    std::lock_guard lock(impl_->mutex);
    impl_->prune();
    if (impl_->entries.size() >= impl_->limits.max_stages ||
        request.size() > impl_->limits.max_source_bytes - impl_->bytes)
        reject(429, "archive_stage_capacity", "Archive staging capacity is full; discard a stage first");
    const auto envelope = Json::parse(request, impl_->limits.max_request_bytes);
    if (packaged) fields(envelope, {"package", "policies"});
    else fields(envelope, {"sourceId", "archive", "policies"});
    const auto& policies = envelope.at("policies");
    std::optional<ArchivePackage> bundle;
    if (packaged) bundle.emplace(parse_archive_package(envelope.at("package").dump()));
    auto archive = packaged ? bundle->archive : parse_archive(envelope.at("archive").dump());
    if (archive.version() >= 2) fields(policies, {"bots", "memories", "groups"});
    else fields(policies, {"bots", "memories"});
    StoreImportOptions options;
    options.source_id = packaged ? bundle->source_id : field_string(envelope, "sourceId");
    options.bot_conflict = preserve_policy(field_string(policies, "bots")) ? StoreBotConflict::PreserveExisting
                                                                          : StoreBotConflict::Reject;
    options.memory_conflict = preserve_policy(field_string(policies, "memories"))
                                  ? StoreMemoryConflict::PreserveExisting : StoreMemoryConflict::Reject;
    if (archive.version() >= 2)
        options.group_conflict = preserve_policy(field_string(policies, "groups"))
                                     ? StoreGroupConflict::PreserveExisting : StoreGroupConflict::Reject;
    if (impl_->guard) impl_->guard(archive);
    auto plan = impl_->store.prepare_archive_import(archive, options);
    auto token = new_token();
    while (impl_->entries.contains(token)) token = new_token();
    const auto deadline = Clock::now() + impl_->limits.lifetime;
    const auto expires = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch() + impl_->limits.lifetime).count();
    Json response = O{{"token", token}, {"expiresAtMs", std::to_string(expires)},
                      {"staged", true}, {"dataChanged", false}, {"report", plan_json(plan)}};
    impl_->entries.emplace(token, Impl::Entry{std::move(archive), std::move(options), std::move(plan),
                                              deadline, request.size(), {}});
    impl_->bytes += request.size();
    return response;
}

Json ArchiveStaging::commit(std::string_view token) {
    std::lock_guard lock(impl_->mutex);
    auto& entry = impl_->find(token)->second;
    if (entry.result) return result_json(*entry.result, true);
    if (!entry.plan.can_commit)
        reject(409, "archive_stage_blocked", "Archive conflicts require a new stage with supported policies");
    if (impl_->guard) impl_->guard(*entry.archive);
    auto result = impl_->store.commit_archive_import(*entry.archive, entry.options,
                                                     entry.plan.target_revision, entry.plan.digest);
    // Cache the durable receipt before JSON serialization. A response failure
    // must never turn a committed operation back into a ready stage.
    entry.result.emplace(std::move(result));
    entry.archive.reset();
    impl_->bytes -= entry.bytes;
    entry.bytes = 0;
    return result_json(*entry.result, false);
}

Json ArchiveStaging::discard(std::string_view token) {
    std::lock_guard lock(impl_->mutex);
    auto entry = impl_->find(token);
    const bool committed = entry->second.result.has_value();
    impl_->bytes -= entry->second.bytes;
    impl_->entries.erase(entry);
    return O{{"discarded", true}, {"committed", committed}, {"dataChanged", false}};
}
} // namespace dimension
