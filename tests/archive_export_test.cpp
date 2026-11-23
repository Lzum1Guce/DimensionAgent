#include "dimension/archive_export.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <limits>
#include <string>
#include <tuple>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
using O = Json::Object;
using A = Json::Array;
std::size_t checks{};
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)

template<class F> void archive_error(ArchiveErrorCode expected, F action, std::string_view path = {}) {
    ++checks;
    try { action(); }
    catch (const ArchiveError& error) {
        CHECK(error.code() == expected);
        CHECK(std::string(error.what()).find("PRIVATE") == std::string::npos);
        CHECK(!error.path().empty() && error.path().front() == '/');
        if (!path.empty()) CHECK(error.path() == path);
        return;
    }
    throw std::runtime_error("Expected ArchiveError");
}
template<class F> void store_error(StoreErrorCode expected, F action) {
    ++checks;
    try { action(); }
    catch (const StoreError& error) {
        CHECK(error.code() == expected);
        CHECK(std::string(error.what()).find("PRIVATE") == std::string::npos);
        return;
    }
    throw std::runtime_error("Expected StoreError");
}
// Test-only checksum recomputation demonstrates integrity without authenticity.
// This uses the CNG one-shot API rather than the production incremental helper.
O refresh_manifest(O envelope) {
    envelope.erase("packageSha256");
    const auto canonical = Json(envelope).dump();
    std::array<unsigned char, 32> bytes{};
    CHECK(canonical.size() <= std::numeric_limits<ULONG>::max());
    CHECK(BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0,
        reinterpret_cast<PUCHAR>(const_cast<char*>(canonical.data())), static_cast<ULONG>(canonical.size()),
        bytes.data(), static_cast<ULONG>(bytes.size())) >= 0);
    std::string hex;
    for (const auto value : bytes) {
        constexpr char alphabet[] = "0123456789abcdef";
        hex += alphabet[value >> 4U]; hex += alphabet[value & 15U];
    }
    envelope["packageSha256"] = std::move(hex);
    return envelope;
}
bool issue(const StoreImportPlan& plan, std::string_view code) {
    return std::any_of(plan.issues.begin(), plan.issues.end(), [&](const auto& value) { return value.code == code; });
}
StoreImportOptions options(std::string source) {
    StoreImportOptions result{std::move(source), StoreBotConflict::PreserveExisting,
                              StoreMemoryConflict::PreserveExisting};
    result.group_conflict = StoreGroupConflict::PreserveExisting;
    return result;
}
StoreImportResult commit_import(Store& store, const ArchiveDocument& archive, const StoreImportOptions& settings) {
    const auto plan = store.prepare_archive_import(archive, settings);
    CHECK(plan.can_commit);
    return store.commit_archive_import(archive, settings, plan.target_revision, plan.digest);
}
O bot(std::string id, bool visible = true) {
    return {{"id", std::move(id)}, {"name", "PRIVATE_BOT_中文"}, {"persona", "PRIVATE_PERSONA\nsecond line"},
            {"inChat", visible}, {"inWork", visible}};
}
O group(std::string id, bool deleted = false) {
    return {{"id", std::move(id)}, {"name", "PRIVATE_GROUP_群组"}, {"ownerId", "alpha"},
            {"members", A{"alpha", "beta"}}, {"historyMembers", A{"gamma", "beta", "alpha"}},
            {"admins", A{"beta"}}, {"inChat", !deleted}, {"inWork", !deleted}, {"deleted", deleted},
            {"seal", O{{"shape", "circle"}, {"color", "sage-2"}}}, {"revision", "9007199254740993"}};
}
O message(const char* id, const char* text, const char* time, const char* actor = "user") {
    return {{"id", id}, {"text", text}, {"createdAtMs", time}, {"actor", actor}};
}
O conversation(const char* bot_id, const char* group_id, const char* mode, O value) {
    return {{"botId", bot_id}, {"groupId", group_id}, {"mode", mode}, {"messages", A{std::move(value)}}};
}
O memory(const char* id, const char* bot_id, const char* group_id, const char* text,
         const char* state, const char* revision) {
    return {{"id", id}, {"botId", bot_id}, {"groupId", group_id}, {"text", text},
            {"state", state}, {"revision", revision}, {"sourceActor", "user"}};
}
O document() {
    auto empty_group = group("empty-team");
    empty_group["inChat"] = false; empty_group["inWork"] = false;
    auto deleted_group = group("deleted-team", true);
    deleted_group["ownerId"] = "beta"; deleted_group["members"] = A{"beta"};
    deleted_group["historyMembers"] = A{"beta", "gamma"};
    deleted_group["revision"] = "9223372036854775807";
    return {{"format", "dimension-conversation-archive"}, {"version", 2},
        {"coverage", "conversation-and-group-data"},
        {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins",
                            "accounts", "provider-settings", "application-settings"}},
        {"bots", A{bot("alpha"), bot("beta"), bot("gamma", false), bot("idle-bot", false)}},
        {"groups", A{group("team"), empty_group, deleted_group}},
        {"conversations", A{
            conversation("alpha", "", "chat", message("9007199254740993", "PRIVATE_CHAT", "-9223372036854775808")),
            conversation("alpha", "", "work", message("9223372036854775807", "PRIVATE_WORK", "0", "bot")),
            conversation("alpha", "team", "chat", message("10", "PRIVATE_SYSTEM", "100", "system")),
            conversation("gamma", "team", "chat", message("20", "PRIVATE_FORMER_MEMBER", "9223372036854775807")),
            conversation("beta", "team", "work", message("30", "PRIVATE_GROUP_WORK", "-1"))}},
        {"memories", A{
            memory("40", "alpha", "", "PRIVATE_CANDIDATE", "candidate", "1"),
            memory("41", "beta", "team", "PRIVATE_CONFIRMED", "confirmed", "9007199254740993"),
            memory("42", "gamma", "team", "PRIVATE_REJECTED", "rejected", "7"),
            memory("43", "gamma", "deleted-team", "PRIVATE_DELETED_GROUP", "confirmed", "9223372036854775807")}}};
}
void seed(Store& store) {
    const auto result = commit_import(store, parse_archive(Json(document()).dump()), options("fixture-source"));
    CHECK(result.counts.bots_created == 4 && result.counts.groups_created == 3);
    CHECK(result.counts.messages_created == 5 && result.counts.memories_created == 4);
}
const Group& find_group(const ArchiveDocument& archive, std::string_view id) {
    const auto found = std::find_if(archive.groups().begin(), archive.groups().end(),
                                  [&](const auto& value) { return value.id == id; });
    CHECK(found != archive.groups().end());
    return *found;
}
const Message& find_message(const ArchiveDocument& archive, std::string_view text) {
    for (const auto& scope : archive.conversations())
        for (const auto& value : scope.messages) if (value.text == text) return value;
    throw std::runtime_error("Missing synthetic message");
}
const Memory& find_memory(const ArchiveDocument& archive, std::string_view text) {
    const auto found = std::find_if(archive.memories().begin(), archive.memories().end(),
                                  [&](const auto& value) { return value.text == text; });
    CHECK(found != archive.memories().end());
    return *found;
}
void counts(const Json& package, int bots, int groups, int conversations, int messages, int memories) {
    const auto& value = package.at("counts");
    CHECK(value.at("bots").as_number() == bots);
    CHECK(value.at("groups").as_number() == groups);
    CHECK(value.at("conversations").as_number() == conversations);
    CHECK(value.at("messages").as_number() == messages);
    CHECK(value.at("memories").as_number() == memories);
}

