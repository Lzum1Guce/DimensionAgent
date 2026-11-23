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
std::size_t checks{};
constexpr std::int64_t day = 24LL * 60 * 60 * 1000;
constexpr std::int64_t clock_start = 1700000000000LL;
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

// Direct SQL is limited to these isolated fixtures: old native layouts,
// metadata boundary values, and fault injection through real SQLite objects.
struct SqliteFixture {
    struct sqlite3;
    using Callback = int(__cdecl*)(void*, int, char**, char**);
    HMODULE module{}; sqlite3* db{};
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
        if (open(filename.c_str(), &db, 2 | 4 | 0x10000, nullptr) != 0) throw std::runtime_error("Cannot open fixture");
        sql("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    }
    ~SqliteFixture() { if (db) close(db); if (module) FreeLibrary(module); }
    void sql(const std::string& text) {
        if (execute(db, text.c_str(), nullptr, nullptr, nullptr) != 0) throw std::runtime_error("Fixture SQL failed");
    }
    std::string scalar(const std::string& text) {
        std::vector<std::string> values;
        const auto callback = [](void* pointer, int count, char** columns, char**) -> int {
            auto& output = *static_cast<std::vector<std::string>*>(pointer);
            for (int i = 0; i < count; ++i) output.emplace_back(columns[i] ? columns[i] : "<null>");
            return 0;
        };
        if (execute(db, text.c_str(), callback, &values, nullptr) != 0 || values.size() != 1)
            throw std::runtime_error("Fixture scalar failed");
        return values.front();
    }
};
void bots(Store& store) {
    (void)store.create_bot("Alpha", "persona alpha", "alpha");
    (void)store.create_bot("Beta", "persona beta", "beta");
}
MidMemory find(Store& store, Id id, std::string_view group = "") {
    const auto rows = store.list_mid_memories("alpha", group);
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const auto& row) { return row.id == id; });
    if (found == rows.end()) throw std::runtime_error("Missing mid fixture");
    return *found;
}
void lifecycle(const fs::path& path) {
    Id saved{};
    {
        Store store(path); bots(store);
        const auto first = store.add_mid_memory("alpha", "", "项目将于周五评审", 7, clock_start); saved = first.id;
        CHECK(first.source_actor == "user" && first.revision == 1 && first.strength == 1);
        CHECK(first.created_at_ms == clock_start && first.updated_at_ms == clock_start);
        CHECK(first.expires_at_ms == clock_start + 7 * day);
        CHECK(store.list_memories("alpha").empty());
        CHECK(store.recall_mid_memory_excerpts("alpha", "", "评审", 3, 600, first.expires_at_ms - 1).size() == 1);
        CHECK(store.recall_mid_memory_excerpts("alpha", "", "评审", 3, 600, first.expires_at_ms).empty());
        CHECK(store.list_mid_memories("alpha").front().text == first.text);
        store.apply_mid_memory_changes("alpha", "", {{first.id, 1, "已过期原文仍可编辑"}}, clock_start + 8 * day);
        auto edited = find(store, first.id);
        CHECK(edited.revision == 2 && edited.expires_at_ms == first.expires_at_ms && edited.strength == 1);
        CHECK(store.recall_mid_memory_excerpts("alpha", "", "", 3, 600, clock_start + 8 * day).empty());
        const auto revision = store.archive_snapshot().revision;
        store.apply_mid_memory_changes("alpha", "", {{edited.id, 2, edited.text}}, clock_start + 9 * day);
        CHECK(find(store, edited.id).revision == 2 && store.archive_snapshot().revision == revision);
        auto renewed = store.reinforce_mid_memory("alpha", "", edited.id, 2, 7, clock_start + 8 * day);
        CHECK(renewed.revision == 3 && renewed.strength == 2 && renewed.expires_at_ms == clock_start + 15 * day);
        CHECK(store.recall_mid_memory_excerpts("alpha", "", "", 3, 600, clock_start + 8 * day).size() == 1);
        renewed = store.reinforce_mid_memory("alpha", "", renewed.id, 3, 1, clock_start + 8 * day);
        CHECK(renewed.expires_at_ms == clock_start + 16 * day && renewed.strength == 3);
        store.apply_mid_memory_changes("alpha", "", {{renewed.id, 4, "时钟回退不降低修改时间"}}, clock_start);
        CHECK(find(store, renewed.id).updated_at_ms == clock_start + 8 * day);
        CHECK(store.list_memories("alpha").empty()); // Reinforcement never promotes to long-term.
    }
    Store reopened(path);
    const auto row = find(reopened, saved);
    CHECK(row.revision == 5 && row.strength == 3 && row.expires_at_ms == clock_start + 16 * day);
    CHECK(row.text == "时钟回退不降低修改时间");
    reopened.apply_mid_memory_changes("alpha", "", {{saved, row.revision, std::nullopt}}, clock_start + 17 * day);
    CHECK(reopened.list_mid_memories("alpha").empty());
    rejected(StoreErrorCode::Conflict, [&] { reopened.apply_mid_memory_changes("alpha", "", {{saved, row.revision, "stale"}}, clock_start); });
}
void scopes_and_atomicity(const fs::path& path) {
    Store store(path); bots(store);
    const auto first = store.add_mid_memory("alpha", "", "first", 7, clock_start);
    const auto second = store.add_mid_memory("alpha", "", "second", 7, clock_start);
    const auto grouped = store.add_mid_memory("alpha", "group:one", "shared task", 7, clock_start);
    (void)store.add_mid_memory("beta", "", "beta private", 7, clock_start);
    CHECK(store.list_mid_memories("alpha").size() == 2 && store.list_mid_memories("alpha", "group:one").size() == 1);
    CHECK(store.recall_mid_memory_excerpts("alpha", "group:one", "", 3, 600, clock_start).front().source.id == grouped.id);
    CHECK(store.recall_mid_memory_excerpts("alpha", "group:two", "", 3, 600, clock_start).empty());
    rejected(StoreErrorCode::NotFound, [&] { store.apply_mid_memory_changes("beta", "", {{first.id, 1, "wrong bot"}}, clock_start); });
    rejected(StoreErrorCode::NotFound, [&] { (void)store.reinforce_mid_memory("alpha", "", grouped.id, 1, 7, clock_start); });
    store.apply_mid_memory_changes("alpha", "", {{second.id, 1, "second v2"}}, clock_start + 1);
    rejected(StoreErrorCode::Conflict, [&] { store.apply_mid_memory_changes("alpha", "", {{first.id, 1, "must rollback"}, {second.id, 1, "stale"}}, clock_start + 2); });
    CHECK(find(store, first.id).text == "first" && find(store, first.id).revision == 1);
    rejected(StoreErrorCode::Conflict, [&] { store.apply_mid_memory_changes("alpha", "", {{first.id, 1, "same"}, {second.id, 2, "same"}}, clock_start + 3); });
    CHECK(find(store, first.id).text == "first" && find(store, second.id).text == "second v2");
    rejected(StoreErrorCode::Conflict, [&] { (void)store.reinforce_mid_memory("alpha", "", second.id, 1, 7, clock_start); });
    rejected(StoreErrorCode::InvalidArgument, [&] { store.apply_mid_memory_changes("alpha", "", {{first.id, 1, "x"}, {first.id, 1, "y"}}, clock_start); });
    rejected(StoreErrorCode::NotFound, [&] { (void)store.add_mid_memory("missing", "", "x", 7, clock_start); });
}
void boundaries_and_recall(const fs::path& path) {
    Store store(path); bots(store);
    for (const int days : {0, 31}) rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.add_mid_memory("alpha", "", "x", days, clock_start); });
    for (const auto& text : {std::string(), std::string(" \n\t "), std::string("\xc0\xaf"), std::string(16385, 'x')})
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.add_mid_memory("alpha", "", text, 7, clock_start); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.add_mid_memory("alpha", "", "x", 7, -1); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.add_mid_memory("alpha", "", "x", 7, std::numeric_limits<std::int64_t>::max()); });
    const auto edge = store.add_mid_memory("alpha", "", std::string(16384, 'a'), 30, clock_start);
    auto extended = store.reinforce_mid_memory("alpha", "", edge.id, 1, 30, clock_start);
    extended = store.reinforce_mid_memory("alpha", "", edge.id, 2, 30, clock_start);
    CHECK(extended.expires_at_ms == clock_start + 90 * day && extended.strength == 3);
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)store.reinforce_mid_memory("alpha", "", edge.id, 3, 1, clock_start); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.recall_mid_memory_excerpts("alpha", "", "", 0, 600, clock_start); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.recall_mid_memory_excerpts("alpha", "", "", 3, 1601, clock_start); });
    rejected(StoreErrorCode::InvalidArgument, [&] { store.apply_mid_memory_changes("alpha", "", std::vector<MemoryChange>(101), clock_start); });
    const auto relevant = store.add_mid_memory("alpha", "", "🌱 Unicode 目标句", 7, clock_start);
    const auto recalled = store.recall_mid_memory_excerpts("alpha", "", "目标句", 1, 8, clock_start);
    CHECK(recalled.size() == 1 && recalled.front().source.id == relevant.id);
    CHECK(recalled.front().source.truncated && recalled.front().source.total_codepoints == 13);
    CHECK(recalled.front().expires_at_ms == relevant.expires_at_ms && recalled.front().strength == 1);
    const auto literal = store.add_mid_memory("alpha", "literal", "@dimension-note/v1/user-profile\nplain text", 7, clock_start);
    CHECK(store.recall_mid_memory_excerpts("alpha", "literal", "", 1, 600, clock_start).front().source.text == literal.text);
    CHECK(store.recall_mid_memory_excerpts("alpha", "literal", "", 1, 600, clock_start).front().source.relation_key.empty());
    const auto missed = store.add_mid_memory("alpha", "", "这段中期没有问句词，只靠摘要注入。", 7, clock_start);
    const auto digest = store.recall_mid_memory_excerpts("alpha", "", "最早记得什么", 3, 1600, clock_start);
    CHECK(std::any_of(digest.begin(), digest.end(), [&](const auto& row) { return row.source.id == missed.id; }));
    CHECK(digest.size() <= 3);

    SqliteFixture sql(path);
    sql.sql("UPDATE mid_memories SET revision=9223372036854775807 WHERE id=" + std::to_string(relevant.id));
    rejected(StoreErrorCode::Conflict, [&] { store.apply_mid_memory_changes("alpha", "", {{relevant.id, std::numeric_limits<std::int64_t>::max(), "change"}}, clock_start); });
    rejected(StoreErrorCode::Conflict, [&] { (void)store.reinforce_mid_memory("alpha", "", relevant.id, std::numeric_limits<std::int64_t>::max(), 1, clock_start); });
    sql.sql("UPDATE mid_memories SET strength=1000000 WHERE id=" + std::to_string(literal.id));
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)store.reinforce_mid_memory("alpha", "literal", literal.id, 1, 1, clock_start); });
}
void quotas(const fs::path& path) {
    Store store(path); bots(store);
    // Expired originals count toward both bounds; expiry cannot silently free
    // storage or make a prior note disappear from manual management.
    SqliteFixture sql(path);
    sql.sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200) "
        "INSERT INTO mid_memories(bot_id,group_id,text,source_actor,revision,created_at_ms,updated_at_ms,expires_at_ms,strength) "
        "SELECT 'alpha','','note '||i,'user',1,0,0,1,1 FROM n;");
    CHECK(store.list_mid_memories("alpha").size() == 200);
    CHECK(store.recall_mid_memory_excerpts("alpha", "", "", 3, 600, clock_start).empty());
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)store.add_mid_memory("alpha", "", "scope overflow", 7, clock_start); });
    sql.sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9800) "
        "INSERT INTO mid_memories(bot_id,group_id,text,source_actor,revision,created_at_ms,updated_at_ms,expires_at_ms,strength) "
        "SELECT 'beta','scope-'||CAST((i-1)/200 AS TEXT),'note '||i,'user',1,0,0,1,1 FROM n;");
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)store.add_mid_memory("beta", "", "global overflow", 7, clock_start); });
    const auto old = store.list_mid_memories("alpha").front();
    store.apply_mid_memory_changes("alpha", "", {{old.id, 1, std::nullopt}}, clock_start);
    (void)store.add_mid_memory("alpha", "", "one explicit deletion releases capacity", 7, clock_start);
    CHECK(sql.scalar("SELECT count(*) FROM mid_memories") == "10000");
}
void migrations(const fs::path& root) {
    for (const int version : {4, 5}) {
        const auto path = root / ("schema-" + std::to_string(version) + ".db");
        Id message{};
        { Store store(path); bots(store); message = store.append_message("alpha", Mode::Chat, "user", "before").id; }
        { SqliteFixture sql(path);
          sql.sql("BEGIN IMMEDIATE; DROP TABLE message_deletions; DROP TABLE bot_archive_receipts; DROP TABLE archive_mid_memory_sources; DROP TABLE mid_memories;" +
            std::string(version == 4 ? "DROP TABLE message_contexts;" : "") +
            "PRAGMA user_version=" + std::to_string(version) + "; COMMIT;"); }
        Store upgraded(path); SqliteFixture sql(path);
        CHECK(sql.scalar("PRAGMA user_version") == "11");
        // Schema 8 adds the three message_deletions revision triggers.
        CHECK(sql.scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'store_revision_*'") == "39");
        for (const auto* event : {"INSERT", "UPDATE", "DELETE"})
            CHECK(sql.scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='message_deletions' AND name='store_revision_message_deletions_" + std::string(event) + "'") == "1");
        CHECK(upgraded.messages("alpha", Mode::Chat).front().id == message);
        CHECK(upgraded.find_bot("alpha")->persona == "persona alpha");
        CHECK(upgraded.add_mid_memory("alpha", "", "after upgrade", 7, clock_start).revision == 1);
        CHECK(upgraded.delete_chat_message("alpha", "", message));
        CHECK(!upgraded.delete_chat_message("alpha", "", message));
        CHECK(sql.scalar("SELECT count(*) FROM message_deletions WHERE message_id=" + std::to_string(message) + " AND bot_id='alpha' AND group_id='' AND mode='chat'") == "1");
        CHECK(upgraded.list_mid_memories("alpha").front().text == "after upgrade");
    }
    const auto path = root / "migration-fault.db";
    { Store store(path); bots(store); (void)store.append_message("alpha", Mode::Chat, "user", "retained"); }
    { SqliteFixture sql(path);
      sql.sql("DROP TABLE message_deletions; DROP TABLE bot_archive_receipts; DROP TABLE archive_mid_memory_sources; DROP TABLE mid_memories;"
        "CREATE TABLE archive_mid_memory_sources(fixture TEXT); PRAGMA user_version=5;"); }
    rejected(StoreErrorCode::Storage, [&] { Store failed(path); });
    { SqliteFixture sql(path);
      CHECK(sql.scalar("PRAGMA user_version") == "5");
      CHECK(sql.scalar("SELECT count(*) FROM sqlite_master WHERE name='mid_memories'") == "0");
      CHECK(sql.scalar("SELECT count(*) FROM messages") == "1");
      sql.sql("DROP TABLE archive_mid_memory_sources;"); }
    { Store repaired(path); CHECK(repaired.list_mid_memories("alpha").empty()); }
    { SqliteFixture sql(path); sql.sql("DROP TRIGGER store_revision_mid_memories_INSERT;"); }
    rejected(StoreErrorCode::Storage, [&] { Store missing_trigger(path); });
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated output directory");
        const auto root = fs::path(argv[1]) / ("mid-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        lifecycle(root / "lifecycle.db"); scopes_and_atomicity(root / "scopes.db");
        boundaries_and_recall(root / "bounds.db"); quotas(root / "quotas.db"); migrations(root);
        std::cout << "mid_memory: " << checks << " checks passed (typed TTL, manual reinforcement, scope, revisions, quotas and schema8)\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
