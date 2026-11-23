#include "dimension/archive.hpp"
#include "dimension/store.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <array>
#include <algorithm>
#include <atomic>
#include <barrier>
#include <chrono>
#include <filesystem>
#include <functional>
#include <iostream>
#include <limits>
#include <thread>

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

// Synthetic-fixture SQL only: inspect durable mappings, create former native
// layouts, and inject real SQLite trigger failures. No product failAfter hook.
struct SqliteFixture {
    struct sqlite3;
    using Callback = int(__cdecl*)(void*, int, char**, char**);
    HMODULE module{};
    sqlite3* db{};
    int(__cdecl* open)(const char*, sqlite3**, int, const char*){};
    int(__cdecl* close)(sqlite3*){};
    int(__cdecl* execute)(sqlite3*, const char*, Callback, void*, char**){};
    explicit SqliteFixture(const fs::path& file) {
        std::array<wchar_t, 32768> system{};
        const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
        if (!length || length >= system.size()) throw std::runtime_error("Missing system directory");
        module = LoadLibraryW((std::wstring(system.data(), length) + L"\\winsqlite3.dll").c_str());
        if (!module) throw std::runtime_error("Missing system SQLite");
        open = reinterpret_cast<decltype(open)>(GetProcAddress(module, "sqlite3_open_v2"));
        close = reinterpret_cast<decltype(close)>(GetProcAddress(module, "sqlite3_close_v2"));
        execute = reinterpret_cast<decltype(execute)>(GetProcAddress(module, "sqlite3_exec"));
        if (!open || !close || !execute) throw std::runtime_error("Missing fixture SQLite ABI");
        const auto bytes = file.u8string();
        const std::string filename(reinterpret_cast<const char*>(bytes.data()), bytes.size());
        if (open(filename.c_str(), &db, 2 | 4 | 0x10000, nullptr) != 0)
            throw std::runtime_error("Cannot open synthetic SQLite fixture");
        sql("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    }
    ~SqliteFixture() { if (db) close(db); if (module) FreeLibrary(module); }
    void sql(const std::string& text) {
        if (execute(db, text.c_str(), nullptr, nullptr, nullptr) != 0)
            throw std::runtime_error("Synthetic SQLite statement failed");
    }
    std::string scalar(const std::string& text) {
        std::vector<std::string> values;
        const auto callback = [](void* pointer, int count, char** columns, char**) -> int {
            auto& output = *static_cast<std::vector<std::string>*>(pointer);
            for (int i = 0; i < count; ++i) output.emplace_back(columns[i] ? columns[i] : "<null>");
            return 0;
        };
        if (execute(db, text.c_str(), callback, &values, nullptr) != 0 || values.size() != 1)
            throw std::runtime_error("Synthetic SQLite scalar read failed");
        return values.front();
    }
};
O bot() {
    return {{"id", "alpha"}, {"name", "来源角色"}, {"persona", "PRIVATE_PERSONA"},
            {"inChat", true}, {"inWork", true}};
}
O message(std::string id, std::string text, std::string time) {
    return {{"id", std::move(id)}, {"actor", "user"}, {"text", std::move(text)}, {"createdAtMs", std::move(time)}};
}
O memory(std::string id, std::string text, std::string state, std::string revision) {
    return {{"id", std::move(id)}, {"botId", "alpha"}, {"groupId", ""}, {"text", std::move(text)},
            {"state", std::move(state)}, {"revision", std::move(revision)}, {"sourceActor", "user"}};
}
O document() {
    return {{"format", "dimension-conversation-archive"}, {"version", 1}, {"coverage", "conversation-data-only"},
        {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts",
                            "plugins", "accounts", "provider-settings", "group-metadata"}},
        {"bots", A{bot()}},
        {"conversations", A{
            O{{"botId", "alpha"}, {"groupId", ""}, {"mode", "chat"}, {"messages", A{
                message("9223372036854775807", "largest-source-id", "-9223372036854775808"),
                message("9007199254740993", "precise-time", "9007199254740993")}}},
            O{{"botId", "alpha"}, {"groupId", ""}, {"mode", "work"}, {"messages", A{
                message("2", "work-source", "9223372036854775807")}}}}},
        {"memories", A{
            memory("7", "memory-reviewed", "rejected", "9007199254740993"),
            memory("9223372036854775807", "memory-max", "confirmed", "9223372036854775807")}}};
}
ArchiveDocument parse(const O& value) { return parse_archive(Json(value).dump()); }
StoreImportOptions options(std::string source = "fixture-source-v1") {
    return {std::move(source), StoreBotConflict::PreserveExisting, StoreMemoryConflict::PreserveExisting};
}
StoreImportResult commit(Store& store, const ArchiveDocument& archive, const StoreImportOptions& settings) {
    const auto plan = store.prepare_archive_import(archive, settings);
    CHECK(plan.can_commit);
    return store.commit_archive_import(archive, settings, plan.target_revision, plan.digest);
}
bool issue(const StoreImportPlan& plan, std::string_view code) {
    return std::any_of(plan.issues.begin(), plan.issues.end(), [&](const auto& item) { return item.code == code; });
}
Memory find_text(Store& store, std::string_view value) {
    for (const auto& memory : store.list_memories("alpha", {}, true, 500))
        if (memory.text == value) return memory;
    throw std::runtime_error("Expected synthetic memory");
}

void exact_values_and_replay(const fs::path& path) {
    const auto archive = parse(document());
    const auto settings = options();
    std::int64_t revision{};
    std::string digest;
    {
        Store store(path);
        const auto plan = store.prepare_archive_import(archive, settings);
        CHECK(plan.can_commit); CHECK(plan.target_revision == 0); CHECK(plan.digest.size() == 64);
        CHECK(plan.counts.bots_created == 1); CHECK(plan.counts.messages_created == 3); CHECK(plan.counts.memories_created == 2);
        CHECK(store.list_bots().empty());
        CHECK(store.prepare_archive_import(archive, settings).target_revision == 0);
        const auto result = store.commit_archive_import(archive, settings, plan.target_revision, plan.digest);
        CHECK(result.revision_before == 0); CHECK(result.revision_after > 0);
        CHECK(store.find_bot("alpha")->in_chat && store.find_bot("alpha")->in_work);
        const auto chat = store.messages("alpha", Mode::Chat);
        CHECK(chat.size() == 2); CHECK(chat[0].text == "largest-source-id");
        CHECK(chat[0].created_at_ms == std::numeric_limits<std::int64_t>::min());
        CHECK(chat[1].created_at_ms == 9007199254740993LL);
        CHECK(store.messages("alpha", Mode::Work).front().created_at_ms == std::numeric_limits<std::int64_t>::max());
        CHECK(find_text(store, "memory-reviewed").state == MemoryState::Rejected);
        CHECK(find_text(store, "memory-reviewed").revision == 9007199254740993LL);
        CHECK(find_text(store, "memory-max").state == MemoryState::Confirmed);
        CHECK(find_text(store, "memory-max").revision == std::numeric_limits<std::int64_t>::max());
        const auto replay = commit(store, archive, settings);
        CHECK(replay.counts.messages_reused == 3); CHECK(replay.counts.memories_reused == 2);
        CHECK(replay.revision_after == replay.revision_before);
        revision = replay.revision_after; digest = replay.digest;
        SqliteFixture sql(path);
        CHECK(sql.scalar("PRAGMA user_version") == "11");
        CHECK(sql.scalar("SELECT source_record_id FROM archive_message_sources WHERE source_record_id=9223372036854775807") == "9223372036854775807");
        CHECK(sql.scalar("SELECT count(*) FROM archive_message_sources WHERE length(fingerprint)=64") == "3");
    }
    {
        Store reopened(path);
        const auto plan = reopened.prepare_archive_import(archive, settings);
        CHECK(plan.target_revision == revision); CHECK(plan.digest == digest);
        CHECK(commit(reopened, archive, settings).revision_after == revision);
        const auto other_source = commit(reopened, archive, options("different-stable-source"));
        CHECK(other_source.counts.messages_created == 3); // Equal text/time is not message identity.
        CHECK(other_source.counts.memories_preserved == 2);
        CHECK(reopened.messages("alpha", Mode::Chat).size() == 4);
        SqliteFixture sql(path);
        CHECK(sql.scalar("SELECT count(*) FROM archive_message_sources") == "6");
        CHECK(sql.scalar("SELECT count(*) FROM archive_memory_sources") == "4");

        reopened.remove_bot("alpha");
        const auto removed = find_text(reopened, "memory-reviewed");
        reopened.delete_memory(removed.id, removed.revision);
        const auto tombstones = commit(reopened, archive, settings);
        CHECK(tombstones.counts.messages_tombstoned == 3);
        CHECK(tombstones.counts.memories_tombstoned == 1);
        CHECK(tombstones.counts.memories_reused == 1);
        CHECK(tombstones.revision_after == tombstones.revision_before);
        CHECK(reopened.messages("alpha", Mode::Chat).empty());
        CHECK(reopened.messages("alpha", Mode::Work).empty());
        CHECK(!reopened.find_bot("alpha")->in_chat && !reopened.find_bot("alpha")->in_work);
        CHECK(reopened.list_memories("alpha").size() == 1);
        CHECK(sql.scalar("SELECT count(*) FROM archive_message_sources WHERE target_id IS NULL") == "6");
        CHECK(sql.scalar("SELECT count(*) FROM archive_memory_sources WHERE target_id IS NULL") == "2");
    }
}

void policies_and_local_memory_edits(const fs::path& path) {
    Store store(path);
    (void)store.create_bot("LOCAL_NAME", "LOCAL_PERSONA", "alpha");
    auto existing = store.propose_memory("alpha", "", "memory-reviewed", "user");
    auto value = document(); value["conversations"] = A{};
    value["memories"] = A{memory("7", "memory-reviewed", "confirmed", "17")};
    const auto archive = parse(value);
    auto settings = options();
    settings.bot_conflict = StoreBotConflict::Reject;
    CHECK(issue(store.prepare_archive_import(archive, settings), "bot_conflict"));
    settings.bot_conflict = StoreBotConflict::PreserveExisting;
    settings.memory_conflict = StoreMemoryConflict::Reject;
    CHECK(issue(store.prepare_archive_import(archive, settings), "memory_conflict"));
    settings.memory_conflict = StoreMemoryConflict::PreserveExisting;
    CHECK(commit(store, archive, settings).counts.memories_preserved == 1);
    CHECK(store.find_bot("alpha")->name == "LOCAL_NAME"); CHECK(!store.find_bot("alpha")->in_chat);
    CHECK(store.find_memory(existing.id)->state == MemoryState::Candidate);
    CHECK(store.find_memory(existing.id)->revision == 1);
    existing = store.edit_memory(existing.id, existing.revision, "locally edited text");
    existing = store.review_memory(existing.id, existing.revision, MemoryState::Confirmed);
    CHECK(commit(store, archive, settings).counts.memories_reused == 1);
    settings.memory_conflict = StoreMemoryConflict::Reject;
    const auto reject_replay = commit(store, archive, settings);
    CHECK(reject_replay.counts.memories_reused == 1 &&
          reject_replay.revision_after == reject_replay.revision_before);
    CHECK(store.list_memories("alpha").size() == 1);
    CHECK(store.find_memory(existing.id)->text == "locally edited text");
    store.delete_memory(existing.id, existing.revision);
    CHECK(commit(store, archive, settings).counts.memories_tombstoned == 1);
    CHECK(store.list_memories("alpha").empty());

    auto equal = store.propose_memory("alpha", "", "equal memory", "user");
    value["memories"] = A{memory("8", "equal memory", "candidate", "1")};
    settings = options("equal-source"); settings.memory_conflict = StoreMemoryConflict::Reject;
    CHECK(commit(store, parse(value), settings).counts.memories_preserved == 1);
    CHECK(store.find_memory(equal.id)->revision == 1);

    auto changed = document(); changed["conversations"] = A{};
    changed["memories"] = A{memory("7", "different-source-content", "confirmed", "17")};
    const auto plan = store.prepare_archive_import(parse(changed), options());
    CHECK(!plan.can_commit); CHECK(issue(plan, "source_record_changed"));
}

void stale_tokens_and_source_changes(const fs::path& path, const fs::path& other_path) {
    const auto archive = parse(document());
    const auto settings = options();
    Store first(path), second(path), different(other_path);
    const auto plan = first.prepare_archive_import(archive, settings);
    const auto other_plan = different.prepare_archive_import(archive, settings);
    CHECK(other_plan.target_revision == plan.target_revision); CHECK(other_plan.digest != plan.digest);
    rejected(StoreErrorCode::Conflict, [&] { (void)different.commit_archive_import(archive, settings, plan.target_revision, plan.digest); });
    (void)second.create_bot("Concurrent", "", "concurrent");
    rejected(StoreErrorCode::Conflict, [&] { (void)first.commit_archive_import(archive, settings, plan.target_revision, plan.digest); });
    CHECK(!first.find_bot("alpha"));
    (void)commit(first, archive, settings);
    auto source = document();
    auto conversations = source.at("conversations").as_array();
    auto chat = conversations[0].as_object(); auto messages = chat.at("messages").as_array();
    auto message = messages[0].as_object(); message["text"] = "changed source payload";
    messages[0] = message; chat["messages"] = messages; conversations[0] = chat; source["conversations"] = conversations;
    auto changed = first.prepare_archive_import(parse(source), settings);
    CHECK(!changed.can_commit); CHECK(issue(changed, "source_record_changed"));
    rejected(StoreErrorCode::Conflict, [&] { (void)first.commit_archive_import(parse(source), settings, changed.target_revision, changed.digest); });
    const auto prepared = first.prepare_archive_import(archive, settings);
    rejected(StoreErrorCode::Conflict, [&] { (void)first.commit_archive_import(archive, options("other-source"), prepared.target_revision, prepared.digest); });

    auto bad = settings; bad.bot_conflict.reset();
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)first.prepare_archive_import(archive, bad); });
    for (const auto& source_id : {std::string{}, std::string("bad namespace"), std::string(129, 'a')}) {
        bad = settings; bad.source_id = source_id;
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)first.prepare_archive_import(archive, bad); });
    }
}