Json empty_store(const fs::path& path) {
    std::string bytes;
    {
        Store store(path);
        const auto before = store.archive_snapshot();
        const auto package = export_archive_package(store);
        bytes = package.dump();
        const auto parsed = parse_archive_package(bytes);
        CHECK(parsed.archive.version() == 2 && parsed.source_revision == before.revision);
        CHECK(parsed.source_revision == 0 && parsed.source_id == before.source_id);
        CHECK(parsed.source_id.starts_with("native-") && parsed.source_id.size() == 39);
        CHECK(package.at("snapshot").as_string() == "sqlite-read-transaction");
        CHECK(!package.at("completeApplicationRestore").as_bool());
        counts(package, 0, 0, 0, 0, 0);
        CHECK(parsed.archive.conversations().empty());
        // Independently computed SHA256 of the literal canonical empty v2 JSON.
        CHECK(parsed.sha256 == "439fe9f29079b5ddfa4e5a7076a3f75eaf374b79ced8ad63bf05038bcf51e496");
        CHECK(export_archive_package(store).dump() == bytes);
        CHECK(store.archive_snapshot().revision == before.revision);
        ArchiveLimits zero;
        zero.max_bots = zero.max_groups = zero.max_messages = zero.max_memories = zero.max_conversations = 0;
        CHECK(parse_archive_package(bytes, zero).archive.bots().empty());
        store_error(StoreErrorCode::InvalidArgument, [&] { (void)export_archive_package(store, zero); });
    }
    Store reopened(path);
    CHECK(export_archive_package(reopened).dump() == bytes);
    return Json::parse(bytes);
}

