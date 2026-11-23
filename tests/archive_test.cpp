#include "dimension/archive.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>

namespace {
using namespace dimension;
using O = Json::Object;
using A = Json::Array;
std::size_t checks = 0;
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)

template<class F> void error(ArchiveErrorCode code, F action) {
    ++checks;
    try { action(); }
    catch (const ArchiveError& caught) {
        if (caught.code() != code) throw std::runtime_error("Unexpected archive error: " + std::string(caught.what()));
        CHECK(std::string(caught.what()).find("PRIVATE") == std::string::npos);
        return;
    }
    throw std::runtime_error("Expected archive error");
}
O bot(std::string id = "alpha") {
    return {{"id", std::move(id)}, {"name", "中文角色"}, {"persona", "PRIVATE_PERSONA"},
            {"inChat", true}, {"inWork", false}};
}
O message(std::string id = "1", std::string text = "PRIVATE_MESSAGE", std::string time = "1700000000000") {
    return {{"id", std::move(id)}, {"actor", "user"}, {"text", std::move(text)}, {"createdAtMs", std::move(time)}};
}
O conversation(A messages = {}, std::string bot_id = "alpha", std::string group = "", std::string mode = "chat") {
    return {{"botId", std::move(bot_id)}, {"groupId", std::move(group)},
            {"mode", std::move(mode)}, {"messages", std::move(messages)}};
}
O memory(std::string id = "1", std::string text = "PRIVATE_MEMORY", std::string group = "") {
    return {{"id", std::move(id)}, {"botId", "alpha"}, {"groupId", std::move(group)},
            {"text", std::move(text)}, {"state", "candidate"}, {"revision", "1"}, {"sourceActor", "user"}};
}
O archive() {
    return {{"format", "dimension-conversation-archive"}, {"version", 1}, {"coverage", "conversation-data-only"},
            {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts",
                                "plugins", "accounts", "provider-settings", "group-metadata"}},
            {"bots", A{bot()}}, {"conversations", A{conversation({message()})}}, {"memories", A{memory()}}};
}
ArchiveDocument parse(const O& value, ArchiveLimits limits = {}) { return parse_archive(Json(value).dump(), limits); }
void bad_bot(const char* field, Json value, ArchiveErrorCode code = ArchiveErrorCode::InvalidRecord) {
    auto root = archive(), record = bot(); record[field] = std::move(value); root["bots"] = A{record};
    error(code, [&] { (void)parse(root); });
}
void bad_message(const char* field, Json value, ArchiveErrorCode code = ArchiveErrorCode::InvalidRecord) {
    auto root = archive(), record = message(); record[field] = std::move(value);
    root["conversations"] = A{conversation({record})};
    error(code, [&] { (void)parse(root); });
}
void bad_memory(const char* field, Json value, ArchiveErrorCode code = ArchiveErrorCode::InvalidRecord) {
    auto root = archive(), record = memory(); record[field] = std::move(value); root["memories"] = A{record};
    error(code, [&] { (void)parse(root); });
}
double count(const Json& report, const char* kind, const char* field) {
    return report.at("counts").at(kind).at(field).as_number();
}
bool code_in(const Json& report, const char* field, std::string_view code) {
    const auto& items = report.at(field).as_array();
    return std::any_of(items.begin(), items.end(), [&](const auto& item) { return item.at("code").as_string() == code; });
}

