#include "dimension/archive.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <limits>
#include <string>

namespace {
using namespace dimension;
using O = Json::Object;
using A = Json::Array;
std::size_t checks{};
void check(bool value, const char* expression, int line) {
    ++checks;
    if (!value) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)

template<class F> void error(ArchiveErrorCode code, F action) {
    ++checks;
    try { action(); }
    catch (const ArchiveError& caught) {
        CHECK(caught.code() == code);
        CHECK(std::string(caught.what()).find("PRIVATE") == std::string::npos);
        CHECK(!caught.path().empty() && caught.path().front() == '/');
        return;
    }
    throw std::runtime_error("Expected ArchiveError");
}
O bot(std::string id) {
    return {{"id", std::move(id)}, {"name", "PRIVATE_BOT_NAME"}, {"persona", "PRIVATE_PERSONA"},
            {"inChat", true}, {"inWork", false}};
}
O group(std::string id = "Group.1:scope_a-b", std::string revision = "9007199254740993") {
    return {{"id", std::move(id)}, {"name", "PRIVATE_GROUP_中文"}, {"ownerId", "alpha"},
            {"members", A{"alpha", "beta"}}, {"historyMembers", A{"gamma", "beta", "alpha"}},
            {"admins", A{"beta"}}, {"inChat", true}, {"inWork", false}, {"deleted", false},
            {"seal", O{{"shape", "circle"}, {"color", "sage-2"}}}, {"revision", std::move(revision)}};
}
O message(std::string id = "9007199254740993", std::string time = "-9223372036854775808") {
    return {{"id", std::move(id)}, {"actor", "system"}, {"text", "PRIVATE_MESSAGE"},
            {"createdAtMs", std::move(time)}};
}
O conversation(std::string bot_id = "gamma", std::string group_id = "Group.1:scope_a-b", A messages = {message()}) {
    return {{"botId", std::move(bot_id)}, {"groupId", std::move(group_id)}, {"mode", "chat"},
            {"messages", std::move(messages)}};
}
O memory(std::string bot_id = "gamma", std::string group_id = "Group.1:scope_a-b") {
    return {{"id", "9223372036854775807"}, {"botId", std::move(bot_id)}, {"groupId", std::move(group_id)},
            {"text", "PRIVATE_MEMORY"}, {"state", "rejected"}, {"revision", "9223372036854775807"},
            {"sourceActor", "user"}, {"kind", "fact"}, {"eventTimeMs", "0"}, {"sourceRef", ""},
            {"participants", ""}, {"userChoice", ""}, {"outcome", ""}};
}
O document() {
    return {{"format", "dimension-conversation-archive"}, {"version", 2}, {"coverage", "conversation-and-group-data"},
            {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins",
                                "accounts", "provider-settings", "application-settings"}},
            {"bots", A{bot("alpha"), bot("beta"), bot("gamma"), bot("outside")}},
            {"groups", A{group()}}, {"conversations", A{conversation()}}, {"memories", A{memory()}}};
}
O groups_only(O definition = group()) {
    auto root = document(); root["groups"] = A{std::move(definition)};
    root["conversations"] = A{}; root["memories"] = A{};
    return root;
}
ArchiveDocument parse(const O& root, ArchiveLimits limits = {}) { return parse_archive(Json(root).dump(), limits); }
void bad_group(const char* field, Json value, ArchiveErrorCode code = ArchiveErrorCode::InvalidRecord) {
    auto definition = group(); definition[field] = std::move(value);
    const auto root = groups_only(std::move(definition));
    error(code, [&] { (void)parse(root); });
}
bool code_in(const Json& report, const char* list, std::string_view code) {
    const auto& values = report.at(list).as_array();
    return std::any_of(values.begin(), values.end(), [&](const auto& value) { return value.at("code").as_string() == code; });
}
double count(const Json& report, const char* kind, const char* field) {
    return report.at("counts").at(kind).at(field).as_number();
}
bool group_field(const Json& report, std::string_view field) {
    for (const auto& detail : report.at("details").as_array())
        if (detail.at("type").as_string() == "group")
            for (const auto& value : detail.at("fields").as_array())
                if (value.as_string() == field) return true;
    return false;
}