void rich_snapshot(Store& store, const Json& package) {
    const auto before = store.archive_snapshot();
    const auto parsed = parse_archive_package(package.dump());
    const auto& archive = parsed.archive;
    counts(package, 4, 3, 5, 5, 4);
    CHECK(archive.version() == 2 && parsed.source_id == before.source_id && parsed.source_revision == before.revision);
    CHECK(archive.bots().front().id == "alpha" && archive.bots().back().id == "idle-bot");
    CHECK(!archive.bots()[2].in_chat && !archive.bots()[2].in_work);
    CHECK(!archive.bots()[3].in_chat && !archive.bots()[3].in_work);
    CHECK(archive.groups().front().id == "deleted-team" && archive.groups().back().id == "team");
    const auto& team = find_group(archive, "team");
    CHECK(team.name == "PRIVATE_GROUP_群组" && team.owner_id == "alpha");
    CHECK(team.members == (std::vector<std::string>{"alpha", "beta"}));
    CHECK(team.history_members == (std::vector<std::string>{"gamma", "beta", "alpha"}));
    CHECK(team.admins == (std::vector<std::string>{"beta"}));
    CHECK(team.in_chat && team.in_work && !team.deleted);
    CHECK(team.seal_shape == "circle" && team.seal_color == "sage-2");
    CHECK(team.revision == 9007199254740993LL);
    CHECK(!find_group(archive, "empty-team").in_chat && !find_group(archive, "empty-team").deleted);
    const auto& deleted = find_group(archive, "deleted-team");
    CHECK(deleted.deleted && !deleted.in_chat && !deleted.in_work);
    CHECK(deleted.revision == std::numeric_limits<std::int64_t>::max());
    CHECK(find_message(archive, "PRIVATE_CHAT").created_at_ms == std::numeric_limits<std::int64_t>::min());
    CHECK(find_message(archive, "PRIVATE_WORK").created_at_ms == 0);
    CHECK(find_message(archive, "PRIVATE_WORK").actor == "bot");
    CHECK(find_message(archive, "PRIVATE_SYSTEM").actor == "system");
    CHECK(find_message(archive, "PRIVATE_FORMER_MEMBER").created_at_ms == std::numeric_limits<std::int64_t>::max());
    CHECK(find_message(archive, "PRIVATE_GROUP_WORK").created_at_ms == -1);
    CHECK(find_message(archive, "PRIVATE_CHAT").id != 9007199254740993LL); // Native IDs, not the seed source's IDs.
    CHECK(find_memory(archive, "PRIVATE_CANDIDATE").state == MemoryState::Candidate);
    CHECK(find_memory(archive, "PRIVATE_CONFIRMED").state == MemoryState::Confirmed);
    CHECK(find_memory(archive, "PRIVATE_CONFIRMED").revision == 9007199254740993LL);
    CHECK(find_memory(archive, "PRIVATE_REJECTED").state == MemoryState::Rejected);
    CHECK(find_memory(archive, "PRIVATE_DELETED_GROUP").revision == std::numeric_limits<std::int64_t>::max());
    std::tuple<std::string, std::string, Mode> previous;
    for (const auto& scope : archive.conversations()) {
        const auto key = std::make_tuple(scope.bot_id, scope.group_id, scope.mode);
        CHECK(previous < key); previous = key;
        CHECK(!scope.messages.empty());
        CHECK(scope.group_id != "empty-team" && scope.group_id != "deleted-team");
        CHECK(std::is_sorted(scope.messages.begin(), scope.messages.end(),
                             [](const auto& a, const auto& b) { return a.id < b.id; }));
    }
    CHECK(std::is_sorted(archive.memories().begin(), archive.memories().end(),
                         [](const auto& a, const auto& b) { return a.id < b.id; }));
    CHECK(export_archive_package(store).dump() == package.dump());
    CHECK(store.archive_snapshot().revision == before.revision);
}