void unsupported_scopes(const fs::path& path) {
    Store store(path);
    auto source = document();
    auto scopes = source.at("conversations").as_array();
    auto group = scopes[0].as_object(); group["groupId"] = "group-x"; scopes[0] = group;
    auto empty = scopes[1].as_object(); empty["messages"] = A{}; scopes[1] = empty;
    source["conversations"] = scopes;
    auto memories = source.at("memories").as_array();
    auto memory = memories[0].as_object(); memory["groupId"] = "group-x"; memories[0] = memory; source["memories"] = memories;
    const auto archive = parse(source); const auto plan = store.prepare_archive_import(archive, options());
    CHECK(!plan.can_commit); CHECK(plan.issue_count == 3);
    CHECK(issue(plan, "group_metadata_unsupported")); CHECK(issue(plan, "empty_conversation_unsupported"));
    rejected(StoreErrorCode::Conflict, [&] { (void)store.commit_archive_import(archive, options(), plan.target_revision, plan.digest); });
    CHECK(store.list_bots().empty());
}

void concurrent_commit(const fs::path& path) {
    Store first(path), second(path);
    const auto archive = parse(document()); const auto settings = options();
    const auto a = first.prepare_archive_import(archive, settings), b = second.prepare_archive_import(archive, settings);
    CHECK(a.target_revision == b.target_revision && a.digest == b.digest);
    std::barrier start(3); std::atomic<int> succeeded = 0, stale = 0;
    std::array<std::exception_ptr, 2> unexpected;
    auto writer = [&](Store& store, const StoreImportPlan& plan, std::size_t index) {
        start.arrive_and_wait();
        try { (void)store.commit_archive_import(archive, settings, plan.target_revision, plan.digest); ++succeeded; }
        catch (const StoreError& error) { if (error.code() == StoreErrorCode::Conflict) ++stale; else unexpected[index] = std::current_exception(); }
        catch (...) { unexpected[index] = std::current_exception(); }
    };
    std::thread one(writer, std::ref(first), std::cref(a), 0), two(writer, std::ref(second), std::cref(b), 1);
    start.arrive_and_wait(); one.join(); two.join();
    for (const auto& error : unexpected) if (error) std::rethrow_exception(error);
    CHECK(succeeded == 1 && stale == 1);
    CHECK(first.messages("alpha", Mode::Chat).size() == 2);
    CHECK(commit(second, archive, settings).counts.messages_reused == 3);
}

