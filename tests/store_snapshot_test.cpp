#include "dimension/store.hpp"
#include "dimension/archive.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <barrier>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <iostream>
#include <limits>
#include <mutex>
#include <thread>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
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

// Only synthetic databases are accepted by this test's explicit output root.
// Trusted SQL creates exact int64 fixtures and atomic multi-table generations.
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

Group group(std::string id, bool hidden = false) {
    Group value;
    value.id = std::move(id); value.name = "Team"; value.owner_id = "alpha";
    value.members = {"alpha"}; value.history_members = {"alpha", "zeta"};
    value.in_chat = value.in_work = !hidden; value.seal_shape = "circle"; value.seal_color = "blue";
    return value;
}
void source_identity(const std::string& value) {
    CHECK(value.size() == 39 && value.starts_with("native-"));
    CHECK(std::all_of(value.begin() + 7, value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    }));
}

void exact_complete_readonly(const fs::path& path, const fs::path& other_path) {
    std::string source;
    std::int64_t revision{};
    {
        Store store(path);
        const auto empty = store.archive_snapshot();
        source_identity(empty.source_id); CHECK(empty.revision == 0);
        CHECK(empty.bots.empty() && empty.groups.empty() && empty.messages.empty() && empty.memories.empty());
        (void)store.create_bot("Hidden Zeta", "hidden persona", "zeta");
        (void)store.create_bot("Alpha", "alpha persona", "alpha");
        (void)store.set_roster("alpha", Mode::Chat, true);
        (void)store.create_group(group("z-group"));
        (void)store.create_group(group("a-group", true));
        const auto removed_memory = store.propose_memory("alpha", "z-group", "deleted group memory", "user");
        (void)store.append_message("alpha", Mode::Chat, "user", "to clear", "z-group");
        store.remove_group("z-group");
        const auto first = store.append_message("zeta", Mode::Work, "system", "exact-large", "unknown-legacy");
        const auto second = store.append_message("alpha", Mode::Chat, "user", "exact-min");
        const auto maximum = store.append_message("zeta", Mode::Work, "bot", "exact-max");
        auto candidate = store.propose_memory("zeta", "unknown-memory", "candidate", "user");
        auto rejected_memory = store.propose_memory("alpha", "", "rejected", "user");
        rejected_memory = store.review_memory(rejected_memory.id, rejected_memory.revision, MemoryState::Rejected);
        auto confirmed = store.propose_memory("alpha", "a-group", "confirmed", "user");
        confirmed = store.review_memory(confirmed.id, confirmed.revision, MemoryState::Confirmed);
        SqliteFixture sql(path);
        sql.sql("BEGIN IMMEDIATE; UPDATE messages SET created_at_ms=9007199254740993,id=9007199254740993 WHERE id=" + std::to_string(first.id) +
            "; UPDATE messages SET created_at_ms=-9223372036854775808 WHERE id=" + std::to_string(second.id) +
            "; UPDATE messages SET created_at_ms=9223372036854775807,id=9223372036854775807 WHERE id=" + std::to_string(maximum.id) +
            "; UPDATE memories SET revision=9223372036854775807,id=9007199254740993 WHERE id=" + std::to_string(candidate.id) +
            "; UPDATE groups SET revision=9007199254740993 WHERE id='a-group'; COMMIT;");
        const auto before = sql.scalar("SELECT revision FROM store_revision");
        const auto snapshot = store.archive_snapshot();
        CHECK(snapshot.bots.size() == 2 && snapshot.bots.front().id == "alpha" && snapshot.bots.back().id == "zeta");
        CHECK(!snapshot.bots.back().in_chat && !snapshot.bots.back().in_work && snapshot.bots.back().persona == "hidden persona");
        CHECK(snapshot.groups.size() == 2 && snapshot.groups.front().id == "a-group" && snapshot.groups.back().id == "z-group");
        CHECK(!snapshot.groups.front().in_chat && !snapshot.groups.front().in_work && !snapshot.groups.front().deleted);
        CHECK(snapshot.groups.front().revision == 9007199254740993LL);
        CHECK(snapshot.groups.back().deleted && snapshot.groups.back().history_members.size() == 2);
        CHECK(snapshot.messages.size() == 3 && snapshot.messages.front().id == second.id);
        CHECK(snapshot.messages[0].created_at_ms == std::numeric_limits<std::int64_t>::min());
        CHECK(snapshot.messages[1].id == 9007199254740993LL && snapshot.messages[1].created_at_ms == 9007199254740993LL);
        CHECK(snapshot.messages[1].group_id == "unknown-legacy");
        CHECK(snapshot.messages.back().id == std::numeric_limits<std::int64_t>::max());
        CHECK(snapshot.messages.back().created_at_ms == std::numeric_limits<std::int64_t>::max());
        CHECK(snapshot.memories.size() == 4 && snapshot.memories.front().id == removed_memory.id);
        CHECK(snapshot.memories.front().group_id == "z-group");
        CHECK(snapshot.memories[1].state == MemoryState::Rejected && snapshot.memories[2].state == MemoryState::Confirmed);
        CHECK(snapshot.memories.back().state == MemoryState::Candidate && snapshot.memories.back().group_id == "unknown-memory");
        CHECK(snapshot.memories.back().id == 9007199254740993LL && snapshot.memories.back().revision == std::numeric_limits<std::int64_t>::max());
        CHECK(std::to_string(snapshot.revision) == before);
        CHECK(sql.scalar("SELECT revision FROM store_revision") == before);
        CHECK(sql.scalar("SELECT count(*) FROM application_metadata_bootstrap") == "0");
        CHECK(sql.scalar("PRAGMA user_version") == "11");
        const auto again = store.archive_snapshot();
        CHECK(again.revision == snapshot.revision && again.source_id == snapshot.source_id);
        source = snapshot.source_id; revision = snapshot.revision;
    }
    Store reopened(path), different(other_path);
    CHECK(reopened.archive_snapshot().source_id == source && reopened.archive_snapshot().revision == revision);
    CHECK(different.archive_snapshot().source_id != source);
    SqliteFixture sql(path);
    sql.sql("UPDATE store_revision SET revision=9223372036854775807 WHERE singleton=1");
    CHECK(reopened.archive_snapshot().revision == std::numeric_limits<std::int64_t>::max());
    CHECK(sql.scalar("SELECT typeof(revision)||':'||revision FROM store_revision") == "integer:9223372036854775807");
}

