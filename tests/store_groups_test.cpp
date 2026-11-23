#include "dimension/archive.hpp"
#include "dimension/store.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <limits>

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
template<class F> void rejected(StoreErrorCode expected, F action) {
    ++checks;
    try { action(); }
    catch (const StoreError& error) {
        if (error.code() == expected) return;
        throw std::runtime_error("Unexpected Store error: " + std::string(error.what()));
    }
    throw std::runtime_error("Expected Store error");
}
bool has(const std::vector<std::string>& values, std::string_view value) {
    return std::find(values.begin(), values.end(), value) != values.end();
}
bool issue(const StoreImportPlan& plan, std::string_view code) {
    return std::any_of(plan.issues.begin(), plan.issues.end(), [&](const auto& item) { return item.code == code; });
}

// Only synthetic fixtures: inspect the schema and inject actual SQL failures.
struct SqliteFixture {
    struct sqlite3;
    using Callback = int(__cdecl*)(void*, int, char**, char**);
    HMODULE module{};
    sqlite3* db{};
    int(__cdecl* open)(const char*, sqlite3**, int, const char*){};
    int(__cdecl* close)(sqlite3*){};
    int(__cdecl* execute)(sqlite3*, const char*, Callback, void*, char**){};
    explicit SqliteFixture(const fs::path& file) {
        try {
            std::array<wchar_t, 32768> system{};
            const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
            if (!length || length >= system.size()) throw std::runtime_error("Missing system directory");
            module = LoadLibraryW((std::wstring(system.data(), length) + L"\\winsqlite3.dll").c_str());
            if (!module) throw std::runtime_error("Missing system SQLite");
            open = reinterpret_cast<decltype(open)>(GetProcAddress(module, "sqlite3_open_v2"));
            close = reinterpret_cast<decltype(close)>(GetProcAddress(module, "sqlite3_close_v2"));
            execute = reinterpret_cast<decltype(execute)>(GetProcAddress(module, "sqlite3_exec"));
            if (!open || !close || !execute) throw std::runtime_error("Missing SQLite ABI");
            const auto bytes = file.u8string();
            const std::string filename(reinterpret_cast<const char*>(bytes.data()), bytes.size());
            if (open(filename.c_str(), &db, 2 | 4 | 0x10000, nullptr) != 0)
                throw std::runtime_error("Cannot open synthetic fixture");
            sql("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        } catch (...) { release(); throw; }
    }
    ~SqliteFixture() { release(); }
    void release() { if (db && close) close(db); db = nullptr; if (module) FreeLibrary(module); module = nullptr; }
    void sql(const std::string& value) {
        if (execute(db, value.c_str(), nullptr, nullptr, nullptr) != 0)
            throw std::runtime_error("Synthetic SQLite write failed");
    }
    std::string scalar(const std::string& value) {
        std::vector<std::string> values;
        const auto callback = [](void* pointer, int count, char** columns, char**) -> int {
            auto& output = *static_cast<std::vector<std::string>*>(pointer);
            for (int i = 0; i < count; ++i) output.emplace_back(columns[i] ? columns[i] : "<null>");
            return 0;
        };
        if (execute(db, value.c_str(), callback, &values, nullptr) != 0 || values.size() != 1)
            throw std::runtime_error("Synthetic SQLite scalar failed");
        return values.front();
    }
};

void bots(Store& store) {
    for (const auto* id : {"alpha", "beta", "gamma", "delta"})
        (void)store.create_bot(std::string("Native ") + id, std::string("Persona ") + id, id);
}
Group group(std::string id = "team:1") {
    Group result;
    result.id = std::move(id); result.name = "Team"; result.owner_id = "alpha";
    result.members = {"alpha", "beta"}; result.history_members = {"alpha", "beta", "gamma"};
    result.admins = {"beta"}; result.in_chat = result.in_work = true;
    result.seal_shape = "circle"; result.seal_color = "violet";
    return result;
}
O group_json(const Group& value) {
    auto strings = [](const std::vector<std::string>& values) {
        A result; for (const auto& text : values) result.emplace_back(text); return result;
    };
    return {{"id", value.id}, {"name", value.name}, {"ownerId", value.owner_id},
        {"members", strings(value.members)}, {"historyMembers", strings(value.history_members)},
        {"admins", strings(value.admins)}, {"inChat", value.in_chat}, {"inWork", value.in_work},
        {"deleted", value.deleted}, {"seal", O{{"shape", value.seal_shape}, {"color", value.seal_color}}},
        {"revision", std::to_string(value.revision)}};
}
O message(std::string id, std::string text, std::string time) {
    return {{"id", std::move(id)}, {"actor", "user"}, {"text", std::move(text)}, {"createdAtMs", std::move(time)}};
}
O scope(std::string bot_id, std::string mode, A messages, std::string group_id = "team:1") {
    return {{"botId", std::move(bot_id)}, {"groupId", std::move(group_id)}, {"mode", std::move(mode)},
            {"messages", std::move(messages)}};
}
O document() {
    A source_bots;
    for (const auto* id : {"alpha", "beta", "gamma"})
        source_bots.emplace_back(O{{"id", id}, {"name", std::string("Source ") + id},
            {"persona", std::string("Source persona ") + id}, {"inChat", true}, {"inWork", true}});
    auto source_group = group(); source_group.revision = 9007199254740993LL;
    return {{"format", "dimension-conversation-archive"}, {"version", 2},
        {"coverage", "conversation-and-group-data"},
        {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins",
                            "accounts", "provider-settings", "application-settings"}},
        {"bots", source_bots}, {"groups", A{group_json(source_group)}},
        {"conversations", A{
            scope("alpha", "chat", A{message("10", "alpha chat", "-9223372036854775808")}),
            scope("beta", "chat", A{message("20", "beta chat", "9007199254740993")}),
            scope("gamma", "work", A{message("30", "historical member work", "9223372036854775807")}),
            scope("gamma", "chat", A{})}},
        {"memories", A{
            O{{"id", "70"}, {"botId", "beta"}, {"groupId", "team:1"}, {"text", "same-text"},
              {"state", "confirmed"}, {"revision", "9"}, {"sourceActor", "user"}},
            O{{"id", "71"}, {"botId", "beta"}, {"groupId", ""}, {"text", "same-text"},
              {"state", "rejected"}, {"revision", "2"}, {"sourceActor", "user"}}}}};
}
ArchiveDocument parse(const O& value) { return parse_archive(Json(value).dump()); }
StoreImportOptions options(std::string source = "group-source") {
    StoreImportOptions value{std::move(source), StoreBotConflict::PreserveExisting,
                             StoreMemoryConflict::PreserveExisting};
    value.group_conflict = StoreGroupConflict::PreserveExisting;
    return value;
}
StoreImportResult commit(Store& store, const ArchiveDocument& archive, const StoreImportOptions& settings) {
    const auto plan = store.prepare_archive_import(archive, settings); CHECK(plan.can_commit);
    return store.commit_archive_import(archive, settings, plan.target_revision, plan.digest);
}

void group_lifecycle(const fs::path& path) {
    {
        Store store(path); bots(store);
        for (const auto& id : {"", ".start", "bad space", "slash/path"}) {
            auto invalid = group(id);
            rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        }
        auto invalid = group(); invalid.members.push_back("alpha");
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        invalid = group(); invalid.owner_id = "gamma";
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        invalid = group(); invalid.admins = {"gamma"};
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        invalid = group(); invalid.history_members.push_back("unknown");
        rejected(StoreErrorCode::NotFound, [&] { (void)store.create_group(invalid); });
        invalid = group(); invalid.seal_color = "#fff";
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        invalid = group(); invalid.deleted = true;
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        invalid = group(); invalid.name = "  \n  ";
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        invalid = group(); invalid.history_members.clear();
        for (int i = 0; i < 1025; ++i) invalid.history_members.push_back("old-" + std::to_string(i));
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.create_group(invalid); });
        CHECK(store.list_groups().empty());
        auto value = group(); value.name = "  Native Team  "; value.history_members = {"gamma", "gamma"};
        auto saved = store.create_group(value);
        CHECK(saved.name == "Native Team"); CHECK(saved.history_members.size() == 3);
        CHECK(has(saved.history_members, "alpha") && has(saved.history_members, "beta"));
        CHECK(store.list_groups(Mode::Chat).size() == 1 && store.list_groups(Mode::Work).size() == 1);
        rejected(StoreErrorCode::Conflict, [&] { (void)store.create_group(saved); });
        const auto first = store.append_message("alpha", Mode::Chat, "user", "first", saved.id);
        const auto receipt = store.append_message_once("beta", Mode::Chat, "user", "second", saved.id, "group-key");
        const auto third = store.append_message("alpha", Mode::Chat, "bot", "third", saved.id);
        (void)store.append_message("beta", Mode::Work, "user", "work", saved.id);
        (void)store.append_message("alpha", Mode::Chat, "user", "private");
        auto memory = store.propose_memory("beta", saved.id, "historical memory", "user");
        memory = store.review_memory(memory.id, memory.revision, MemoryState::Confirmed);
        const auto page = store.group_messages(saved.id, Mode::Chat, 2);
        CHECK(page.size() == 2 && page[0].id == third.id && page[1].id == receipt.id);
        (void)store.append_message("alpha", Mode::Chat, "user", "newer", saved.id);
        const auto older = store.group_messages(saved.id, Mode::Chat, 2, page.back().id);
        CHECK(older.size() == 1 && older.front().id == first.id);
        rejected(StoreErrorCode::Conflict, [&] { (void)store.append_message("gamma", Mode::Chat, "user", "not current", saved.id); });
        auto replacement = saved; replacement.members = {"alpha", "gamma"}; replacement.admins = {"gamma"};
        replacement.history_members = {"gamma"}; replacement.name = "Replacement";
        saved = store.replace_group(replacement, saved.revision);
        CHECK(saved.revision == 2 && has(saved.history_members, "beta"));
        CHECK(saved.admins == std::vector<std::string>{"gamma"});
        rejected(StoreErrorCode::Conflict, [&] { (void)store.replace_group(replacement, 1); });
        rejected(StoreErrorCode::Conflict, [&] { (void)store.append_message("beta", Mode::Chat, "user", "departed", saved.id); });
        CHECK(store.append_message_once("beta", Mode::Chat, "user", "second", saved.id, "group-key").id == receipt.id);
        saved = store.set_group_roster(saved.id, Mode::Chat, false);
        CHECK(!saved.in_chat && saved.in_work); CHECK(store.group_messages(saved.id, Mode::Chat).size() == 4);
        rejected(StoreErrorCode::Conflict, [&] { (void)store.append_message("alpha", Mode::Chat, "user", "disabled", saved.id); });
        (void)store.append_message("gamma", Mode::Work, "user", "current work", saved.id);
        CHECK(store.list_groups(Mode::Chat).empty() && store.list_groups(Mode::Work).size() == 1);
        CHECK(store.list_memories("beta", std::string_view(saved.id)).front().id == memory.id);
        (void)store.propose_memory("beta", saved.id, "former member memory", "user");
        auto profile = store.update_bot_profile("alpha", std::string("  Renamed  "));
        CHECK(profile.name == "Renamed" && profile.persona == "Persona alpha");
        profile = store.update_bot_profile("alpha", {}, std::string{});
        CHECK(profile.name == "Renamed" && profile.persona.empty() && !profile.in_chat && !profile.in_work);
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.update_bot_profile("alpha", std::string(" ")); });
        rejected(StoreErrorCode::NotFound, [&] { (void)store.update_bot_profile("missing", {}, std::string("x")); });
        SqliteFixture sql(path);
        const auto before = sql.scalar("SELECT revision FROM store_revision");
        sql.sql("CREATE TRIGGER fail_group_clear BEFORE DELETE ON messages WHEN OLD.group_id='team:1' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
        rejected(StoreErrorCode::Conflict, [&] { store.remove_group(saved.id); });
        CHECK(!store.find_group(saved.id)->deleted && store.group_messages(saved.id, Mode::Chat).size() == 4);
        CHECK(sql.scalar("SELECT revision FROM store_revision") == before);
        sql.sql("DROP TRIGGER fail_group_clear");
        store.remove_group(saved.id);
        CHECK(store.find_group(saved.id)->deleted && !store.find_group(saved.id)->in_work);
        CHECK(store.group_messages(saved.id, Mode::Chat).empty() && store.group_messages(saved.id, Mode::Work).empty());
        CHECK(store.messages("alpha", Mode::Chat).size() == 1);
        CHECK(store.list_memories("beta", std::string_view(saved.id)).size() == 2);
        CHECK(store.list_groups().empty() && store.list_groups({}, true).size() == 1);
        rejected(StoreErrorCode::Conflict, [&] { (void)store.set_group_roster(saved.id, Mode::Chat, true); });
        rejected(StoreErrorCode::Conflict, [&] { (void)store.replace_group(saved, store.find_group(saved.id)->revision); });
        rejected(StoreErrorCode::Conflict, [&] { (void)store.append_message_once("beta", Mode::Chat, "user", "second", saved.id, "group-key"); });
        CHECK(sql.scalar("SELECT count(*) FROM message_receipts WHERE message_id IS NULL") == "1");
    }
    Store reopened(path);
    CHECK(reopened.find_group("team:1")->deleted && has(reopened.find_group("team:1")->history_members, "beta"));
    CHECK(reopened.find_bot("alpha")->name == "Renamed" && reopened.find_bot("alpha")->persona.empty());
    auto maximum = group("maximum"); maximum.revision = std::numeric_limits<std::int64_t>::max();
    maximum = reopened.create_group(maximum);
    CHECK(reopened.replace_group(maximum, maximum.revision).revision == maximum.revision);
    maximum.name = "changed";
    rejected(StoreErrorCode::Conflict, [&] { (void)reopened.replace_group(maximum, maximum.revision); });
    rejected(StoreErrorCode::Conflict, [&] { (void)reopened.set_group_roster("maximum", Mode::Work, false); });
    rejected(StoreErrorCode::Conflict, [&] { reopened.remove_group("maximum"); });
}