void strict_envelope(const Json& empty, const Json& rich) {
    const auto valid = empty.as_object();
    auto bad = valid;
    for (const auto& [key, ignored] : valid) {
        (void)ignored; bad = valid; bad.erase(key);
        archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    }
    bad = valid; bad["PRIVATE_UNKNOWN_FIELD"] = "PRIVATE_VALUE";
    archive_error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse_archive_package(Json(bad).dump()); });
    for (const auto* key : {"format", "snapshot", "coverage"}) {
        bad = valid; bad[key] = "PRIVATE_WRONG_VALUE";
        archive_error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse_archive_package(Json(bad).dump()); });
        bad[key] = 1;
        archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    }
    for (const Json value : {Json(0), Json(2), Json(1.5), Json("1"), Json(nullptr)}) {
        bad = valid; bad["version"] = value;
        archive_error(ArchiveErrorCode::UnsupportedVersion, [&] { (void)parse_archive_package(Json(bad).dump()); });
    }
    for (const Json value : {Json(true), Json("false"), Json(0), Json(nullptr)}) {
        bad = valid; bad["completeApplicationRestore"] = value;
        archive_error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse_archive_package(Json(bad).dump()); });
    }
    for (const auto* value : {"", "native-", "foreign-0123456789abcdef0123456789abcdef",
            "native-0123456789ABCDEF0123456789abcdef", "native-0123456789abcdef0123456789abcdeg",
            "native-0123456789abcdef0123456789abcde", "native-0123456789abcdef0123456789abcdef0"}) {
        bad = valid; bad["sourceId"] = value;
        archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    }
    bad = valid; bad["sourceId"] = 0;
    archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    for (const Json value : {Json(""), Json("-1"), Json("-0"), Json("01"), Json("+1"), Json("1.0"),
            Json("1e1"), Json(" 1"), Json("9223372036854775808"), Json(0), Json(nullptr)}) {
        bad = valid; bad["sourceRevision"] = value;
        archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    }
    bad = valid;
    auto changed_source = bad.at("sourceId").as_string();
    changed_source.back() = changed_source.back() == '0' ? '1' : '0';
    bad["sourceId"] = changed_source;
    archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); }, "/packageSha256");
    bad = valid; bad["sourceRevision"] = "1";
    archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); }, "/packageSha256");
    bad["sourceRevision"] = "9223372036854775807";
    bad["sourceId"] = "native-0123456789abcdef0123456789abcdef";
    const auto metadata_only = parse_archive_package(Json(refresh_manifest(bad)).dump());
    CHECK(metadata_only.source_revision == std::numeric_limits<std::int64_t>::max());
    CHECK(metadata_only.sha256 == empty.at("contentSha256").as_string()); // Anyone can recompute an unsigned checksum.
    for (const auto* key : {"contentSha256", "packageSha256"}) {
        for (const Json value : {Json(""), Json(std::string(63, 'a')), Json(std::string(65, 'a')),
                Json(std::string(64, 'A')), Json(std::string(64, 'g')), Json(1), Json(nullptr)}) {
            bad = valid; bad[key] = value;
            archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
        }
        bad = valid; bad[key] = std::string(64, '0');
        archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    }
    auto count_values = valid.at("counts").as_object();
    for (const auto& [key, ignored] : count_values) {
        (void)ignored;
        auto missing = count_values; missing.erase(key); bad = valid; bad["counts"] = missing;
        archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
        for (const Json value : {Json(1), Json(-1), Json(0.5), Json("0"), Json(false)}) {
            auto wrong = count_values; wrong[key] = value; bad = valid; bad["counts"] = wrong;
            archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
        }
    }
    count_values["extra"] = 0; bad = valid; bad["counts"] = count_values;
    archive_error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse_archive_package(Json(bad).dump()); });
    bad = valid; bad["counts"] = A{};
    archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    bad = rich.as_object(); auto changed_archive = bad.at("archive").as_object();
    auto changed_bots = changed_archive.at("bots").as_array(); auto changed_bot = changed_bots.front().as_object();
    changed_bot["persona"] = "PRIVATE_TAMPERED"; changed_bots.front() = changed_bot;
    changed_archive["bots"] = changed_bots; bad["archive"] = changed_archive;
    archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package(Json(bad).dump()); });
    bad = valid; auto v1 = valid.at("archive").as_object();
    v1.erase("groups"); v1["version"] = 1; v1["coverage"] = "conversation-data-only";
    auto excluded = v1.at("excludedTypes").as_array(); excluded.back() = "group-metadata";
    v1["excludedTypes"] = excluded; bad["archive"] = v1;
    archive_error(ArchiveErrorCode::UnsupportedVersion, [&] { (void)parse_archive_package(Json(bad).dump()); });
    archive_error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse_archive_package(empty.at("archive").dump()); });
    archive_error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse_archive_package("[]"); });
    archive_error(ArchiveErrorCode::InvalidJson, [&] { (void)parse_archive_package("{"); });
    auto duplicate = empty.dump(); duplicate.insert(1, "\"version\":1,");
    archive_error(ArchiveErrorCode::InvalidJson, [&] { (void)parse_archive_package(duplicate); });
    auto invalid_unicode = empty.dump(); invalid_unicode.insert(1, "\"bad\":\"\\ud800\",");
    archive_error(ArchiveErrorCode::InvalidJson, [&] { (void)parse_archive_package(invalid_unicode); });
    CHECK(parse_archive_package(" \n\t" + rich.dump() + "\n ").sha256 == rich.at("contentSha256").as_string());
    auto formatted = rich.dump(); const auto start = formatted.find("\"archive\":{");
    CHECK(start != std::string::npos); formatted.insert(start + 11, " \n");
    CHECK(encode_archive(parse_archive_package(formatted).archive) == rich.at("archive").dump());
}