void strict_format() {
    const auto input = Json(archive()).dump();
    const auto parsed = parse_archive(input);
    CHECK(parsed.size_bytes() == input.size());
    CHECK(parsed.bots().front().name == "中文角色");
    CHECK(parsed.bots().front().in_chat && !parsed.bots().front().in_work);
    CHECK(parsed.memories().front().state == MemoryState::Candidate);
    CHECK(encode_archive(parse_archive(encode_archive(parsed))) == encode_archive(parsed));
    CHECK(parsed.conversations().front().messages.front().text == "PRIVATE_MESSAGE");
    auto root = archive();
    auto reviewed = memory(); reviewed["state"] = "rejected"; reviewed["revision"] = "7";
    root["memories"] = A{reviewed};
    const auto rejected = parse(root);
    CHECK(rejected.memories().front().state == MemoryState::Rejected);
    CHECK(parse_archive(encode_archive(rejected)).memories().front().revision == 7);
    root = archive(); root["coverage"] = "complete-backup";
    error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse(root); });
    root = archive();
    root["version"] = 2; error(ArchiveErrorCode::UnsupportedVersion, [&] { (void)parse(root); });
    root = archive(); root["format"] = "unknown"; error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse(root); });
    root = archive(); root["workRuns"] = A{}; error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(root); });
    root = archive(); root.erase("memories"); error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse(root); });
    root = archive(); root["excludedTypes"] = A{}; error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse(root); });
    root = archive();
    auto excluded = root.at("excludedTypes").as_array(); excluded.back() = "unknown-critical-record";
    root["excludedTypes"] = excluded; error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(root); });
    root = archive(); excluded = root.at("excludedTypes").as_array(); excluded.back() = excluded.front();
    root["excludedTypes"] = excluded; error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(root); });
    error(ArchiveErrorCode::InvalidJson, [] { (void)parse_archive(R"({"format":"PRIVATE","format":"PRIVATE"})"); });
    error(ArchiveErrorCode::InvalidJson, [] { (void)parse_archive("{PRIVATE_SECRET"); });
    error(ArchiveErrorCode::InvalidRecord, [] { (void)parse_archive("[]"); });
    auto invalid_utf8 = input; invalid_utf8[input.find("PRIVATE_PERSONA")] = char(-1);
    error(ArchiveErrorCode::InvalidJson, [&] { (void)parse_archive(invalid_utf8); });
    auto limits = ArchiveLimits{}; limits.max_bytes = input.size();
    CHECK(parse_archive(input, limits).size_bytes() == input.size());
    --limits.max_bytes; error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive(input, limits); });
    limits = {}; limits.max_bots = 0; error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive(input, limits); });
    limits = {}; limits.max_conversations = 0; error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive(input, limits); });
    limits = {}; limits.max_messages = 0; error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive(input, limits); });
    limits = {}; limits.max_memories = 0; error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive(input, limits); });
    limits = {}; limits.max_bytes = 0; error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse_archive(input, limits); });
}

void records_and_references() {
    bad_bot("id", "Upper"); bad_bot("id", "a_b"); bad_bot("name", " ");
    bad_bot("name", " trailing "); bad_bot("inChat", "true");
    bad_bot("persona", std::string("a\0b", 3));
    bad_bot("private_unknown", "PRIVATE_SECRET", ArchiveErrorCode::UnsupportedType);
    bad_message("id", 1); bad_message("id", "01"); bad_message("id", "0");
    bad_message("id", "9223372036854775808"); bad_message("createdAtMs", "-0");
    bad_message("createdAtMs", "1e3"); bad_message("text", ""); bad_message("text", std::string("a\0b", 3));
    bad_message("actor", "model", ArchiveErrorCode::UnsupportedType);
    bad_memory("sourceActor", "bot"); bad_memory("text", " PRIVATE_MEMORY ");
    bad_memory("revision", "0"); bad_memory("state", "unknown", ArchiveErrorCode::UnsupportedType);
    auto root = archive();
    root["bots"] = A{bot(), bot()}; error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = archive(); root["conversations"] = A{conversation({}, "missing")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = archive(); root["conversations"] = A{conversation(), conversation()};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = archive(); root["conversations"] = A{conversation({message()}), conversation({message()}, "alpha", "", "work")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = archive(); root["conversations"] = A{conversation({}, "alpha", "", "game")};
    error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(root); });
    root = archive(); root["memories"] = A{memory(), memory("2")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = archive(); root["memories"] = A{memory(), memory("1", "different")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    bad_memory("botId", "missing", ArchiveErrorCode::InvalidReference);
    root = archive(); root["conversations"] = A{conversation({message()}),
        conversation({message("2")}, "alpha", "scope", "work")};
    auto limits = ArchiveLimits{}; limits.max_messages = 1;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse(root, limits); });
    root = archive();
    root["conversations"] = A{conversation({message("9223372036854775807", "exact", "-9223372036854775808")})};
    auto record = memory(); record["revision"] = "9223372036854775807"; root["memories"] = A{record};
    const auto document = parse(root);
    CHECK(document.conversations().front().messages.front().id == std::numeric_limits<std::int64_t>::max());
    CHECK(document.conversations().front().messages.front().created_at_ms == std::numeric_limits<std::int64_t>::min());
    CHECK(document.memories().front().revision == std::numeric_limits<std::int64_t>::max());
    CHECK(encode_archive(parse_archive(encode_archive(document))) == encode_archive(document));
}