void roundtrip_and_versions() {
    const auto root = document(); const auto bytes = Json(root).dump();
    const auto archive = parse_archive(bytes);
    CHECK(archive.version() == 2); CHECK(archive.size_bytes() == bytes.size());
    CHECK(archive.groups().size() == 1);
    const auto& definition = archive.groups().front();
    CHECK(definition.id == "Group.1:scope_a-b"); CHECK(definition.name == "PRIVATE_GROUP_中文");
    CHECK(definition.owner_id == "alpha"); CHECK(definition.members.front() == "alpha");
    CHECK(definition.history_members.front() == "gamma"); CHECK(definition.admins.front() == "beta");
    CHECK(definition.in_chat && !definition.in_work && !definition.deleted);
    CHECK(definition.seal_shape == "circle" && definition.seal_color == "sage-2");
    CHECK(definition.revision == 9007199254740993LL);
    CHECK(archive.conversations().front().messages.front().created_at_ms == std::numeric_limits<std::int64_t>::min());
    CHECK(archive.conversations().front().messages.front().actor == "system");
    CHECK(archive.memories().front().revision == std::numeric_limits<std::int64_t>::max());
    const auto encoded = encode_archive(archive);
    if (encoded != bytes) {
        std::cerr << "source: " << bytes << "\nencoded: " << encoded << '\n';
    }
    CHECK(encoded == bytes);
    CHECK(encode_archive(parse_archive(encoded)) == bytes);
    const auto copy = archive; CHECK(&copy.groups() == &archive.groups());
    auto maximum = groups_only(group("g", "9223372036854775807"));
    CHECK(parse(maximum).groups().front().revision == std::numeric_limits<std::int64_t>::max());
    auto empty = document(); empty["groups"] = A{};
    empty["conversations"] = A{conversation("alpha", "", {})}; empty["memories"] = A{memory("alpha", "")};
    CHECK(parse(empty).groups().empty());
    auto v1 = root; v1.erase("groups"); v1["version"] = 1; v1["coverage"] = "conversation-data-only";
    auto exclusions = v1.at("excludedTypes").as_array(); exclusions.back() = "group-metadata"; v1["excludedTypes"] = exclusions;
    CHECK(parse(v1).version() == 1 && parse(v1).groups().empty());
    CHECK(encode_archive(parse(v1)) == Json(v1).dump());
    v1["version"] = 2;
    error(ArchiveErrorCode::UnsupportedVersion, [&] { (void)parse(v1); });
    v1["version"] = 1; v1["groups"] = A{};
    error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(v1); });
    auto bad = root; bad.erase("groups");
    error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse(bad); });
    for (const Json version : {Json(4), Json("2"), Json(2.5)}) {
        bad = root; bad["version"] = version;
        error(ArchiveErrorCode::UnsupportedVersion, [&] { (void)parse(bad); });
    }
    bad = root; bad["coverage"] = "complete-application";
    error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse(bad); });
    bad = root; bad["settings"] = O{{"secret", "PRIVATE_SETTING"}};
    error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(bad); });
    bad = root; bad["excludedTypes"] = exclusions;
    error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(bad); });
    auto values = root.at("excludedTypes").as_array(); values.back() = values.front(); bad["excludedTypes"] = values;
    error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(bad); });
    values = root.at("excludedTypes").as_array(); values.pop_back(); bad["excludedTypes"] = values;
    error(ArchiveErrorCode::InvalidFormat, [&] { (void)parse(bad); });
    bad = root; bad["groups"] = O{};
    error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse(bad); });
    auto duplicate_json = bytes;
    duplicate_json.insert(1, "\"version\":2,");
    error(ArchiveErrorCode::InvalidJson, [&] { (void)parse_archive(duplicate_json); });
}