void bounded_export(Store& store, const Json& package, const fs::path& root) {
    const auto before = package.dump();
    for (const auto member : {&ArchiveLimits::max_bots, &ArchiveLimits::max_groups,
                              &ArchiveLimits::max_messages, &ArchiveLimits::max_memories}) {
        ArchiveLimits limits; limits.*member = 1;
        store_error(StoreErrorCode::LimitExceeded, [&] { (void)export_archive_package(store, limits); });
        archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive_package(before, limits); });
    }
    ArchiveLimits limits; limits.max_conversations = 4;
    archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)export_archive_package(store, limits); });
    archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive_package(before, limits); });
    limits = {}; limits.max_bytes = package.at("archive").dump().size();
    CHECK(export_archive_package(store, limits).dump() == before);
    CHECK(parse_archive_package(before, limits).archive.version() == 2);
    --limits.max_bytes;
    archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)export_archive_package(store, limits); });
    archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive_package(before, limits); });
    limits = {}; limits.max_bytes = 1;
    store_error(StoreErrorCode::LimitExceeded, [&] { (void)export_archive_package(store, limits); });
    limits = {}; limits.max_bytes = 0;
    archive_error(ArchiveErrorCode::InvalidFormat, [&] { (void)export_archive_package(store, limits); });
    archive_error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse_archive_package(before, limits); });
    limits.max_bytes = 64U * 1024U * 1024U + 1;
    archive_error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse_archive_package(before, limits); });
    auto oversized = before;
    oversized.append(4U * 1024U * 1024U - 4096U + 1U - oversized.size(), ' ');
    archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive_package(oversized); });
    CHECK(export_archive_package(store).dump() == before);

    Store escaped(root / "escaped.sqlite");
    (void)escaped.create_bot("Escaped", "", "alpha");
    (void)escaped.append_message("alpha", Mode::Chat, "user", std::string(800000, '\x01'));
    const auto escaped_before = escaped.archive_snapshot();
    limits = {}; limits.max_bytes = 64U * 1024U * 1024U;
    archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)export_archive_package(escaped, limits); });
    const auto escaped_after = escaped.archive_snapshot();
    CHECK(escaped_after.revision == escaped_before.revision && escaped_after.messages.size() == 1);
    CHECK(escaped_after.messages.front().text == escaped_before.messages.front().text);

    Store many(root / "many-bots.sqlite");
    const auto native_bot_cap = ArchiveLimits{}.max_bots;
    for (std::size_t i = 0; i <= native_bot_cap; ++i) (void)many.create_bot("Synthetic", "", "bot-" + std::to_string(i));
    limits = {}; limits.max_bots = native_bot_cap + 100;
    store_error(StoreErrorCode::LimitExceeded, [&] { (void)export_archive_package(many, limits); });
    auto too_many = package.as_object(); auto body = too_many.at("archive").as_object();
    A bots; for (std::size_t i = 0; i <= native_bot_cap; ++i) bots.emplace_back(bot("bot-" + std::to_string(i)));
    body["bots"] = bots; body["groups"] = A{}; body["conversations"] = A{}; body["memories"] = A{};
    too_many["archive"] = body;
    archive_error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive_package(Json(too_many).dump(), limits); });

    // A real-sized character library must remain exportable after multi-packet migration.
    Store library(root / "large-library.sqlite");
    for (int i = 0; i < 598; ++i) (void)library.create_bot("Library persona", "Synthetic role", "library-" + std::to_string(i));
    const auto library_package = export_archive_package(library);
    const auto library_archive = parse_archive_package(library_package.dump());
    CHECK(library_archive.archive.bots().size() == 598);
    CHECK(library_archive.archive.memories().empty());
    CHECK(library_archive.archive.conversations().empty());
    Store library_target(root / "large-library-target.sqlite");
    const auto library_options = options(library_archive.source_id);
    const auto library_plan = library_target.prepare_archive_import(library_archive.archive, library_options);
    CHECK(library_plan.can_commit && library_plan.counts.bots_created == 598);
    (void)library_target.commit_archive_import(library_archive.archive, library_options, library_plan.target_revision, library_plan.digest);
    CHECK(library_target.list_bots().size() == 598);
    CHECK(export_archive_package(library_target).at("archive").dump() == library_package.at("archive").dump());
}