void bootstrap(const fs::path& path) {
    {
        Store store(path); bots(store);
        (void)store.append_message("gamma", Mode::Chat, "user", "legacy", "legacy");
        (void)store.propose_memory("delta", "legacy", "legacy memory", "user");
        auto legacy = group("legacy"); legacy.history_members = {"alpha", "beta"};
        CHECK(!store.application_metadata_bootstrapped());
        const std::vector<BotProfileOverride> profiles{{"alpha", std::string("Imported name"), {}},
            {"beta", {}, std::string("Imported persona")}};
        auto orphan = profiles; orphan.push_back({"missing", std::string("orphan"), {}});
        rejected(StoreErrorCode::NotFound, [&] { store.bootstrap_application_metadata({legacy}, orphan); });
        CHECK(!store.application_metadata_bootstrapped() && !store.find_group("legacy"));
        CHECK(store.find_bot("alpha")->name == "Native alpha");
        SqliteFixture sql(path); const auto before = sql.scalar("SELECT revision FROM store_revision");
        sql.sql("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON application_metadata_bootstrap BEGIN SELECT RAISE(ABORT,'fixture'); END;");
        rejected(StoreErrorCode::Conflict, [&] { store.bootstrap_application_metadata({legacy}, profiles); });
        CHECK(!store.application_metadata_bootstrapped() && !store.find_group("legacy"));
        CHECK(store.find_bot("beta")->persona == "Persona beta");
        CHECK(sql.scalar("SELECT revision FROM store_revision") == before);
        sql.sql("DROP TRIGGER fail_bootstrap");
        store.bootstrap_application_metadata({legacy}, profiles);
        CHECK(store.application_metadata_bootstrapped());
        const auto saved = *store.find_group("legacy");
        CHECK(saved.history_members.size() == 4 && has(saved.history_members, "gamma") && has(saved.history_members, "delta"));
        CHECK(store.group_messages("legacy", Mode::Chat).size() == 1);
        CHECK(store.find_bot("alpha")->name == "Imported name" && store.find_bot("alpha")->persona == "Persona alpha");
        CHECK(store.find_bot("beta")->persona == "Imported persona");
        (void)store.update_bot_profile("alpha", std::string("Later local name"));
    }
    Store reopened(path); CHECK(reopened.application_metadata_bootstrapped());
    reopened.bootstrap_application_metadata({Group{}}, {{"missing", std::string("ignored stale JSON"), {}}});
    CHECK(reopened.find_bot("alpha")->name == "Later local name");
    CHECK(reopened.list_groups().size() == 1);
}