void limits(const fs::path& path, const fs::path& byte_path) {
    Store store(path);
    (void)store.create_bot("Alpha", "", "alpha"); (void)store.create_bot("Zeta", "", "zeta");
    (void)store.create_group(group("one")); (void)store.create_group(group("two"));
    (void)store.append_message("alpha", Mode::Chat, "user", "one");
    (void)store.append_message("zeta", Mode::Work, "user", "two");
    (void)store.propose_memory("alpha", "", "one", "user");
    (void)store.propose_memory("zeta", "", "two", "user");
    const auto revision = store.archive_snapshot().revision;
    constexpr std::array<std::size_t StoreArchiveSnapshotLimits::*, 4> fields{
        &StoreArchiveSnapshotLimits::max_bots, &StoreArchiveSnapshotLimits::max_groups,
        &StoreArchiveSnapshotLimits::max_messages, &StoreArchiveSnapshotLimits::max_memories};
    for (const auto field : fields) {
        StoreArchiveSnapshotLimits cap;
        cap.*field = 1;
        rejected(StoreErrorCode::LimitExceeded, [&] { (void)store.archive_snapshot(cap); });
        cap.*field = 2;
        CHECK(store.archive_snapshot(cap).revision == revision);
        cap.*field = 0;
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.archive_snapshot(cap); });
        cap.*field = std::numeric_limits<std::size_t>::max();
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.archive_snapshot(cap); });
    }
    StoreArchiveSnapshotLimits cap; cap.max_record_bytes = 0;
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.archive_snapshot(cap); });
    cap.max_record_bytes = 32;
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)store.archive_snapshot(cap); });
    CHECK(store.archive_snapshot().revision == revision);
    (void)store.update_bot_profile("alpha", {}, std::string("after failed read"));
    CHECK(store.archive_snapshot().revision > revision); // Failed reads did not leave a transaction open.

    Store bytes(byte_path);
    (void)bytes.create_bot("名", "🙂", "bot"); // 3 + 3 + 4 UTF-8 bytes.
    cap = {}; cap.max_record_bytes = 10;
    CHECK(bytes.archive_snapshot(cap).bots.front().persona == "🙂");
    cap.max_record_bytes = 9;
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)bytes.archive_snapshot(cap); });
    (void)bytes.append_message("bot", Mode::Chat, "user", "x"); // 3 + 0 + 4 + 4 + 1 = 12 bytes.
    cap.max_record_bytes = 22;
    CHECK(bytes.archive_snapshot(cap).messages.size() == 1);
    cap.max_record_bytes = 21;
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)bytes.archive_snapshot(cap); });
    (void)bytes.propose_memory("bot", "", "m", "user"); // 3 + 0 + 1 + 9 + 4 = 17 bytes.
    cap.max_record_bytes = 39;
    CHECK(bytes.archive_snapshot(cap).memories.size() == 1);
    cap.max_record_bytes = 38;
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)bytes.archive_snapshot(cap); });
    Group minimal; minimal.id = "g"; minimal.name = "G"; minimal.owner_id = "bot";
    minimal.members = {"bot"}; minimal.admins = {"bot"};
    (void)bytes.create_group(minimal); // id/name/owner + three member-array IDs = 14 bytes.
    cap.max_record_bytes = 53;
    CHECK(bytes.archive_snapshot(cap).groups.size() == 1);
    cap.max_record_bytes = 52;
    rejected(StoreErrorCode::LimitExceeded, [&] { (void)bytes.archive_snapshot(cap); });
}

