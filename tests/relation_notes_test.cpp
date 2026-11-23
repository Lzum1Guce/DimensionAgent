#include "dimension/archive.hpp"
#include "dimension/archive_export.hpp"
#include "dimension/relation_notes.hpp"
#include "dimension/store.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
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
template<class F> void invalid_archive(F action) {
    ++checks;
    try { action(); } catch (const ArchiveError&) { return; }
    throw std::runtime_error("Expected invalid archive");
}
std::map<std::string, std::string> values(std::string content = {}) {
    std::map<std::string, std::string> result;
    for (const auto& field : relation_note_fields) result.emplace(field.key, content);
    return result;
}

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
            const auto bytes = file.u8string(); const std::string filename(reinterpret_cast<const char*>(bytes.data()), bytes.size());
            if (open(filename.c_str(), &db, 2 | 4 | 0x10000, nullptr) != 0) throw std::runtime_error("Cannot open synthetic fixture");
            sql("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        } catch (...) { release(); throw; }
    }
    ~SqliteFixture() { release(); }
    void release() { if (db && close) close(db); db = nullptr; if (module) FreeLibrary(module); module = nullptr; }
    void sql(const std::string& value) {
        if (execute(db, value.c_str(), nullptr, nullptr, nullptr) != 0) throw std::runtime_error("Synthetic SQL failed");
    }
    std::string scalar(const std::string& value) {
        std::vector<std::string> output;
        const auto callback = [](void* pointer, int count, char** columns, char**) -> int {
            auto& result = *static_cast<std::vector<std::string>*>(pointer);
            for (int i = 0; i < count; ++i) result.emplace_back(columns[i] ? columns[i] : "<null>");
            return 0;
        };
        if (execute(db, value.c_str(), callback, &output, nullptr) != 0 || output.size() != 1)
            throw std::runtime_error("Synthetic scalar failed");
        return output.front();
    }
};

O note(std::string id, std::string key, std::string content) {
    return {{"id", std::move(id)}, {"botId", "alpha"}, {"groupId", ""},
            {"text", encode_relation_note(key, content)}, {"state", "confirmed"}, {"revision", "3"}, {"sourceActor", "user"}};
}
O document(A memories) {
    return {{"format", "dimension-conversation-archive"}, {"version", 1}, {"coverage", "conversation-data-only"},
        {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts", "plugins", "accounts", "provider-settings", "group-metadata"}},
        {"bots", A{O{{"id", "alpha"}, {"name", "Alpha"}, {"persona", "Bot-only persona"}, {"inChat", false}, {"inWork", false}}}},
        {"conversations", A{}}, {"memories", std::move(memories)}};
}
ArchiveDocument parse(const O& source) { return parse_archive(Json(source).dump()); }
StoreImportOptions options(std::string source = "relation-fixture") {
    return {std::move(source), StoreBotConflict::PreserveExisting, StoreMemoryConflict::PreserveExisting};
}
StoreImportResult commit(Store& store, const ArchiveDocument& archive, const StoreImportOptions& settings) {
    const auto plan = store.prepare_archive_import(archive, settings); CHECK(plan.can_commit);
    return store.commit_archive_import(archive, settings, plan.target_revision, plan.digest);
}

void format_and_semantics() {
    CHECK(!parse_relation_note("ordinary explicit memory"));
    for (const auto& field : relation_note_fields) {
        const auto encoded = encode_relation_note(field.key, "  explicit value  ");
        const auto decoded = parse_relation_note(encoded);
        CHECK(decoded && decoded->key == field.key && decoded->content == "explicit value");
        const auto rendered = memory_context_text(encoded);
        CHECK(rendered.find(field.title) != std::string::npos && rendered.find(field.description) != std::string::npos);
        CHECK(rendered.find(relation_note_reserved_prefix) == std::string::npos);
    }
    CHECK(memory_context_text("plain") == "plain");
    CHECK(relation_note_fields[0].description.find("用户的信息") != std::string_view::npos);
    CHECK(relation_note_fields[2].description.find("本应用中的其他 Bot") != std::string_view::npos);
    CHECK(relation_note_fields[3].description.find("外部平台") != std::string_view::npos);
    for (const auto* encoded : {"@dimension-note/v2/user-profile\nx", "@dimension-note/v1/unknown\nx",
         "@dimension-note/v1/user-profile", "@dimension-note/v1/user-profile\n", "@dimension-note/v1/user-profile\n x"})
        rejected(StoreErrorCode::InvalidArgument, [&] { (void)parse_relation_note(encoded); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)encode_relation_note("unknown", "x"); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)encode_relation_note("user-profile", " \n "); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)encode_relation_note("user-profile", std::string(65537, 'x')); });
    CHECK(parse_relation_note(encode_relation_note("user-profile", std::string(65536, 'x')))->content.size() == 65536);
}