void strict_groups() {
    for (const auto& id : {"", "_group", "-group", "group/name", "group\\name", "group name", "group%20", "群"})
        bad_group("id", id);
    bad_group("id", std::string(129, 'g'));
    CHECK(parse(groups_only(group(std::string(128, 'g')))).groups().front().id.size() == 128);
    CHECK(parse(groups_only(group("9Group.A:_-"))).groups().size() == 1);
    for (const auto* name : {"", " PRIVATE", "PRIVATE ", "\tPRIVATE", "PRIVATE\n"}) bad_group("name", name);
    bad_group("name", std::string(1025, 'n')); bad_group("name", std::string("x\0y", 3));
    auto definition = group(); definition["name"] = std::string(1024, 'n');
    CHECK(parse(groups_only(definition)).groups().front().name.size() == 1024);
    for (const auto* field : {"inChat", "inWork", "deleted"}) bad_group(field, "true");
    for (const auto* revision : {"0", "-1", "01", "+1", "-0", "1e3", "9223372036854775808"}) bad_group("revision", revision);
    bad_group("revision", 1); bad_group("revision", true);
    bad_group("members", A{}); bad_group("members", O{});
    bad_group("members", A{"alpha", "alpha"}, ArchiveErrorCode::InvalidReference);
    bad_group("members", A{"missing"}, ArchiveErrorCode::InvalidReference);
    bad_group("members", A{"Alpha"});
    bad_group("historyMembers", A{"alpha"}, ArchiveErrorCode::InvalidReference);
    bad_group("historyMembers", A{"alpha", "beta", "alpha"}, ArchiveErrorCode::InvalidReference);
    bad_group("historyMembers", A{"alpha", "beta", "missing"}, ArchiveErrorCode::InvalidReference);
    bad_group("admins", A{"beta", "beta"}, ArchiveErrorCode::InvalidReference);
    bad_group("admins", A{"gamma"}, ArchiveErrorCode::InvalidReference);
    bad_group("ownerId", "gamma", ArchiveErrorCode::InvalidReference);
    bad_group("ownerId", "missing", ArchiveErrorCode::InvalidReference);
    bad_group("deleted", true);
    bad_group("seal", "PRIVATE_SEAL");
    bad_group("seal", O{{"shape", "circle"}});
    bad_group("seal", O{{"shape", "circle"}, {"color", "sage"}, {"url", "PRIVATE_URL"}}, ArchiveErrorCode::UnsupportedType);
    for (const auto* token : {"Circle", "#112233", "a_b", "a/b", "中文"})
        bad_group("seal", O{{"shape", token}, {"color", ""}});
    bad_group("seal", O{{"shape", ""}, {"color", std::string(33, 'a')}});
    bad_group("seal", O{{"shape", 1}, {"color", ""}});
    definition = group(); definition["seal"] = O{{"shape", std::string(32, 'a')}, {"color", ""}};
    CHECK(parse(groups_only(definition)).groups().front().seal_shape.size() == 32);
    definition = group(); definition.erase("revision");
    error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse(groups_only(definition)); });
    definition = group(); definition["privateUnknown"] = "PRIVATE_CONTENT";
    error(ArchiveErrorCode::UnsupportedType, [&] { (void)parse(groups_only(definition)); });
    auto root = groups_only(); root["groups"] = A{group(), group()};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
}