void recovery(Store& source, const Json& package, const fs::path& path) {
    const auto parsed = parse_archive_package(package.dump());
    const auto settings = options(parsed.source_id);
    const auto source_before = source.archive_snapshot().revision;
    const auto self = source.prepare_archive_import(parsed.archive, settings);
    CHECK(!self.can_commit && issue(self, "source_is_target"));
    CHECK(self.issue_count == 1 && self.issues.front().kind == "archive");
    store_error(StoreErrorCode::Conflict, [&] {
        (void)source.commit_archive_import(parsed.archive, settings, self.target_revision, self.digest);
    });
    CHECK(source.archive_snapshot().revision == source_before);

    Store target(path);
    const auto result = commit_import(target, parsed.archive, settings);
    CHECK(result.counts.bots_created == 4 && result.counts.groups_created == 3);
    CHECK(result.counts.messages_created == 5 && result.counts.memories_created == 4);
    CHECK(result.revision_after > result.revision_before);
    const auto restored = export_archive_package(target);
    CHECK(restored.at("sourceId").as_string() != parsed.source_id);
    CHECK(restored.at("archive").dump() == package.at("archive").dump());
    CHECK(restored.at("contentSha256").as_string() == parsed.sha256);
    const auto replay = commit_import(target, parsed.archive, settings);
    CHECK(replay.counts.messages_created == 0 && replay.counts.memories_created == 0);
    CHECK(replay.counts.messages_reused == 5 && replay.counts.memories_reused == 4);
    CHECK(replay.revision_after == replay.revision_before);
    CHECK(export_archive_package(target).dump() == restored.dump());

    const auto private_memory = target.list_memories("alpha", std::string_view(""));
    CHECK(private_memory.size() == 1);
    target.remove_group("team"); target.remove_bot("alpha");
    target.delete_memory(private_memory.front().id, private_memory.front().revision);
    const auto cleared = export_archive_package(target).dump();
    const auto tombstones = commit_import(target, parsed.archive, settings);
    CHECK(tombstones.counts.messages_tombstoned == 5 && tombstones.counts.memories_tombstoned == 1);
    CHECK(tombstones.counts.messages_created == 0 && tombstones.counts.memories_created == 0);
    CHECK(tombstones.counts.memories_reused == 3);
    CHECK(tombstones.revision_before == tombstones.revision_after);
    CHECK(export_archive_package(target).dump() == cleared);
    CHECK(target.find_group("team")->deleted && !target.find_bot("alpha")->in_chat);

    const auto source_memory = source.list_memories("alpha", std::string_view("")).front();
    (void)source.edit_memory(source_memory.id, source_memory.revision, "PRIVATE_CHANGED_SOURCE");
    (void)source.append_message("alpha", Mode::Chat, "user", "PRIVATE_NEW_MESSAGE");
    const auto update = parse_archive_package(export_archive_package(source).dump());
    CHECK(update.source_id == parsed.source_id && update.source_revision > parsed.source_revision);
    CHECK(update.sha256 != parsed.sha256);
    const auto& chat = update.archive.conversations().front();
    CHECK(chat.messages.size() == 2 && chat.messages.front().id < chat.messages.back().id);
    CHECK(chat.messages.back().text == "PRIVATE_NEW_MESSAGE");
    const auto conflict = target.prepare_archive_import(update.archive, settings);
    CHECK(!conflict.can_commit && issue(conflict, "source_record_changed"));
    CHECK(conflict.counts.messages_created == 1);
    store_error(StoreErrorCode::Conflict, [&] {
        (void)target.commit_archive_import(update.archive, settings, conflict.target_revision, conflict.digest);
    });
    CHECK(export_archive_package(target).dump() == cleared); // No partial addition from the changed-source package.
}