void atomic_save_and_guards(const fs::path& path, const fs::path& other_path) {
    Store store(path), other(other_path);
    (void)store.create_bot("Alpha", "own persona", "alpha"); (void)store.create_bot("Beta", "", "beta");
    (void)other.create_bot("Alpha", "", "alpha");
    const auto initial = store.read_relation_notes("alpha");
    const auto before = store.archive_snapshot().revision;
    CHECK(initial.values == values() && initial.revision.size() == 64);
    CHECK(store.list_memories("alpha").empty());
    CHECK(store.save_relation_notes("alpha", values(), initial.revision).revision == initial.revision);
    CHECK(store.archive_snapshot().revision == before);
    rejected(StoreErrorCode::Conflict, [&] { (void)store.save_relation_notes("beta", values("x"), initial.revision); });
    rejected(StoreErrorCode::Conflict, [&] { (void)other.save_relation_notes("alpha", values("x"), initial.revision); });
    auto bad = values(); bad.erase("contacts");
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.save_relation_notes("alpha", bad, initial.revision); });
    bad["unknown"] = "x";
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.save_relation_notes("alpha", bad, initial.revision); });
    bad = values(); bad["contacts"] = std::string(65537, 'x');
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.save_relation_notes("alpha", bad, initial.revision); });
    bad = values(); bad["contacts"] = std::string("x\0y", 3);
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.save_relation_notes("alpha", bad, initial.revision); });
    auto form = values(); form["user-profile"] = " User information "; form["contacts"] = "Local Bot and human contacts";
    form["external-bots"] = "Bot in another agent";
    auto saved = store.save_relation_notes("alpha", form, initial.revision);
    CHECK(saved.values.at("user-profile") == "User information" && saved.values.at("user-relationship").empty());
    CHECK(saved.revision != initial.revision && store.list_memories("alpha").size() == 3);
    CHECK(store.find_bot("alpha")->persona == "own persona");
    for (const auto& memory : store.list_memories("alpha"))
        CHECK(memory.state == MemoryState::Confirmed && memory.group_id.empty() && memory.source_actor == "user");
    const auto global = store.archive_snapshot().revision;
    CHECK(store.save_relation_notes("alpha", saved.values, saved.revision).revision == saved.revision);
    CHECK(store.archive_snapshot().revision == global);
    auto ordinary = store.propose_memory("alpha", "", "ordinary memory", "user");
    CHECK(store.read_relation_notes("alpha").revision == saved.revision);
    ordinary = store.review_memory(ordinary.id, ordinary.revision, MemoryState::Confirmed);
    store.delete_memory(ordinary.id, ordinary.revision);
    CHECK(store.read_relation_notes("alpha").revision == saved.revision);
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.propose_memory("alpha", "", encode_relation_note("contacts", "x"), "user"); });
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.propose_memory("alpha", "group-x", "@dimension-note/v9/unknown\nx", "user"); });
    const auto reserved = store.list_memories("alpha").front();
    rejected(StoreErrorCode::Conflict, [&] { (void)store.review_memory(reserved.id, reserved.revision, MemoryState::Rejected); });
    rejected(StoreErrorCode::Conflict, [&] { (void)store.edit_memory(reserved.id, reserved.revision, "ordinary replacement"); });
    rejected(StoreErrorCode::Conflict, [&] { store.delete_memory(reserved.id, reserved.revision); });
    rejected(StoreErrorCode::Conflict, [&] { store.apply_memory_changes("alpha", "", {{reserved.id, reserved.revision, std::nullopt}}); });
    ordinary = store.propose_memory("alpha", "", "normal second", "user");
    rejected(StoreErrorCode::InvalidArgument, [&] { (void)store.edit_memory(ordinary.id, ordinary.revision, encode_relation_note("contacts", "x")); });
    saved.values["user-relationship"] = "Explicit relationship";
    auto updated = store.save_relation_notes("alpha", saved.values, saved.revision);
    rejected(StoreErrorCode::Conflict, [&] { (void)store.save_relation_notes("alpha", form, saved.revision); });
    updated.values["contacts"] = " \n ";
    updated = store.save_relation_notes("alpha", updated.values, updated.revision);
    CHECK(updated.values.at("contacts").empty() && !updated.values.at("user-relationship").empty());
    Store reopened(path);
    CHECK(reopened.read_relation_notes("alpha").revision == updated.revision);
    CHECK(reopened.read_relation_notes("alpha").values == updated.values);
    CHECK(reopened.retrieve_memories("alpha", "group-x", "").empty());
}