void scope_references_and_limits() {
    auto root = document(); root["conversations"] = A{conversation("outside")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = document(); root["memories"] = A{memory("outside")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = document(); root["conversations"] = A{conversation("alpha", "unknown-group", {})};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = document(); root["memories"] = A{memory("alpha", "unknown-group")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root = document(); root["conversations"] = A{conversation("alpha", "invalid group", {})};
    error(ArchiveErrorCode::InvalidRecord, [&] { (void)parse(root); });
    root = document(); root["bots"] = A{bot("alpha"), bot("beta")};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    auto deleted = group(); deleted["deleted"] = true; deleted["inChat"] = false;
    root = document(); root["groups"] = A{deleted};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    root["conversations"] = A{conversation("gamma", "Group.1:scope_a-b", {})};
    CHECK(parse(root).groups().front().deleted);
    CHECK(parse(root).memories().front().bot_id == "gamma");
    CHECK(parse(root).conversations().front().messages.empty());
    root = document(); root["conversations"] = A{conversation("alpha", "", {}), conversation("gamma", "Group.1:scope_a-b", {})};
    CHECK(parse(root).conversations().size() == 2);
    root = document(); root["conversations"] = A{conversation(), conversation()};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    auto second = conversation("alpha", "", {message()});
    root["conversations"] = A{conversation(), second};
    error(ArchiveErrorCode::InvalidReference, [&] { (void)parse(root); });
    auto limits = ArchiveLimits{}; limits.max_groups = 0;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse(document(), limits); });
    root = groups_only(); A groups;
    for (int i = 0; i < 256; ++i) groups.emplace_back(group("g" + std::to_string(i)));
    root["groups"] = groups; CHECK(parse(root).groups().size() == 256);
    groups.emplace_back(group("too-many")); root["groups"] = groups;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse(root); });
    root = groups_only(); A bots, members;
    for (int i = 0; i < 17; ++i) { const auto id = "b" + std::to_string(i); bots.emplace_back(bot(id)); members.emplace_back(id); }
    auto definition = group(); definition["ownerId"] = "b0"; definition["admins"] = A{};
    definition["historyMembers"] = members; members.pop_back(); definition["members"] = members;
    root["bots"] = bots; root["groups"] = A{definition};
    CHECK(parse(root).groups().front().members.size() == 16);
    members.emplace_back("b16"); definition["members"] = members; root["groups"] = A{definition};
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse(root); });
    bots.clear(); A history;
    for (int i = 0; i < 1025; ++i) { const auto id = "b" + std::to_string(i); bots.emplace_back(bot(id)); history.emplace_back(id); }
    definition["members"] = A{"b0"}; definition["historyMembers"] = history;
    root["bots"] = bots; root["groups"] = A{definition}; limits = {}; limits.max_bots = 1025;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse(root, limits); });
    history.pop_back(); definition["historyMembers"] = history; root["groups"] = A{definition};
    CHECK(parse(root, limits).groups().front().history_members.size() == 1024);
    const auto bytes = Json(root).dump(); limits.max_bytes = bytes.size();
    CHECK(parse_archive(bytes, limits).size_bytes() == bytes.size());
    --limits.max_bytes;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)parse_archive(bytes, limits); });
}