void unknown_scopes(const fs::path& root) {
    Store messages(root / "unknown-message-scope.sqlite");
    (void)messages.create_bot("PRIVATE_NAME", "", "alpha");
    (void)messages.append_message("alpha", Mode::Chat, "user", "PRIVATE_UNKNOWN_SCOPE", "unknown");
    const auto message_revision = messages.archive_snapshot().revision;
    archive_error(ArchiveErrorCode::InvalidReference, [&] { (void)export_archive_package(messages); });
    CHECK(messages.archive_snapshot().revision == message_revision);
    CHECK(messages.messages("alpha", Mode::Chat, "unknown").size() == 1);
    Store memories(root / "unknown-memory-scope.sqlite");
    (void)memories.create_bot("PRIVATE_NAME", "", "alpha");
    (void)memories.propose_memory("alpha", "unknown", "PRIVATE_UNKNOWN_MEMORY", "user");
    const auto memory_revision = memories.archive_snapshot().revision;
    archive_error(ArchiveErrorCode::InvalidReference, [&] { (void)export_archive_package(memories); });
    CHECK(memories.archive_snapshot().revision == memory_revision);
    CHECK(memories.list_memories("alpha", std::string_view("unknown")).size() == 1);
}
} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto output = fs::path(argv[1]) /
            ("archive-export-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(output);
        const auto empty = empty_store(output / "empty.sqlite");
        Store source(output / "source.sqlite"); seed(source);
        const auto package = export_archive_package(source);
        rich_snapshot(source, package); strict_envelope(empty, package);
        bounded_export(source, package, output); recovery(source, package, output / "recovery.sqlite");
        unknown_scopes(output);
        std::cout << "archive_export: " << checks
                  << " checks passed (native snapshots, strict package integrity, bounded cross-database recovery)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