void import_groups(const fs::path& path) {
    Store store(path); const auto archive = parse(document()); auto settings = options();
    auto omitted = settings; omitted.group_conflict.reset();
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.prepare_archive_import(archive, omitted); });
    const auto plan = store.prepare_archive_import(archive, settings);
    CHECK(plan.can_commit && plan.archive_version == 2 && plan.counts.groups_created == 1);
    CHECK(store.list_bots().empty() && store.list_groups().empty());
    const auto result = store.commit_archive_import(archive, settings, plan.target_revision, plan.digest);
    CHECK(result.archive_version == 2 && result.counts.groups_created == 1 && result.counts.messages_created == 3);
    CHECK(store.find_group("team:1")->revision == 9007199254740993LL);
    CHECK(store.find_group("team:1")->admins == std::vector<std::string>{"beta"});
    const auto messages = store.group_messages("team:1", Mode::Chat);
    CHECK(messages.size() == 2 && messages.front().bot_id == "beta");
    CHECK(messages.front().created_at_ms == 9007199254740993LL);
    CHECK(messages.back().created_at_ms == std::numeric_limits<std::int64_t>::min());
    CHECK(store.group_messages("team:1", Mode::Work).front().bot_id == "gamma");
    const auto memories = store.list_memories("beta"); CHECK(memories.size() == 2);
    CHECK(store.list_memories("beta", std::string_view("team:1")).front().state == MemoryState::Confirmed);
    CHECK(store.list_memories("beta", std::string_view("")).front().state == MemoryState::Rejected);
    const auto replay = commit(store, archive, settings);
    CHECK(replay.counts.groups_preserved == 1 && replay.counts.messages_reused == 3 && replay.revision_before == replay.revision_after);
    Store second(path);
    auto stale = store.prepare_archive_import(archive, settings);
    (void)second.update_bot_profile("alpha", std::string("local profile"));
    rejected(StoreErrorCode::Conflict, [&] { (void)store.commit_archive_import(archive, settings, stale.target_revision, stale.digest); });
    stale = store.prepare_archive_import(archive, settings);
    (void)second.set_group_roster("team:1", Mode::Work, false);
    rejected(StoreErrorCode::Conflict, [&] { (void)store.commit_archive_import(archive, settings, stale.target_revision, stale.digest); });
    auto policy = settings; policy.group_conflict = StoreGroupConflict::Reject;
    CHECK(issue(store.prepare_archive_import(archive, policy), "group_conflict"));
    CHECK(commit(store, archive, settings).counts.messages_reused == 3);
    store.remove_group("team:1");
    const auto deleted = commit(store, archive, settings);
    CHECK(deleted.counts.messages_tombstoned == 3 && deleted.counts.memories_reused == 2);
    CHECK(deleted.revision_before == deleted.revision_after && store.find_group("team:1")->deleted);
    CHECK(store.group_messages("team:1", Mode::Chat).empty() && store.list_memories("beta").size() == 2);
    CHECK(issue(store.prepare_archive_import(archive, options("new-source")), "group_deleted"));
    const auto removed_memory = store.list_memories("beta", std::string_view("team:1")).front();
    store.delete_memory(removed_memory.id, removed_memory.revision);
    CHECK(commit(store, archive, settings).counts.memories_tombstoned == 1);
    SqliteFixture sql(path);
    CHECK(sql.scalar("SELECT count(*) FROM archive_message_sources WHERE target_id IS NULL") == "3");
}

