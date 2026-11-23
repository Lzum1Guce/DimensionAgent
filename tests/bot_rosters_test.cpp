#include "dimension/archive_export.hpp"
#include "dimension/relation_notes.hpp"
#include "dimension/runs.hpp"
#include "dimension/store.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <thread>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
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

// Synthetic fixture only; inject a real SQLite deletion failure to verify that
// roster detachment, logs, receipt tombstones and Store revision roll back.
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
};

void seed(Store& store) {
    (void)store.create_bot("Alpha", "Separate persona", "alpha");
    (void)store.create_bot("Beta", "Other identity", "beta");
    (void)store.set_roster("alpha", Mode::Chat, true);
    (void)store.set_roster("alpha", Mode::Work, true);
    (void)store.set_roster("beta", Mode::Chat, true);
    Group group;
    group.id = "team:1"; group.name = "Independent group"; group.owner_id = "alpha";
    group.members = {"alpha", "beta"}; group.history_members = group.members;
    group.in_chat = group.in_work = true;
    group.seal_shape = "circle"; group.seal_color = "violet";
    (void)store.create_group(group);
    (void)store.append_message_once("alpha", Mode::Chat, "user", "Private Chat", "", "chat-1");
    (void)store.append_message_once("alpha", Mode::Work, "bot", "Private Work", "", "work-1");
    (void)store.append_message_once("alpha", Mode::Chat, "user", "Group Chat", "team:1", "chat-1");
    (void)store.append_message_once("alpha", Mode::Work, "bot", "Group Work", "team:1", "work-1");
    (void)store.append_message("beta", Mode::Chat, "user", "Other Bot");
    (void)store.propose_memory("alpha", "", "Private memory", "user");
    auto memory = store.propose_memory("alpha", "team:1", "Group memory", "user");
    (void)store.review_memory(memory.id, memory.revision, MemoryState::Confirmed);
    auto notes = store.read_relation_notes("alpha");
    notes.values["contacts"] = "Independent contact note";
    (void)store.save_relation_notes("alpha", notes.values, notes.revision);
}
void preserved(Store& store) {
    CHECK(store.find_bot("alpha")->name == "Alpha");
    CHECK(store.find_bot("alpha")->persona == "Separate persona");
    CHECK(store.messages("alpha", Mode::Chat, "team:1").size() == 1);
    CHECK(store.messages("alpha", Mode::Work, "team:1").size() == 1);
    CHECK(store.messages("beta", Mode::Chat).size() == 1);
    CHECK(store.find_bot("beta")->in_chat);
    CHECK(store.list_memories("alpha").size() == 3);
    CHECK(store.read_relation_notes("alpha").values.at("contacts") == "Independent contact note");
    CHECK(store.find_group("team:1")->in_chat && store.find_group("team:1")->in_work);
    CHECK(!store.find_group("team:1")->deleted);
}

void mode_isolation(const fs::path& path) {
    Id work_id{};
    {
        Store store(path); seed(store);
        const auto notes_revision = store.read_relation_notes("alpha").revision;
        auto bot = store.set_roster("alpha", Mode::Chat, false);
        CHECK(!bot.in_chat && bot.in_work);
        CHECK(store.messages("alpha", Mode::Chat).size() == 1);
        CHECK(store.messages("alpha", Mode::Work).size() == 1);
        bot = store.set_roster("alpha", Mode::Work, false);
        CHECK(!bot.in_chat && !bot.in_work);
        CHECK(store.messages("alpha", Mode::Chat).size() == 1);
        CHECK(store.messages("alpha", Mode::Work).size() == 1);
        CHECK(store.list_bots().size() == 2);
        (void)store.set_roster("alpha", Mode::Chat, true);
        (void)store.set_roster("alpha", Mode::Work, true);
        work_id = store.messages("alpha", Mode::Work).front().id;
        store.remove_bot("alpha", Mode::Chat);
        CHECK(!store.find_bot("alpha")->in_chat && store.find_bot("alpha")->in_work);
        CHECK(store.messages("alpha", Mode::Chat).empty());
        CHECK(store.messages("alpha", Mode::Work).front().id == work_id);
        CHECK(store.read_relation_notes("alpha").revision == notes_revision);
        rejected(StoreErrorCode::Conflict, [&] {
            (void)store.append_message_once("alpha", Mode::Chat, "user", "Private Chat", "", "chat-1");
        });
        CHECK(store.append_message_once("alpha", Mode::Work, "bot", "Private Work", "", "work-1").id == work_id);
        preserved(store);
    }
    {
        Store store(path);
        CHECK(!store.find_bot("alpha")->in_chat && store.find_bot("alpha")->in_work);
        CHECK(store.messages("alpha", Mode::Chat).empty());
        CHECK(store.messages("alpha", Mode::Work).front().id == work_id);
        (void)store.set_roster("alpha", Mode::Chat, true);
        (void)store.append_message_once("alpha", Mode::Chat, "user", "New Chat", "", "chat-2");
        store.remove_bot("alpha", Mode::Work);
        CHECK(store.find_bot("alpha")->in_chat && !store.find_bot("alpha")->in_work);
        CHECK(store.messages("alpha", Mode::Chat).front().text == "New Chat");
        CHECK(store.messages("alpha", Mode::Work).empty());
        rejected(StoreErrorCode::Conflict, [&] {
            (void)store.append_message_once("alpha", Mode::Work, "bot", "Private Work", "", "work-1");
        });
        preserved(store);
        const auto before = store.archive_snapshot().revision;
        rejected(StoreErrorCode::InvalidArgument, [&] { store.remove_bot("alpha", static_cast<Mode>(42)); });
        rejected(StoreErrorCode::NotFound, [&] { store.remove_bot("missing", Mode::Chat); });
        rejected(StoreErrorCode::InvalidArgument, [&] { store.remove_bot("../alpha", Mode::Work); });
        CHECK(store.archive_snapshot().revision == before);
        (void)store.set_roster("alpha", Mode::Work, true);
        (void)store.append_message("alpha", Mode::Work, "user", "New Work");
        store.remove_bot("alpha");
        CHECK(!store.find_bot("alpha")->in_chat && !store.find_bot("alpha")->in_work);
        CHECK(store.messages("alpha", Mode::Chat).empty());
        CHECK(store.messages("alpha", Mode::Work).empty());
        preserved(store);
    }
}