void failure_and_revision_limits(const fs::path& path) {
    Store store(path); (void)store.create_bot("Alpha", "", "alpha");
    auto saved = store.save_relation_notes("alpha", values("original"), store.read_relation_notes("alpha").revision);
    SqliteFixture sql(path); const auto before = store.archive_snapshot().revision;
    sql.sql("CREATE TRIGGER fail_note_save BEFORE UPDATE ON memories WHEN NEW.text GLOB '@dimension-note/v1/external-bots*' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    rejected(StoreErrorCode::Conflict, [&] { (void)store.save_relation_notes("alpha", values("changed"), saved.revision); });
    CHECK(store.read_relation_notes("alpha").values == saved.values);
    CHECK(store.read_relation_notes("alpha").revision == saved.revision && store.archive_snapshot().revision == before);
    sql.sql("DROP TRIGGER fail_note_save; UPDATE memories SET revision=9223372036854775807 WHERE text GLOB '@dimension-note/v1/external-bots*';");
    saved = store.read_relation_notes("alpha");
    CHECK(store.save_relation_notes("alpha", saved.values, saved.revision).revision == saved.revision);
    rejected(StoreErrorCode::Conflict, [&] { (void)store.save_relation_notes("alpha", values("would overflow"), saved.revision); });
    CHECK(store.read_relation_notes("alpha").values == saved.values);
    saved.values["external-bots"].clear();
    saved = store.save_relation_notes("alpha", saved.values, saved.revision);
    CHECK(saved.values.at("external-bots").empty());
    sql.sql("INSERT INTO memories(bot_id,group_id,text,state,revision,source_actor) VALUES('alpha','','@dimension-note/v1/contacts'||char(10)||'second value','confirmed',1,'user');");
    rejected(StoreErrorCode::Conflict, [&] { (void)store.read_relation_notes("alpha"); });
    rejected(StoreErrorCode::Conflict, [&] { (void)store.save_relation_notes("alpha", values(), saved.revision); });
    const auto ordinary = store.propose_memory("alpha", "", "ordinary cleanup remains available", "user");
    store.delete_memory(ordinary.id, ordinary.revision);
    CHECK(!store.find_memory(ordinary.id));
}

void archive_roundtrip_and_tombstones(const fs::path& path, const fs::path& copy_path) {
    const auto incoming = document(A{note("70", "user-profile", "source user information"), note("71", "contacts", "source contacts")});
    const auto archive = parse(incoming); Store target(path), copy(copy_path);
    CHECK(commit(target, archive, options()).counts.memories_created == 2);
    auto saved = target.read_relation_notes("alpha");
    CHECK(saved.values.at("user-profile") == "source user information" && saved.values.at("user-relationship").empty());
    const auto package = parse_archive_package(export_archive_package(target).dump());
    auto copy_options = options(package.source_id); copy_options.group_conflict = StoreGroupConflict::PreserveExisting;
    CHECK(commit(copy, package.archive, copy_options).counts.memories_created == 2);
    CHECK(copy.read_relation_notes("alpha").values == saved.values);
    saved.values["user-profile"] = "locally updated user information";
    saved = target.save_relation_notes("alpha", saved.values, saved.revision);
    auto reject_replay = options(); reject_replay.memory_conflict = StoreMemoryConflict::Reject;
    CHECK(commit(target, archive, reject_replay).counts.memories_reused == 2);
    CHECK(target.read_relation_notes("alpha").values.at("user-profile") == saved.values.at("user-profile"));
    auto reject_new_source = options("different-source"); reject_new_source.memory_conflict = StoreMemoryConflict::Reject;
    CHECK(!target.prepare_archive_import(archive, reject_new_source).can_commit);
    CHECK(commit(target, archive, options("different-source")).counts.memories_preserved == 2);
    CHECK(target.list_memories("alpha").size() == 2);
    saved.values["contacts"].clear(); saved = target.save_relation_notes("alpha", saved.values, saved.revision);
    CHECK(commit(target, archive, options()).counts.memories_tombstoned == 1);
    CHECK(commit(target, archive, options("different-source")).counts.memories_tombstoned == 1);
    CHECK(target.read_relation_notes("alpha").values.at("contacts").empty());
    SqliteFixture sql(path); CHECK(sql.scalar("SELECT count(*) FROM archive_memory_sources WHERE target_id IS NULL") == "2");
    CHECK(sql.scalar("PRAGMA user_version") == "11");
    auto duplicate = incoming; auto memories = duplicate.at("memories").as_array();
    memories.emplace_back(note("72", "contacts", "different same-field value")); duplicate["memories"] = memories;
    invalid_archive([&] { (void)parse(duplicate); });
    for (const auto* state : {"candidate", "rejected"}) {
        auto item = note("1", "contacts", "x"); item["state"] = state;
        invalid_archive([&] { (void)parse(document(A{item})); });
    }
    auto item = note("1", "contacts", "x"); item["groupId"] = "group-x";
    invalid_archive([&] { (void)parse(document(A{item})); });
    for (const auto* encoded : {"@dimension-note/v2/contacts\nx", "@dimension-note/v1/unknown\nx", "@dimension-note/v1/user-profile\n"}) {
        item = note("1", "contacts", "x"); item["text"] = encoded;
        invalid_archive([&] { (void)parse(document(A{item})); });
    }
}

void concurrent_forms(const fs::path& path) {
    Store first(path); (void)first.create_bot("Alpha", "", "alpha"); Store second(path);
    const auto before = first.read_relation_notes("alpha");
    CHECK(second.read_relation_notes("alpha").revision == before.revision);
    std::barrier start(3); std::atomic<int> accepted = 0, conflicted = 0;
    std::array<std::exception_ptr, 2> failures;
    auto save = [&](Store& store, std::string value, std::size_t index) {
        start.arrive_and_wait();
        try { (void)store.save_relation_notes("alpha", values(std::move(value)), before.revision); ++accepted; }
        catch (const StoreError& error) { if (error.code() == StoreErrorCode::Conflict) ++conflicted; else failures[index] = std::current_exception(); }
        catch (...) { failures[index] = std::current_exception(); }
    };
    std::thread a(save, std::ref(first), "one", 0), b(save, std::ref(second), "two", 1);
    start.arrive_and_wait(); a.join(); b.join();
    for (const auto& failure : failures) if (failure) std::rethrow_exception(failure);
    CHECK(accepted == 1 && conflicted == 1);
    const auto after = first.read_relation_notes("alpha");
    const auto winner = after.values.at("user-profile");
    CHECK(winner == "one" || winner == "two");
    CHECK(after.values == values(winner) && first.list_memories("alpha").size() == 4);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto root = fs::path(argv[1]) / ("relations-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        format_and_semantics(); atomic_save_and_guards(root / "save.db", root / "other.db");
        failure_and_revision_limits(root / "failures.db");
        archive_roundtrip_and_tombstones(root / "import.db", root / "copy.db"); concurrent_forms(root / "race.db");
        std::cout << "relation_notes: " << checks << " checks passed (synthetic private semantic notes)\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