void reject_same_source(const fs::path& path, const fs::path& target_path) {
    Store source(path), target(target_path);
    (void)source.create_bot("Alpha", "", "alpha");
    (void)source.append_message("alpha", Mode::Chat, "user", "original");
    const auto snapshot = source.archive_snapshot();
    using A = Json::Array;
    using O = Json::Object;
    const auto& message = snapshot.messages.front();
    const auto document = parse_archive(Json(O{
        {"format", "dimension-conversation-archive"}, {"version", 1}, {"coverage", "conversation-data-only"},
        {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins", "accounts", "provider-settings", "group-metadata"}},
        {"bots", A{O{{"id", "alpha"}, {"name", "Alpha"}, {"persona", ""}, {"inChat", false}, {"inWork", false}}}},
        {"conversations", A{O{{"botId", "alpha"}, {"groupId", ""}, {"mode", "chat"},
            {"messages", A{O{{"id", std::to_string(message.id)}, {"actor", message.actor}, {"text", message.text},
                            {"createdAtMs", std::to_string(message.created_at_ms)}}}}}}}, {"memories", A{}}}).dump());
    StoreImportOptions settings{snapshot.source_id, StoreBotConflict::PreserveExisting,
                               StoreMemoryConflict::PreserveExisting};
    const auto self = source.prepare_archive_import(document, settings);
    CHECK(!self.can_commit && self.issue_count == 1 && self.issues.size() == 1);
    CHECK(self.issues.front().code == "source_is_target" && self.issues.front().kind == "archive");
    rejected(StoreErrorCode::Conflict, [&] { (void)source.commit_archive_import(document, settings, self.target_revision, self.digest); });
    CHECK(source.archive_snapshot().revision == snapshot.revision && source.messages("alpha", Mode::Chat).size() == 1);
    const auto other = target.prepare_archive_import(document, settings);
    CHECK(other.can_commit && target.archive_snapshot().source_id != snapshot.source_id);
    CHECK(target.commit_archive_import(document, settings, other.target_revision, other.digest).counts.messages_created == 1);
    const auto replay = target.prepare_archive_import(document, settings);
    CHECK(replay.can_commit && replay.counts.messages_reused == 1);
    const auto replay_result = target.commit_archive_import(document, settings, replay.target_revision, replay.digest);
    CHECK(replay_result.revision_after == replay_result.revision_before && target.messages("alpha", Mode::Chat).size() == 1);
}

void verify_generation(const StoreArchiveSnapshot& snapshot, std::int64_t baseline) {
    CHECK(snapshot.bots.size() == 1 && !snapshot.messages.empty() && !snapshot.memories.empty());
    const auto& marker = snapshot.bots.front().persona;
    CHECK(marker.starts_with("generation-"));
    CHECK(snapshot.messages.front().text == marker && snapshot.memories.front().text == marker);
    const auto generation = std::stoll(marker.substr(11));
    CHECK(snapshot.revision == baseline + generation * 3);
}

void concurrent_snapshot(const fs::path& path) {
    Store reader(path);
    (void)reader.create_bot("Alpha", "generation-0", "alpha");
    (void)reader.append_message("alpha", Mode::Chat, "user", "generation-0");
    (void)reader.propose_memory("alpha", "", "generation-0", "user");
    SqliteFixture writer(path);
    writer.sql("BEGIN IMMEDIATE; "
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000) "
        "INSERT INTO messages(bot_id,group_id,mode,actor,text,created_at_ms) "
        "SELECT 'alpha','','chat','user','filler-message-'||x||'-'||printf('%0128d',x),x FROM n; "
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000) "
        "INSERT INTO memories(bot_id,group_id,text,state,revision,source_actor) "
        "SELECT 'alpha','','filler-memory-'||x||'-'||printf('%0128d',x),'candidate',1,'user' FROM n; COMMIT;");
    const auto initial = reader.archive_snapshot();
    const auto baseline = initial.revision;
    verify_generation(initial, baseline);

    // Deterministic overlap: the writer pauses after changing just one table
    // in an uncommitted transaction. The entire reader snapshot must stay old.
    std::mutex gate;
    std::condition_variable changed;
    bool partial_ready = false, allow_commit = false;
    std::exception_ptr failure;
    std::thread paused_writer([&] {
        try {
            writer.sql("BEGIN IMMEDIATE; UPDATE bots SET persona='generation-1' WHERE id='alpha';");
            {
                std::unique_lock lock(gate); partial_ready = true; changed.notify_all();
                if (!changed.wait_for(lock, std::chrono::seconds(10), [&] { return allow_commit; }))
                    throw std::runtime_error("Timed out waiting for overlapping read");
            }
            writer.sql("UPDATE messages SET text='generation-1' WHERE id=1; "
                "UPDATE memories SET text='generation-1',revision=revision+1 WHERE id=1; COMMIT;");
        } catch (...) {
            failure = std::current_exception();
            { std::lock_guard lock(gate); partial_ready = true; } changed.notify_all();
        }
    });
    try {
        {
            std::unique_lock lock(gate);
            if (!changed.wait_for(lock, std::chrono::seconds(10), [&] { return partial_ready; }))
                throw std::runtime_error("Writer did not enter the overlapping transaction");
        }
        const auto during = reader.archive_snapshot();
        verify_generation(during, baseline); CHECK(during.revision == baseline);
        { std::lock_guard lock(gate); allow_commit = true; } changed.notify_all();
        paused_writer.join();
    } catch (...) {
        { std::lock_guard lock(gate); allow_commit = true; } changed.notify_all();
        paused_writer.join(); throw;
    }
    if (failure) std::rethrow_exception(failure);
    CHECK(reader.archive_snapshot().bots.front().persona == "generation-1");

    // Commits actively race complete exports. Require observed commits within
    // snapshot calls rather than accepting a run whose threads never overlap.
    std::atomic<bool> stop = false;
    std::atomic<int> committed = 1;
    std::barrier start(2);
    std::thread racing_writer([&] {
        start.arrive_and_wait();
        try {
            int generation = 1;
            while (!stop.load()) {
                const auto marker = "generation-" + std::to_string(++generation);
                writer.sql("BEGIN IMMEDIATE; UPDATE bots SET persona='" + marker + "' WHERE id='alpha'; "
                    "UPDATE messages SET text='" + marker + "' WHERE id=1; "
                    "UPDATE memories SET text='" + marker + "',revision=revision+1 WHERE id=1; COMMIT;");
                committed.store(generation);
            }
        } catch (...) { failure = std::current_exception(); stop = true; }
    });
    start.arrive_and_wait();
    std::size_t overlaps = 0, snapshots = 0;
    try {
        for (; snapshots < 96 && (snapshots < 16 || overlaps < 4); ++snapshots) {
            const auto before = committed.load();
            const auto snapshot = reader.archive_snapshot();
            const auto after = committed.load();
            verify_generation(snapshot, baseline);
            CHECK(snapshot.source_id == initial.source_id);
            CHECK(snapshot.messages.size() == 3001 && snapshot.memories.size() == 3001);
            if (after > before) ++overlaps;
            std::this_thread::yield();
        }
        stop = true; racing_writer.join();
    } catch (...) { stop = true; racing_writer.join(); throw; }
    if (failure) std::rethrow_exception(failure);
    CHECK(overlaps > 0 && committed.load() > 1);
    verify_generation(reader.archive_snapshot(), baseline);
    std::cout << "snapshot concurrency: " << snapshots << " reads, " << overlaps
              << " calls overlapping commits, " << committed.load() << " generations\n";
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto root = fs::path(argv[1]) / ("snapshot-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        exact_complete_readonly(root / "exact.db", root / "other.db");
        limits(root / "limits.db", root / "bytes.db");
        reject_same_source(root / "source.db", root / "copy.db"); concurrent_snapshot(root / "concurrent.db");
        std::cout << "store_snapshot: " << checks << " checks passed (synthetic native read snapshots)\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