void rollback_faults(const fs::path& root) {
    const std::array<std::pair<const char*, const char*>, 4> faults{{
        {"messages", "NEW.text='work-source'"},
        {"archive_message_sources", "NEW.source_record_id=9007199254740993"},
        {"memories", "NEW.text='memory-max'"},
        {"archive_memory_sources", "NEW.source_record_id=9223372036854775807"}
    }};
    const auto archive = parse(document()); const auto settings = options();
    for (std::size_t i = 0; i < faults.size(); ++i) {
        const auto path = root / ("r" + std::to_string(i) + ".db");
        Store store(path); SqliteFixture sql(path);
        const auto plan = store.prepare_archive_import(archive, settings);
        sql.sql("CREATE TRIGGER fixture_abort BEFORE INSERT ON " + std::string(faults[i].first) +
            " WHEN " + faults[i].second + " BEGIN SELECT RAISE(ABORT,'fixture_abort'); END;");
        rejected(StoreErrorCode::Conflict, [&] { (void)store.commit_archive_import(archive, settings, plan.target_revision, plan.digest); });
        CHECK(store.list_bots().empty());
        for (const auto* table : {"bots", "messages", "memories", "archive_message_sources", "archive_memory_sources"})
            CHECK(sql.scalar("SELECT count(*) FROM " + std::string(table)) == "0");
        CHECK(sql.scalar("SELECT revision FROM store_revision") == std::to_string(plan.target_revision));
        sql.sql("DROP TRIGGER fixture_abort");
        CHECK(store.commit_archive_import(archive, settings, plan.target_revision, plan.digest).counts.messages_created == 3);
    }
}

