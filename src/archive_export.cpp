#include "dimension/archive_export.hpp"
#include "dimension/message_context.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <initializer_list>
#include <limits>
#include <map>
#include <tuple>
#include <utility>

namespace dimension {
namespace {
using O = Json::Object;
using A = Json::Array;
constexpr std::size_t max_archive_bytes = 4U * 1024U * 1024U - 8192U;
constexpr std::size_t max_package_bytes = 4U * 1024U * 1024U - 4096U;

[[noreturn]] void reject(ArchiveErrorCode code, const char* path, const char* reason) {
    throw ArchiveError(code, path, reason);
}
ArchiveLimits bounded_limits(ArchiveLimits limits) {
    if (!limits.max_bytes || limits.max_bytes > 64U * 1024U * 1024U ||
        !limits.max_target_records || !limits.max_target_bytes ||
        !limits.max_report_items || limits.max_report_items > 4096)
        reject(ArchiveErrorCode::InvalidFormat, "/limits", "Invalid archive limits");
    const ArchiveLimits native;
    limits.max_bytes = std::min(limits.max_bytes, max_archive_bytes);
    limits.max_bots = std::min(limits.max_bots, native.max_bots);
    limits.max_groups = std::min(limits.max_groups, native.max_groups);
    limits.max_conversations = std::min(limits.max_conversations, native.max_conversations);
    limits.max_messages = std::min(limits.max_messages, native.max_messages);
    limits.max_memories = std::min(limits.max_memories, native.max_memories);
    limits.max_mid_memories = std::min(limits.max_mid_memories, native.max_mid_memories);
    return limits;
}
void fields(const Json& value, std::initializer_list<std::string_view> names, const char* path) {
    if (!value.is_object()) reject(ArchiveErrorCode::InvalidRecord, path, "Expected a package object");
    for (const auto& [key, ignored] : value.as_object()) {
        (void)ignored;
        if (std::find(names.begin(), names.end(), key) == names.end())
            reject(ArchiveErrorCode::UnsupportedType, path, "Unknown package field");
    }
    for (const auto name : names)
        if (!value.find(name)) reject(ArchiveErrorCode::InvalidRecord, path, "Required package field is absent");
}
const std::string& text(const Json& value, const char* path) {
    if (!value.is_string()) reject(ArchiveErrorCode::InvalidRecord, path, "Expected a package string");
    return value.as_string();
}
void fixed_string(const Json& value, std::string_view expected, const char* path) {
    if (text(value, path) != expected)
        reject(ArchiveErrorCode::InvalidFormat, path, "Unsupported package metadata");
}
bool lower_hex(std::string_view value, std::size_t size) {
    return value.size() == size && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
void validate_source(std::string_view source) {
    if (!source.starts_with("native-") || !lower_hex(source.substr(7), 32))
        reject(ArchiveErrorCode::InvalidRecord, "/sourceId", "Invalid native source identity");
}
std::int64_t source_revision(const Json& value) {
    const auto& encoded = text(value, "/sourceRevision");
    std::int64_t revision{};
    const auto parsed = std::from_chars(encoded.data(), encoded.data() + encoded.size(), revision);
    if (encoded.empty() || encoded.size() > 20 || parsed.ec != std::errc{} ||
        parsed.ptr != encoded.data() + encoded.size() || revision < 0 || std::to_string(revision) != encoded)
        reject(ArchiveErrorCode::InvalidRecord, "/sourceRevision", "Expected a canonical nonnegative int64 string");
    return revision;
}
std::string sha256(std::string_view bytes) {
    struct Handles {
        BCRYPT_ALG_HANDLE algorithm{};
        BCRYPT_HASH_HANDLE hash{};
        ~Handles() {
            if (hash) BCryptDestroyHash(hash);
            if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
        }
    } handles;
    if (bytes.size() > std::numeric_limits<ULONG>::max() ||
        BCryptOpenAlgorithmProvider(&handles.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0 ||
        BCryptCreateHash(handles.algorithm, &handles.hash, nullptr, 0, nullptr, 0, 0) < 0 ||
        BCryptHashData(handles.hash, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),
                       static_cast<ULONG>(bytes.size()), 0) < 0)
        throw StoreError(StoreErrorCode::Storage, "Cannot hash native export content");
    std::array<unsigned char, 32> output{};
    if (BCryptFinishHash(handles.hash, output.data(), static_cast<ULONG>(output.size()), 0) < 0)
        throw StoreError(StoreErrorCode::Storage, "Cannot finish native export digest");
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(64);
    for (const auto byte : output) { result += hex[byte >> 4U]; result += hex[byte & 15U]; }
    return result;
}
const char* mode_name(Mode mode) {
    if (mode == Mode::Chat) return "chat";
    if (mode == Mode::Work) return "work";
    reject(ArchiveErrorCode::InvalidRecord, "/archive/conversations", "Invalid recorded conversation mode");
}
const char* state_name(MemoryState state) {
    if (state == MemoryState::Candidate) return "candidate";
    if (state == MemoryState::Confirmed) return "confirmed";
    if (state == MemoryState::Rejected) return "rejected";
    reject(ArchiveErrorCode::InvalidRecord, "/archive/memories", "Invalid recorded memory state");
}
A strings(const std::vector<std::string>& values) {
    A result;
    for (const auto& value : values) result.emplace_back(value);
    return result;
}
Json snapshot_document(const StoreArchiveSnapshot& snapshot, const ArchiveLimits& limits) {
    A bots, groups, conversations, memories, mid_memories;
    for (const auto& bot : snapshot.bots)
        bots.emplace_back(O{{"id", bot.id}, {"name", bot.name}, {"persona", bot.persona},
                            {"inChat", bot.in_chat}, {"inWork", bot.in_work}});
    for (const auto& group : snapshot.groups)
        groups.emplace_back(O{{"id", group.id}, {"name", group.name}, {"ownerId", group.owner_id},
                              {"admins", strings(group.admins)}, {"members", strings(group.members)},
                              {"historyMembers", strings(group.history_members)}, {"inChat", group.in_chat},
                              {"inWork", group.in_work}, {"deleted", group.deleted},
                              {"seal", O{{"shape", group.seal_shape}, {"color", group.seal_color}}},
                              {"revision", std::to_string(group.revision)}});
    using Scope = std::tuple<std::string, std::string, Mode>;
    std::map<Scope, A> scoped;
    bool with_contexts = !snapshot.mid_memories.empty();
    for (const auto& message : snapshot.messages) {
        (void)mode_name(message.mode);
        const Scope key{message.bot_id, message.group_id, message.mode};
        if (!scoped.contains(key) && scoped.size() >= limits.max_conversations)
            reject(ArchiveErrorCode::LimitExceeded, "/archive/conversations", "Export conversation limit exceeded");
        O row{{"id", std::to_string(message.id)}, {"actor", message.actor},
              {"text", message.text}, {"createdAtMs", std::to_string(message.created_at_ms)}};
        if (message.context) { row.emplace("context", message_context_json(*message.context)); with_contexts = true; }
        scoped[key].emplace_back(std::move(row));
    }
    for (auto& [scope, messages] : scoped)
        conversations.emplace_back(O{{"botId", std::get<0>(scope)}, {"groupId", std::get<1>(scope)},
                                     {"mode", mode_name(std::get<2>(scope))}, {"messages", std::move(messages)}});
    for (const auto& memory : snapshot.memories) {
        auto row = O{{"id", std::to_string(memory.id)}, {"botId", memory.bot_id},
                     {"groupId", memory.group_id}, {"text", memory.text},
                     {"state", state_name(memory.state)}, {"revision", std::to_string(memory.revision)},
                     {"sourceActor", memory.source_actor}, {"kind", memory.kind},
                     {"eventTimeMs", std::to_string(memory.event_time_ms)}, {"sourceRef", memory.source_ref},
                     {"participants", memory.participants}, {"userChoice", memory.user_choice}, {"outcome", memory.outcome}};
        if (memory.kind == "impression") {
            row.emplace("targetBotId", memory.target_bot_id); row.emplace("evidence", memory.evidence);
            row.emplace("applicableScenarios", memory.applicable_scenarios);
            row.emplace("supersedesId", std::to_string(memory.supersedes_id));
        }
        memories.emplace_back(std::move(row));
    }
    for (const auto& m : snapshot.mid_memories) mid_memories.emplace_back(O{
        {"id", std::to_string(m.id)}, {"botId", m.bot_id}, {"groupId", m.group_id}, {"text", m.text}, {"sourceActor", m.source_actor},
        {"revision", std::to_string(m.revision)}, {"createdAtMs", std::to_string(m.created_at_ms)},
        {"updatedAtMs", std::to_string(m.updated_at_ms)}, {"expiresAtMs", std::to_string(m.expires_at_ms)}, {"strength", static_cast<double>(m.strength)}});
    O document{{"format", "dimension-conversation-archive"}, {"version", with_contexts ? 3 : 2},
             {"coverage", "conversation-and-group-data"},
             {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins",
                                 "accounts", "provider-settings", "application-settings"}},
             {"bots", std::move(bots)}, {"groups", std::move(groups)},
             {"conversations", std::move(conversations)}, {"memories", std::move(memories)}};
    if (!mid_memories.empty()) document.emplace("midMemories", std::move(mid_memories));
    return document;
}
Json counts(const ArchiveDocument& archive) {
    std::size_t messages{};
    for (const auto& conversation : archive.conversations()) messages += conversation.messages.size();
    O result{{"bots", static_cast<double>(archive.bots().size())},
             {"groups", static_cast<double>(archive.groups().size())},
             {"conversations", static_cast<double>(archive.conversations().size())},
             {"messages", static_cast<double>(messages)}, {"memories", static_cast<double>(archive.memories().size())}};
    if (!archive.mid_memories().empty()) result.emplace("midMemories", static_cast<double>(archive.mid_memories().size()));
    return result;
}
void verify_counts(const Json& supplied, const ArchiveDocument& archive) {
    if (!archive.mid_memories().empty()) fields(supplied, {"bots", "groups", "conversations", "messages", "memories", "midMemories"}, "/counts");
    else fields(supplied, {"bots", "groups", "conversations", "messages", "memories"}, "/counts");
    const auto expected = counts(archive);
    for (const auto& [key, value] : expected.as_object())
        if (!supplied.at(key).is_number() || supplied.at(key).as_number() != value.as_number())
            reject(ArchiveErrorCode::InvalidRecord, "/counts", "Package counts do not match archive records");
}
} // namespace

Json export_archive_package(const Store& store, ArchiveLimits limits) {
    limits = bounded_limits(limits);
    StoreArchiveSnapshotLimits snapshot_limits;
    snapshot_limits.max_bots = limits.max_bots;
    snapshot_limits.max_groups = limits.max_groups;
    snapshot_limits.max_messages = limits.max_messages;
    snapshot_limits.max_memories = limits.max_memories;
    snapshot_limits.max_mid_memories = limits.max_mid_memories;
    snapshot_limits.max_record_bytes = limits.max_bytes;
    const auto snapshot = store.archive_snapshot(snapshot_limits);
    validate_source(snapshot.source_id);
    if (snapshot.revision < 0)
        reject(ArchiveErrorCode::InvalidRecord, "/sourceRevision", "Invalid recorded Store revision");
    const auto archive = parse_archive(snapshot_document(snapshot, limits).dump(), limits);
    const auto canonical = encode_archive(archive);
    if (canonical.size() > limits.max_bytes)
        reject(ArchiveErrorCode::LimitExceeded, "/archive", "Canonical export archive exceeds the byte limit");
    O envelope{{"format", "dimension-conversation-export"}, {"version", 1},
               {"sourceId", snapshot.source_id}, {"sourceRevision", std::to_string(snapshot.revision)},
               {"snapshot", "sqlite-read-transaction"}, {"coverage", "conversation-and-group-data"},
               {"completeApplicationRestore", false}, {"archive", Json::parse(canonical, limits.max_bytes)},
               {"contentSha256", sha256(canonical)}, {"counts", counts(archive)}};
    envelope.emplace("packageSha256", sha256(Json(envelope).dump()));
    Json package(std::move(envelope));
    if (package.dump().size() > max_package_bytes)
        reject(ArchiveErrorCode::LimitExceeded, "/", "Export package exceeds the byte limit");
    return package;
}

ArchivePackage parse_archive_package(std::string_view bytes, ArchiveLimits limits) {
    limits = bounded_limits(limits);
    if (bytes.size() > max_package_bytes)
        reject(ArchiveErrorCode::LimitExceeded, "/", "Export package exceeds the byte limit");
    Json package;
    try { package = Json::parse(bytes, max_package_bytes); }
    catch (...) { reject(ArchiveErrorCode::InvalidJson, "/", "Invalid export package JSON"); }
    fields(package, {"format", "version", "sourceId", "sourceRevision", "snapshot", "coverage",
                     "completeApplicationRestore", "archive", "contentSha256", "packageSha256", "counts"}, "/");
    fixed_string(package.at("format"), "dimension-conversation-export", "/format");
    if (!package.at("version").is_number() || package.at("version").as_number() != 1)
        reject(ArchiveErrorCode::UnsupportedVersion, "/version", "Unsupported export package version");
    const auto source = text(package.at("sourceId"), "/sourceId");
    validate_source(source);
    const auto revision = source_revision(package.at("sourceRevision"));
    fixed_string(package.at("snapshot"), "sqlite-read-transaction", "/snapshot");
    fixed_string(package.at("coverage"), "conversation-and-group-data", "/coverage");
    if (!package.at("completeApplicationRestore").is_bool() || package.at("completeApplicationRestore").as_bool())
        reject(ArchiveErrorCode::InvalidFormat, "/completeApplicationRestore", "Package cannot claim a complete application restore");
    const auto checksum = text(package.at("contentSha256"), "/contentSha256");
    if (!lower_hex(checksum, 64))
        reject(ArchiveErrorCode::InvalidRecord, "/contentSha256", "Invalid package SHA256 encoding");
    const auto package_checksum = text(package.at("packageSha256"), "/packageSha256");
    if (!lower_hex(package_checksum, 64))
        reject(ArchiveErrorCode::InvalidRecord, "/packageSha256", "Invalid package SHA256 encoding");
    auto archive = parse_archive(package.at("archive").dump(), limits);
    if (archive.version() != 2 && archive.version() != 3)
        reject(ArchiveErrorCode::UnsupportedVersion, "/archive/version", "Export packages require a v2 or v3 archive");
    const auto canonical = encode_archive(archive);
    if (canonical.size() > limits.max_bytes)
        reject(ArchiveErrorCode::LimitExceeded, "/archive", "Canonical export archive exceeds the byte limit");
    verify_counts(package.at("counts"), archive);
    if (sha256(canonical) != checksum)
        reject(ArchiveErrorCode::InvalidRecord, "/contentSha256", "Package content checksum does not match");
    auto envelope = package.as_object();
    envelope.erase("packageSha256");
    if (sha256(Json(std::move(envelope)).dump()) != package_checksum)
        reject(ArchiveErrorCode::InvalidRecord, "/packageSha256", "Package envelope checksum does not match");
    return {std::move(archive), source, revision, checksum};
}

} // namespace dimension