void store_text_limits() {
    auto root = archive(), record = bot();
    record["name"] = std::string(1024, 'n'); record["persona"] = std::string(262144, 'p');
    root["bots"] = A{record};
    root["conversations"] = A{conversation({message("1", std::string(1048576, 't'))}, "alpha", std::string(1024, 'g'))};
    root["memories"] = A{memory("1", std::string(262144, 'm'))};
    CHECK(parse(root).conversations().front().messages.front().text.size() == 1048576);
    bad_bot("name", std::string(1025, 'x')); bad_bot("persona", std::string(262145, 'x'));
    bad_message("text", std::string(1048577, 'x')); bad_memory("text", std::string(262145, 'x'));
    bad_memory("groupId", std::string(1025, 'g'));
    root = archive(); root["conversations"] = A{conversation({}, "alpha", std::string(1025, 'g'))};
    error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse(root); });
}

void preview_is_read_only(const std::filesystem::path& root) {
    Store target(root / "synthetic-target.sqlite");
    (void)target.create_bot("Existing", "TARGET_PRIVATE_PERSONA", "alpha");
    (void)target.set_roster("alpha", Mode::Chat, true);
    const auto existing_message = target.append_message("alpha", Mode::Chat, "user", "PRIVATE_EXISTING_MESSAGE");
    const auto existing_memory = target.propose_memory("alpha", "", "PRIVATE_EXISTING_MEMORY", "user");
    auto source = archive(), changed_bot = bot();
    changed_bot["inChat"] = false; changed_bot["inWork"] = true;
    source["bots"] = A{changed_bot, bot("beta")};
    source["conversations"] = A{conversation({message("900", existing_message.text, std::to_string(existing_message.created_at_ms)),
        message("901", "PRIVATE_NEW_MESSAGE", std::to_string(existing_message.created_at_ms + 1))}),
        conversation({}, "beta", "", "work")};
    auto changed_memory = memory("700", existing_memory.text); changed_memory["state"] = "confirmed"; changed_memory["revision"] = "2";
    source["memories"] = A{changed_memory, memory("701", "PRIVATE_NEW_MEMORY"), memory("702", "PRIVATE_GROUP_MEMORY", "group-a")};
    const auto document = parse(source);
    const auto result = preflight_archive(document, target);
    CHECK(result.at("archiveValid").as_bool()); CHECK(result.at("readOnly").as_bool());
    CHECK(!result.at("canImport").as_bool()); CHECK(result.at("importImplemented").as_bool());
    CHECK(result.at("advisory").as_bool()); CHECK(result.at("requiresCommitRecheck").as_bool());
    CHECK(result.at("requiresExplicitConflictPolicy").as_bool());
    CHECK(result.at("targetSnapshot").as_string() == "non-atomic-public-reads");
    CHECK(result.at("defaultMemoryPolicy").as_string() == "preserve-existing");
    CHECK(count(result, "bots", "additions") == 1); CHECK(count(result, "bots", "conflicts") == 1);
    CHECK(count(result, "messages", "additions") == 1); CHECK(count(result, "messages", "sameCandidates") == 1);
    CHECK(count(result, "memories", "additions") == 2); CHECK(count(result, "memories", "conflicts") == 1);
    CHECK(code_in(result, "blockers", "staging-with-explicit-policies-required"));
    CHECK(code_in(result, "blockers", "group-metadata-unsupported"));
    CHECK(result.at("commitRequiresStaging").as_bool());
    CHECK(code_in(result, "potentialLosses", "empty-conversation-scopes-not-persistable"));
    CHECK(result.dump().find("PRIVATE") == std::string::npos);
    CHECK(result.dump().find("中文角色") == std::string::npos);
    const auto& first = result.at("details").as_array().front();
    CHECK(first.at("action").as_string() == "conflict"); CHECK(first.at("fields").as_array().size() == 4);
    CHECK(target.list_bots().size() == 1);
    CHECK(target.find_bot("alpha")->persona == "TARGET_PRIVATE_PERSONA");
    CHECK(target.messages("alpha", Mode::Chat).size() == 1);
    CHECK(target.find_memory(existing_memory.id)->state == MemoryState::Candidate);
    CHECK(target.find_memory(existing_memory.id)->revision == 1);
    auto limits = ArchiveLimits{}; limits.max_report_items = 1;
    const auto compact = preflight_archive(document, target, limits);
    CHECK(compact.at("detailsTruncated").as_bool()); CHECK(compact.at("details").as_array().size() == 1);
    CHECK(compact.at("counts").dump() == result.at("counts").dump());
    CHECK(compact.at("detailCount").as_number() == result.at("detailCount").as_number());
    limits = {}; limits.max_target_records = 1;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)preflight_archive(document, target, limits); });
    limits = {}; limits.max_target_bytes = 1;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)preflight_archive(document, target, limits); });
    limits = {}; limits.max_bytes = document.size_bytes() - 1;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)preflight_archive(document, target, limits); });

    // Clearing a conversation is a Store operation and must not delete memories.
    target.remove_bot("alpha");
    CHECK(target.messages("alpha", Mode::Chat).empty());
    CHECK(target.find_memory(existing_memory.id).has_value());
    const auto after_delete = preflight_archive(document, target);
    CHECK(count(after_delete, "messages", "additions") == 2);
    CHECK(count(after_delete, "memories", "conflicts") == 1);
    CHECK(target.messages("alpha", Mode::Chat).empty()); // Preview never resurrects history.
    std::ofstream report(root / "synthetic-preflight.json", std::ios::binary);
    report << result.dump();
    CHECK(static_cast<bool>(report));
}