void migration_and_unknown(const fs::path& root) {
    for (int version : {1, 2}) {
        const auto path = root / ("v" + std::to_string(version) + ".db");
        Id original{};
        { Store store(path); (void)store.create_bot("Existing", "keep", "native-existing");
          original = store.append_message("native-existing", Mode::Chat, "user", "old").id; }
        {
            SqliteFixture sql(path); std::string commands = "BEGIN IMMEDIATE;";
            for (const auto* table : {"bots", "messages", "memories", "message_receipts", "archive_message_sources", "archive_memory_sources", "groups", "application_metadata_bootstrap"})
                for (const auto* event : {"INSERT", "UPDATE", "DELETE"})
                    commands += "DROP TRIGGER store_revision_" + std::string(table) + "_" + event + ";";
            commands += "DROP TABLE message_deletions; DROP TABLE bot_archive_receipts; DROP TABLE archive_mid_memory_sources; DROP TABLE mid_memories; DROP TABLE message_contexts;"
                        "DROP TABLE groups; DROP TABLE application_metadata_bootstrap; DROP INDEX messages_group_page;"
                        "DROP TABLE archive_message_sources; DROP TABLE archive_memory_sources; DROP TABLE store_revision;";
            if (version == 1) commands += "DROP TABLE message_receipts;";
            commands += "PRAGMA user_version=" + std::to_string(version) + "; COMMIT;";
            sql.sql(commands);
        }
        Store upgraded(path);
        CHECK(upgraded.messages("native-existing", Mode::Chat).front().id == original);
        CHECK(upgraded.find_bot("native-existing")->persona == "keep");
        (void)commit(upgraded, parse(document()), options());
        SqliteFixture sql(path); CHECK(sql.scalar("PRAGMA user_version") == "11");
    }
    const auto unrelated = root / "other.db";
    { SqliteFixture sql(unrelated); sql.sql("CREATE TABLE unrelated(value TEXT); PRAGMA application_id=123;"); }
    rejected(StoreErrorCode::Storage, [&] { Store unknown(unrelated); });
    { SqliteFixture sql(unrelated); CHECK(sql.scalar("SELECT count(*) FROM sqlite_master WHERE name='bots'") == "0"); }
}