void preserved_groups_and_empty_scopes(const fs::path& path) {
    Store store(path); bots(store);
    auto local = group(); local.members = {"alpha"}; local.history_members = {"alpha"}; local.admins.clear();
    (void)store.create_group(local);
    const auto archive = parse(document()); auto settings = options();
    auto plan = store.prepare_archive_import(archive, settings);
    CHECK(!plan.can_commit && issue(plan, "group_member_conflict"));
    rejected(StoreErrorCode::Conflict, [&] { (void)store.commit_archive_import(archive, settings, plan.target_revision, plan.digest); });
    CHECK(store.group_messages(local.id, Mode::Chat).empty());
    auto source = document(); source["conversations"] = A{scope("alpha", "chat", A{})}; source["memories"] = A{};
    CHECK(commit(store, parse(source), settings).counts.groups_preserved == 1);
    CHECK(store.find_group(local.id)->members.size() == 1);
    source["conversations"] = A{scope("alpha", "chat", A{}, "")};
    CHECK(issue(store.prepare_archive_import(parse(source), settings), "empty_conversation_unsupported"));
    source = document(); source.erase("groups"); source["version"] = 1; source["coverage"] = "conversation-data-only";
    source["excludedTypes"] = A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins", "accounts", "provider-settings", "group-metadata"};
    CHECK(issue(store.prepare_archive_import(parse(source), settings), "group_metadata_unsupported"));
    source = document(); auto deleted = group(); deleted.deleted = true; deleted.in_chat = deleted.in_work = false;
    source["groups"] = A{group_json(deleted)}; source["conversations"] = A{scope("alpha", "chat", A{})};
    Store clean(path.parent_path() / "deleted-import.db");
    CHECK(commit(clean, parse(source), settings).counts.memories_created == 2);
    CHECK(clean.find_group("team:1")->deleted && clean.list_groups().empty());
}