void target_paging_and_candidate_multiplicity(const std::filesystem::path& root) {
    Store target(root / "synthetic-paging.sqlite");
    const auto current_bot = target.create_bot("中文角色", "PRIVATE_PERSONA", "alpha");
    (void)current_bot; (void)target.set_roster("alpha", Mode::Chat, true);
    Message oldest;
    for (int i = 0; i < 25; ++i) {
        auto row = target.append_message("alpha", Mode::Work, "user", "page " + std::to_string(i));
        if (i == 0) oldest = row;
    }
    for (int i = 0; i < 18; ++i)
        (void)target.propose_memory("alpha", "", "memory " + std::to_string(i), "user");
    auto source = archive();
    source["conversations"] = A{conversation({
        message("100", oldest.text, std::to_string(oldest.created_at_ms)),
        message("101", oldest.text, std::to_string(oldest.created_at_ms))}, "alpha", "", "work")};
    source["memories"] = A{memory("88", "memory 0")};
    const auto result = preflight_archive(parse(source), target);
    CHECK(count(result, "bots", "sameCandidates") == 1);
    CHECK(count(result, "messages", "sameCandidates") == 1);
    CHECK(count(result, "messages", "additions") == 1);
    CHECK(count(result, "memories", "sameCandidates") == 1);
    CHECK(result.at("targetRecordsRead").as_number() == 44);
    CHECK(!code_in(result, "blockers", "group-metadata-unsupported"));
    auto limits = ArchiveLimits{}; limits.max_target_records = 10;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)preflight_archive(parse(source), target, limits); });
}
} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto output = std::filesystem::path(argv[1]) /
            ("archive-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(output);
        strict_format(); records_and_references(); store_text_limits();
        preview_is_read_only(output); target_paging_and_candidate_multiplicity(output);
        std::cout << "archive: " << checks << " checks passed (strict format, bounded read-only preview; no import)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