void bounded_read_only_preview(const std::filesystem::path& output) {
    Store target(output / "synthetic-groups.sqlite");
    auto root = document(); root["groups"] = A{group("Group.1:scope_a-b", "1")};
    const auto source = parse(root);
    for (const auto& incoming : source.bots()) {
        (void)target.create_bot(incoming.name, incoming.persona, incoming.id);
        (void)target.set_roster(incoming.id, Mode::Chat, incoming.in_chat);
        (void)target.set_roster(incoming.id, Mode::Work, incoming.in_work);
    }
    const auto created = target.create_group(source.groups().front());
    CHECK(created.revision == 1);
    const auto baseline = preflight_archive(source, target);
    CHECK(baseline.at("archiveVersion").as_number() == 2);
    CHECK(baseline.at("advisory").as_bool() && baseline.at("readOnly").as_bool());
    CHECK(!baseline.at("canImport").as_bool() && baseline.at("commitRequiresStaging").as_bool());
    CHECK(!baseline.at("completeApplicationRestore").as_bool());
    CHECK(!baseline.at("applicationSettingsCompared").as_bool() && !baseline.at("applicationSettingsRestored").as_bool());
    CHECK(baseline.at("requiredPolicies").as_array().size() == 3);
    CHECK(count(baseline, "groups", "sameCandidates") == 1);
    CHECK(count(baseline, "groups", "conflicts") == 0);
    CHECK(baseline.at("targetRecordsRead").as_number() == 5);
    CHECK(!code_in(baseline, "blockers", "group-metadata-unsupported"));
    CHECK(code_in(baseline, "blockers", "staging-with-explicit-policies-required"));
    CHECK(baseline.dump().find("PRIVATE") == std::string::npos);
    auto changed = group("Group.1:scope_a-b", "2"); changed["name"] = "PRIVATE_CHANGED";
    changed["ownerId"] = "beta"; changed["admins"] = A{"alpha"}; changed["members"] = A{"beta", "alpha"};
    changed["historyMembers"] = A{"alpha", "beta", "gamma"}; changed["inChat"] = false; changed["inWork"] = true;
    changed["seal"] = O{{"shape", "hexagon"}, {"color", "moss"}};
    auto conflicting = root; conflicting["groups"] = A{changed};
    const auto preview = preflight_archive(parse(conflicting), target);
    CHECK(count(preview, "groups", "conflicts") == 1);
    CHECK(code_in(preview, "blockers", "group-conflicts-require-policy"));
    for (const auto* field : {"name", "ownerId", "admins", "members", "historyMembers", "inChat", "inWork", "seal.shape", "seal.color", "revision"})
        CHECK(group_field(preview, field));
    CHECK(preview.dump().find("PRIVATE") == std::string::npos);
    auto removed = root; auto removed_group = root.at("groups").as_array().front().as_object();
    removed_group["deleted"] = true; removed_group["inChat"] = false;
    removed["groups"] = A{removed_group}; removed["conversations"] = A{};
    CHECK(group_field(preflight_archive(parse(removed), target), "deleted"));
    auto additions = root; additions["groups"] = A{group("Group.1:scope_a-b", "1"), group("new-group")};
    const auto extra = preflight_archive(parse(additions), target);
    CHECK(count(extra, "groups", "sameCandidates") == 1 && count(extra, "groups", "additions") == 1);
    auto limits = ArchiveLimits{}; limits.max_report_items = 1;
    const auto clipped = preflight_archive(parse(conflicting), target, limits);
    CHECK(clipped.at("detailsTruncated").as_bool()); CHECK(clipped.at("details").as_array().size() == 1);
    CHECK(count(clipped, "groups", "conflicts") == 1);
    CHECK(clipped.at("detailCount").as_number() == preview.at("detailCount").as_number());
    limits = {}; limits.max_target_records = 4;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)preflight_archive(source, target, limits); });
    limits = {}; limits.max_target_bytes = static_cast<std::size_t>(baseline.at("targetBytesRead").as_number()) - 1;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)preflight_archive(source, target, limits); });
    limits = {}; limits.max_groups = 0;
    error(ArchiveErrorCode::LimitExceeded, [&] { (void)preflight_archive(source, target, limits); });
    auto empty = root; empty["conversations"] = A{conversation("gamma", "Group.1:scope_a-b", {})};
    const auto empty_group = preflight_archive(parse(empty), target);
    CHECK(!code_in(empty_group, "potentialLosses", "empty-conversation-scopes-not-persistable"));
    CHECK(count(empty_group, "conversationScopes", "existing") == 1);
    empty["conversations"] = A{conversation("alpha", "", {})};
    CHECK(code_in(preflight_archive(parse(empty), target), "potentialLosses", "empty-conversation-scopes-not-persistable"));
    auto v1 = root; v1.erase("groups"); v1["version"] = 1; v1["coverage"] = "conversation-data-only";
    auto exclusions = v1.at("excludedTypes").as_array(); exclusions.back() = "group-metadata"; v1["excludedTypes"] = exclusions;
    CHECK(code_in(preflight_archive(parse(v1), target), "blockers", "group-metadata-unsupported"));
    const auto after = target.find_group(created.id);
    CHECK(after && after->name == created.name && after->revision == created.revision);
    CHECK(after->members == created.members && after->history_members == created.history_members);
    CHECK(!after->deleted && after->in_chat == created.in_chat && after->seal_shape == created.seal_shape);
    CHECK(target.list_groups({}, true).size() == 1);
    CHECK(target.messages("gamma", Mode::Chat, created.id).empty());
    CHECK(target.list_memories("gamma").empty());
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
            ("archive-groups-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(output);
        roundtrip_and_versions(); strict_groups(); scope_references_and_limits(); bounded_read_only_preview(output);
        std::cout << "archive_groups: " << checks << " checks passed (strict v1/v2 codec and bounded group preflight)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