void import_rollback(const fs::path& root) {
    const auto archive = parse(document()); const auto settings = options();
    int index = 0;
    for (const auto* table : {"groups", "messages", "archive_message_sources", "memories", "archive_memory_sources"}) {
        const auto path = root / ("fault-" + std::to_string(index++) + ".db");
        Store store(path); SqliteFixture sql(path);
        const auto plan = store.prepare_archive_import(archive, settings);
        sql.sql("CREATE TRIGGER fail_import BEFORE INSERT ON " + std::string(table) + " BEGIN SELECT RAISE(ABORT,'fixture'); END;");
        rejected(StoreErrorCode::Conflict, [&] { (void)store.commit_archive_import(archive, settings, plan.target_revision, plan.digest); });
        for (const auto* name : {"bots", "groups", "messages", "memories", "archive_message_sources", "archive_memory_sources"})
            CHECK(sql.scalar("SELECT count(*) FROM " + std::string(name)) == "0");
        CHECK(sql.scalar("SELECT revision FROM store_revision") == "0");
        sql.sql("DROP TRIGGER fail_import");
        CHECK(store.commit_archive_import(archive, settings, plan.target_revision, plan.digest).counts.groups_created == 1);
    }
}

void migrations(const fs::path& root) {
    for (int version : {1, 2, 3}) {
        const auto path = root / ("schema-" + std::to_string(version) + ".db");
        Id original{};
        { Store store(path); bots(store); original = store.append_message("gamma", Mode::Chat, "user", "legacy", "legacy").id; }
        {
            SqliteFixture sql(path); std::string commands = "BEGIN IMMEDIATE;";
            for (const auto* table : {"groups", "application_metadata_bootstrap"})
                for (const auto* event : {"INSERT", "UPDATE", "DELETE"})
                    commands += "DROP TRIGGER store_revision_" + std::string(table) + "_" + event + ";";
            commands += "DROP TABLE message_deletions; DROP TABLE bot_archive_receipts; DROP TABLE archive_mid_memory_sources; DROP TABLE mid_memories; DROP TABLE message_contexts;"
                        "DROP TABLE groups; DROP TABLE application_metadata_bootstrap; DROP INDEX messages_group_page;";
            if (version < 3) {
                for (const auto* table : {"bots", "messages", "memories", "message_receipts", "archive_message_sources", "archive_memory_sources"})
                    for (const auto* event : {"INSERT", "UPDATE", "DELETE"})
                        commands += "DROP TRIGGER store_revision_" + std::string(table) + "_" + event + ";";
                commands += "DROP TABLE archive_message_sources; DROP TABLE archive_memory_sources; DROP TABLE store_revision;";
                if (version == 1) commands += "DROP TABLE message_receipts;";
            }
            commands += "PRAGMA user_version=" + std::to_string(version) + "; COMMIT;";
            sql.sql(commands);
        }
        Store upgraded(path); CHECK(!upgraded.application_metadata_bootstrapped());
        upgraded.bootstrap_application_metadata({group("legacy")}, {});
        CHECK(upgraded.group_messages("legacy", Mode::Chat).front().id == original);
        CHECK(upgraded.find_bot("alpha")->persona == "Persona alpha");
        SqliteFixture sql(path); CHECK(sql.scalar("PRAGMA user_version") == "11");
        // Schema 8 adds INSERT/UPDATE/DELETE revision tracking for Chat deletion
        // tombstones: the prior 12 tracked tables become 13, each with 3 events.
        CHECK(sql.scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'store_revision_*'") == "39");
        for (const auto* event : {"INSERT", "UPDATE", "DELETE"})
            CHECK(sql.scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='message_deletions' AND name='store_revision_message_deletions_" + std::string(event) + "'") == "1");
        CHECK(sql.scalar("SELECT count(*) FROM message_deletions") == "0");
        CHECK(upgraded.delete_chat_message("", "legacy", original));
        CHECK(!upgraded.delete_chat_message("", "legacy", original));
        CHECK(sql.scalar("SELECT count(*) FROM message_deletions WHERE message_id=" + std::to_string(original) + " AND bot_id='gamma' AND group_id='legacy' AND mode='chat'") == "1");
    }
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto root = fs::path(argv[1]) / ("g-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        group_lifecycle(root / "lifecycle.db"); bootstrap(root / "bootstrap.db");
        import_groups(root / "import.db"); preserved_groups_and_empty_scopes(root / "preserved.db");
        import_rollback(root); migrations(root);
        std::cout << "store_groups: " << checks << " checks passed (synthetic native group/profile/metadata and v2 import)\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