void atomic_memory_batch_and_revision_limit(const fs::path& path) {
    Store store(path); const auto archive = parse(document()); const auto settings = options();
    (void)commit(store, archive, settings);
    const auto maximum = find_text(store, "memory-max");
    auto first = store.propose_memory("alpha", "", "normal-first", "user");
    first = store.review_memory(first.id, first.revision, MemoryState::Confirmed);
    auto second = store.propose_memory("alpha", "", "normal-second", "user");
    second = store.review_memory(second.id, second.revision, MemoryState::Confirmed);
    const auto before = store.prepare_archive_import(archive, settings).target_revision;
    rejected(StoreErrorCode::Conflict, [&] {
        store.apply_memory_changes("alpha", "", {{first.id, first.revision, "changed-first"}, {maximum.id, maximum.revision, "changed-max"}});
    });
    CHECK(store.find_memory(first.id)->text == "normal-first"); CHECK(store.find_memory(first.id)->revision == first.revision);
    CHECK(store.find_memory(maximum.id)->text == "memory-max");
    CHECK(store.prepare_archive_import(archive, settings).target_revision == before);
    rejected(StoreErrorCode::Conflict, [&] {
        store.apply_memory_changes("alpha", "", {{first.id, first.revision, "duplicate"}, {second.id, second.revision, "duplicate"}});
    });
    CHECK(store.find_memory(first.id)->text == "normal-first");
    CHECK(store.find_memory(second.id)->text == "normal-second");
    CHECK(store.prepare_archive_import(archive, settings).target_revision == before);
    store.apply_memory_changes("alpha", "", {{maximum.id, maximum.revision, " memory-max "}});
    CHECK(store.find_memory(maximum.id)->revision == maximum.revision);
    CHECK(store.prepare_archive_import(archive, settings).target_revision == before);
    rejected(StoreErrorCode::InvalidArgument, [&] { store.apply_memory_changes("alpha", "", {
        {first.id, first.revision, "x"}, {first.id, first.revision, std::nullopt}}); });
    rejected(StoreErrorCode::NotFound, [&] { store.apply_memory_changes("alpha", "other", {{first.id, first.revision, "x"}}); });
    store.apply_memory_changes("alpha", "", {{first.id, first.revision, "changed"}, {second.id, second.revision, std::nullopt}});
    CHECK(store.find_memory(first.id)->state == MemoryState::Candidate);
    CHECK(store.find_memory(first.id)->revision == first.revision + 1);
    CHECK(!store.find_memory(second.id));
    rejected(StoreErrorCode::Conflict, [&] { store.apply_memory_changes("alpha", "", {
        {first.id, first.revision + 1, "candidate cannot be batch edited"}}); });
    rejected(StoreErrorCode::Conflict, [&] { (void)store.review_memory(maximum.id, maximum.revision, MemoryState::Confirmed); });
    rejected(StoreErrorCode::Conflict, [&] { (void)store.edit_memory(maximum.id, maximum.revision, "overflow"); });

    SqliteFixture sql(path);
    sql.sql("UPDATE store_revision SET revision=9223372036854775807 WHERE singleton=1");
    rejected(StoreErrorCode::Conflict, [&] { (void)store.create_bot("overflow", "", "overflow"); });
    CHECK(!store.find_bot("overflow"));
    CHECK(sql.scalar("SELECT typeof(revision)||':'||revision FROM store_revision") == "integer:9223372036854775807");
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto root = fs::path(argv[1]) /
            ("i-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        exact_values_and_replay(root / "values.db");
        policies_and_local_memory_edits(root / "policies.db");
        stale_tokens_and_source_changes(root / "tokens.db", root / "other-target.db");
        unsupported_scopes(root / "scopes.db");
        concurrent_commit(root / "concurrent.db");
        rollback_faults(root); migration_and_unknown(root);
        atomic_memory_batch_and_revision_limit(root / "batch.db");
        std::cout << "store_import: " << checks << " checks passed (synthetic native databases, atomic import and memory edits)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