void rollback(const fs::path& path) {
    Store store(path); seed(store); SqliteFixture sql(path);
    const auto before = store.archive_snapshot().revision;
    sql.sql("CREATE TRIGGER fail_private_delete BEFORE DELETE ON messages WHEN OLD.bot_id='alpha' "
        "AND OLD.group_id='' AND OLD.mode='chat' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    rejected(StoreErrorCode::Conflict, [&] { store.remove_bot("alpha", Mode::Chat); });
    CHECK(store.find_bot("alpha")->in_chat && store.find_bot("alpha")->in_work);
    CHECK(store.messages("alpha", Mode::Chat).size() == 1);
    CHECK(store.messages("alpha", Mode::Work).size() == 1);
    CHECK(store.append_message_once("alpha", Mode::Chat, "user", "Private Chat", "", "chat-1").id ==
          store.messages("alpha", Mode::Chat).front().id);
    CHECK(store.archive_snapshot().revision == before);
    preserved(store);
    sql.sql("DROP TRIGGER fail_private_delete;");
    store.remove_bot("alpha", Mode::Chat);
    CHECK(store.messages("alpha", Mode::Chat).empty());
}

void source_tombstones(const fs::path& source_path, const fs::path& target_path) {
    Store source(source_path); seed(source);
    const auto package = parse_archive_package(export_archive_package(source).dump());
    StoreImportOptions options{package.source_id, StoreBotConflict::PreserveExisting,
                               StoreMemoryConflict::PreserveExisting, StoreGroupConflict::PreserveExisting};
    Store target(target_path);
    auto apply = [&] {
        const auto plan = target.prepare_archive_import(package.archive, options); CHECK(plan.can_commit);
        return target.commit_archive_import(package.archive, options, plan.target_revision, plan.digest);
    };
    CHECK(apply().counts.messages_created == 5);
    target.remove_bot("alpha", Mode::Chat);
    auto replay = apply();
    CHECK(replay.counts.messages_tombstoned == 1 && replay.counts.messages_reused == 4);
    CHECK(replay.counts.messages_created == 0 && replay.counts.memories_reused == 3);
    CHECK(!target.find_bot("alpha")->in_chat && target.find_bot("alpha")->in_work);
    CHECK(target.messages("alpha", Mode::Chat).empty());
    CHECK(target.messages("alpha", Mode::Work).size() == 1);
    preserved(target);
    (void)target.set_roster("alpha", Mode::Chat, true);
    target.remove_bot("alpha", Mode::Work);
    replay = apply();
    CHECK(replay.counts.messages_tombstoned == 2 && replay.counts.messages_reused == 3);
    CHECK(replay.counts.messages_created == 0);
    CHECK(target.find_bot("alpha")->in_chat && !target.find_bot("alpha")->in_work);
    CHECK(target.messages("alpha", Mode::Work).empty());
    preserved(target);
}

RunOptions run_options(bool paused = false) {
    RunOptions options; options.require_verified_finish = false; options.start_paused = paused; return options;
}
RunCallbacks callbacks() {
    RunCallbacks result;
    result.configuration = [](const RunExecutionContext&) { ModelConfig c; c.model = "synthetic"; return c; };
    result.model = [](const ModelConfig&, const std::vector<ModelMessage>&, const std::vector<ModelTool>&,
                      ModelChunk, std::stop_token) { return ModelReply{"synthetic answer", {}, 1, 1}; };
    return result;
}
void complete_activity(const fs::path& path) {
    RunService service(path, callbacks(), run_options(true));
    const auto old = service.submit("alpha", "", "older active task", "old", true);
    std::this_thread::sleep_for(2ms);
    for (int i = 0; i < 60; ++i) {
        const auto newer = service.submit("alpha", "", "newer completed history", "new-" + std::to_string(i), true);
        (void)service.cancel(newer.run_id);
    }
    const auto page = service.list("alpha", "", 50);
    CHECK(page.as_array().size() == 50);
    CHECK(std::all_of(page.as_array().begin(), page.as_array().end(), [](const auto& run) {
        return run.at("terminal").as_bool();
    }));
    CHECK(service.has_bot_activity("alpha"));
    CHECK(!service.has_bot_activity("beta"));
    for (int i = 0; i < 105; ++i)
        (void)service.submit("alpha", "", "additional queued task", "queue-" + std::to_string(i), true);
    const auto group = service.submit("alpha", "team:1", "group task", "group", true);
    const auto other = service.submit("beta", "", "other Bot task", "other", true);
    service.cancel_private_bot("alpha");
    CHECK(service.brief_json(old.run_id).at("status").as_string() == "cancelled");
    CHECK(service.brief_json(group.run_id).at("status").as_string() == "queued");
    CHECK(service.brief_json(other.run_id).at("status").as_string() == "queued");
    CHECK(service.has_bot_activity("alpha") && service.has_bot_activity("beta"));
    const auto all = service.list("alpha", "", 1000);
    for (const auto& run : all.as_array())
        if (run.at("groupId").as_string().empty()) CHECK(run.at("terminal").as_bool());
    (void)service.cancel(group.run_id);
    CHECK(!service.has_bot_activity("alpha"));
    service.cancel_private_bot("beta");
    CHECK(!service.has_bot_activity("beta"));
    service.cancel_private_bot("missing");
    CHECK(!service.has_bot_activity("missing"));
}

void callback_unwind(const fs::path& chat_path, const fs::path& work_path) {
    std::mutex mutex; std::condition_variable condition; bool entered = false, release = false;
    std::atomic<bool> readable_stop{};
    RunService* chat_pointer{};
    auto injected = callbacks();
    injected.model = [&](const ModelConfig&, const std::vector<ModelMessage>&, const std::vector<ModelTool>&,
                         ModelChunk, std::stop_token stop) {
        std::stop_callback on_stop(stop, [&] { readable_stop = chat_pointer->has_bot_activity("alpha"); });
        std::unique_lock lock(mutex); entered = true; condition.notify_all();
        if (!condition.wait_for(lock, 5s, [&] { return release; })) throw std::runtime_error("fixture gate timeout");
        return ModelReply{"late callback result", {}, 1, 1};
    };
    RunService work(work_path, callbacks(), run_options(true));
    const auto work_run = work.submit("alpha", "", "independent Work", "work", true);
    RunService chat(chat_path, injected, run_options(true)); chat_pointer = &chat;
    const auto run = chat.submit("alpha", "", "private Chat", "chat", true); chat.start();
    {
        std::unique_lock lock(mutex);
        CHECK(condition.wait_for(lock, 5s, [&] { return entered; }));
    }
    chat.cancel_private_bot("alpha");
    CHECK(readable_stop.load());
    CHECK(chat.brief_json(run.run_id).at("terminal").as_bool());
    CHECK(chat.brief_json(run.run_id).at("executing").as_bool());
    CHECK(chat.has_bot_activity("alpha"));
    CHECK(work.has_bot_activity("alpha"));
    CHECK(work.brief_json(work_run.run_id).at("status").as_string() == "queued");
    { std::lock_guard lock(mutex); release = true; condition.notify_all(); }
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (chat.has_bot_activity("alpha") && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(2ms);
    CHECK(!chat.has_bot_activity("alpha"));
    CHECK(chat.brief_json(run.run_id).at("status").as_string() == "cancelled");
    CHECK(work.has_bot_activity("alpha"));
    work.cancel_private_bot("alpha");
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto root = fs::path(argv[1]) / ("bot-rosters-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        mode_isolation(root / "modes.db"); rollback(root / "rollback.db");
        source_tombstones(root / "source.db", root / "target.db");
        complete_activity(root / "history-runs"); callback_unwind(root / "chat-runs", root / "work-runs");
        std::cout << "bot_rosters: " << checks << " checks passed (synthetic mode isolation and worker lifecycle)\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
