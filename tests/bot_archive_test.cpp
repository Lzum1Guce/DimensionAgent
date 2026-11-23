#include "dimension/bot_archive.hpp"
#include "dimension/message_context.hpp"
#include "dimension/relation_notes.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <array>
#include <chrono>
#include <filesystem>
#include <iostream>

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
template<class F> void rejected(F action) {
    ++checks;
    try { action(); }
    catch (const ArchiveStageError&) { return; }
    catch (const ArchiveError&) { return; }
    catch (const StoreError&) { return; }
    catch (const ImageAssetError&) { return; }
    throw std::runtime_error("Expected archive rejection");
}
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
        if (!open || !close || !execute) throw std::runtime_error("Missing SQLite ABI");
        const auto bytes = file.u8string(); const std::string path(reinterpret_cast<const char*>(bytes.data()), bytes.size());
        if (open(path.c_str(), &db, 2 | 4 | 0x10000, nullptr)) throw std::runtime_error("Cannot open synthetic fixture");
        sql("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    }
    ~SqliteFixture() { if (db) close(db); if (module) FreeLibrary(module); }
    void sql(const std::string& value) {
        if (execute(db, value.c_str(), nullptr, nullptr, nullptr)) throw std::runtime_error("Fixture SQL failed");
    }
    std::string scalar(const std::string& query) {
        std::string result;
        const auto callback = [](void* p, int n, char** values, char**) -> int {
            if (n == 1) *static_cast<std::string*>(p) = values[0] ? values[0] : "<null>";
            return 0;
        };
        if (execute(db, query.c_str(), callback, &result, nullptr)) throw std::runtime_error("Fixture scalar failed");
        return result;
    }
};
const std::string png64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN8ZqPBwMDAxAAGABBgAU6wYIpsAAAAAElFTkSuQmCC";
std::string decode(std::string_view input) {
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    unsigned value = 0, bits = 0; std::string result;
    for (char c : input) {
        if (c == '=') break;
        value = (value << 6) | static_cast<unsigned>(alphabet.find(c)); bits += 6;
        if (bits >= 8) { bits -= 8; result += static_cast<char>((value >> bits) & 255); }
    }
    return result;
}
const A all{"name", "id", "persona", "chatHistory", "workHistory", "longTermMemory", "relations", "midTermMemory", "avatar"};
const A no_id{"name", "persona", "chatHistory", "workHistory", "longTermMemory", "relations", "midTermMemory", "avatar"};
std::string token(const Json& stage) { return stage.at("token").as_string(); }
std::string target(const Json& stage) { return stage.at("report").at("target").at("id").as_string(); }
Json prepare(BotArchives& archives, const Json& package, const A& fields, bool preserve = false) {
    return archives.stage(O{{"package", package}, {"fields", fields}, {"preserveId", preserve}});
}
Json resign(O package) {
    package.erase("packageSha256"); package["packageSha256"] = source_data_digest(Json(package).dump()); return package;
}
bool issue(const Json& stage, std::string_view code) {
    for (const auto& row : stage.at("report").at("conflicts").as_array()) if (row.at("code").as_string() == code) return true;
    return false;
}
void seed(Store& store, ImageAssets& images) {
    (void)store.create_bot("SECRET_NAME", "SECRET_PERSONA", "sourcebot");
    (void)store.set_roster("sourcebot", Mode::Chat, true);
    const auto source = store.append_message("sourcebot", Mode::Chat, "bot", "SECRET_CHAT");
    (void)store.append_message("sourcebot", Mode::Chat, "user", "SECRET_QUOTE", "", source.id);
    (void)store.append_message("sourcebot", Mode::Chat, "system", "SECRET_SUMMARY");
    (void)store.append_message("sourcebot", Mode::Work, "user", "SECRET_WORK");
    for (const auto state : {MemoryState::Candidate, MemoryState::Confirmed, MemoryState::Rejected}) {
        const auto memory = store.propose_memory("sourcebot", "", "SECRET_MEMORY_" + std::to_string(int(state)), "user");
        if (state != MemoryState::Candidate) (void)store.review_memory(memory.id, memory.revision, state);
    }
    auto relations = store.read_relation_notes("sourcebot"); relations.values["user-profile"] = "SECRET_USER";
    relations.values["external-bots"] = "SECRET_RELATION";
    (void)store.save_relation_notes("sourcebot", relations.values, relations.revision);
    (void)store.add_mid_memory("sourcebot", "", "SECRET_MID_EXPIRED", 2, 1000);
    Group group; group.id = "group-private-exclusion"; group.name = "SECRET_GROUP"; group.owner_id = "sourcebot";
    group.in_chat = true; group.in_work = true;
    group.members = {"sourcebot"}; group.history_members = {"sourcebot"}; group.admins = {"sourcebot"};
    (void)store.create_group(group);
    (void)store.append_message("sourcebot", Mode::Chat, "user", "SECRET_GROUP_HISTORY", group.id);
    (void)store.propose_memory("sourcebot", group.id, "SECRET_GROUP_MEMORY", "user");
    (void)store.add_mid_memory("sourcebot", group.id, "SECRET_GROUP_MID", 2, 1000);
    (void)images.put_avatar(AvatarScope::Bot, "sourcebot", decode(png64), "image/png");
}
void selective_and_validation(const fs::path& root, Store& source, ImageAssets& source_images, const Json& package) {
    BotArchives exporter(source, source_images);
    const auto persona = exporter.export_bot(O{{"botId", "sourcebot"}, {"fields", A{"persona"}}});
    CHECK(persona.at("data").as_object().size() == 1);
    CHECK(persona.dump().find("sourcebot") == std::string::npos);
    CHECK(persona.dump().find("SECRET_MEMORY") == std::string::npos);
    CHECK(persona.at("counts").at("persona").as_number() == 1);
    CHECK(package.at("counts").at("chatHistory").as_number() == 3);
    CHECK(package.at("counts").at("workHistory").as_number() == 1);
    CHECK(package.at("counts").at("longTermMemory").as_number() == 3);
    CHECK(package.at("counts").at("relations").as_number() == 2);
    CHECK(package.at("counts").at("midTermMemory").as_number() == 1);
    CHECK(package.at("counts").at("avatarBytes").as_number() == decode(png64).size());
    CHECK(package.dump().find("SECRET_GROUP") == std::string::npos);
    const auto anonymous = exporter.export_bot(O{{"botId", "sourcebot"}, {"fields", no_id}});
    CHECK(anonymous.dump().find("sourcebot") == std::string::npos);
    CHECK(anonymous.at("data").at("chatHistory").as_array()[1].at("context").at("sources").as_array()[0].at("botId").as_string() == "bot");
    rejected([&] { (void)exporter.export_bot(O{{"botId", "sourcebot"}, {"fields", A{}}}); });
    (void)source.create_bot("No avatar", "", "noavatar");
    rejected([&] { (void)exporter.export_bot(O{{"botId", "noavatar"}, {"fields", A{"avatar"}}}); });
    StoreArchiveSnapshotLimits tiny; tiny.max_record_bytes = 40; tiny.max_messages = 1; tiny.max_memories = 1;
    const auto partial = source.bot_archive_snapshot("sourcebot", StoreBotArchiveFields{}, tiny);
    CHECK(partial.bots.size() == 1 && partial.messages.empty() && partial.memories.empty());
    auto selected = StoreBotArchiveFields{}; selected.chat_history = true;
    rejected([&] { (void)source.bot_archive_snapshot("sourcebot", selected, tiny); });

    Store target_store(root / "selected.sqlite"); ImageAssets images(root / "selected-images"); BotArchives importer(target_store, images);
    const auto preview = prepare(importer, package, {});
    CHECK(!preview.at("report").at("canCommit").as_bool());
    CHECK(preview.at("report").at("counts").at("chatHistory").as_number() == 3);
    CHECK(preview.dump().find("SECRET_") == std::string::npos);
    CHECK(preview.dump().find("sourcebot") == std::string::npos);
    CHECK(target_store.list_bots().empty());
    rejected([&] { (void)importer.commit(token(preview)); }); (void)importer.discard(token(preview));
    const A chosen{"persona", "longTermMemory"};
    const auto stage = prepare(importer, package, chosen);
    CHECK(stage.at("report").at("canCommit").as_bool());
    const auto id = target(stage); CHECK(id != "sourcebot");
    const auto receipt = importer.commit(token(stage));
    CHECK(receipt.at("committed").as_bool() && !receipt.at("idempotent").as_bool());
    CHECK(receipt.dump().find("SECRET_") == std::string::npos);
    CHECK(target_store.find_bot(id)->name == "Imported Bot");
    CHECK(target_store.find_bot(id)->persona == "SECRET_PERSONA");
    CHECK(!target_store.find_bot(id)->in_chat && !target_store.find_bot(id)->in_work);
    CHECK(target_store.list_memories(id).size() == 3);
    CHECK(target_store.messages(id, Mode::Chat).empty() && target_store.messages(id, Mode::Work).empty());
    CHECK(target_store.list_mid_memories(id).empty() && !images.avatar(AvatarScope::Bot, id));
    CHECK(importer.commit(token(stage)).at("idempotent").as_bool());
    (void)target_store.update_bot_profile(id, {}, "EDITED_LOCAL_PERSONA");
    const auto memory = target_store.list_memories(id).front(); target_store.delete_memory(memory.id, memory.revision);
    BotArchives restart(target_store, images);
    const auto replay = prepare(restart, package, chosen);
    CHECK(target(replay) == id && replay.at("report").at("idempotent").as_bool());
    CHECK(restart.commit(token(replay)).at("idempotent").as_bool());
    CHECK(target_store.find_bot(id)->persona == "EDITED_LOCAL_PERSONA");
    CHECK(target_store.list_memories(id).size() == 2 && target_store.list_bots().size() == 1);
    (void)restart.discard(token(replay));
    const auto changed = prepare(restart, package, A{"name"});
    CHECK(changed.at("report").at("canCommit").as_bool() && changed.at("report").at("target").at("newCopy").as_bool());
    CHECK(target(changed) != id);
    (void)restart.commit(token(changed));
    CHECK(target_store.find_bot(target(changed))->name == "SECRET_NAME" && target_store.find_bot(target(changed))->persona.empty());
    CHECK(target_store.find_bot(id)->persona == "EDITED_LOCAL_PERSONA" && target_store.list_memories(id).size() == 2);
    (void)restart.discard(token(changed));
    rejected([&] { (void)prepare(restart, persona, A{"avatar"}); });
    rejected([&] { (void)prepare(restart, package, A{"persona"}, true); });
    rejected([&] { (void)prepare(restart, package, A{"id"}, false); });
    rejected([&] { (void)prepare(restart, package, A{"unknown"}); });
    rejected([&] { (void)prepare(restart, package, A{"persona", "persona"}); });
    auto bad = package.as_object(); bad["sourceKey"] = std::string(64, 'a');
    rejected([&] { (void)prepare(restart, bad, {}); });
    bad = package.as_object(); bad["extra"] = "unsupported";
    rejected([&] { (void)prepare(restart, resign(bad), {}); });
    bad = package.as_object(); auto data = bad.at("data").as_object(); auto records = data.at("longTermMemory").as_array();
    auto row = records.front().as_object(); row["groupId"] = "cannot-change-scope"; records[0] = row;
    data["longTermMemory"] = records; bad["data"] = data;
    rejected([&] { (void)prepare(restart, resign(bad), {}); });
    bad = package.as_object(); auto counted = bad.at("counts").as_object(); counted["chatHistory"] = 2; bad["counts"] = counted;
    rejected([&] { (void)prepare(restart, resign(bad), {}); });
    for (const auto field : {"base64", "mime", "byteSize", "width"}) {
        bad = package.as_object(); data = bad.at("data").as_object(); auto avatar = data.at("avatar").as_object();
        if (std::string_view(field) == "base64") avatar[field] = "AAAA";
        else if (std::string_view(field) == "mime") avatar[field] = "image/jpeg";
        else avatar[field] = 100;
        data["avatar"] = avatar; bad["data"] = data;
        rejected([&] { (void)prepare(restart, resign(bad), {}); });
    }
    CHECK(target_store.list_bots().size() == 2 && target_store.list_memories(id).size() == 2);
}
void complete_roundtrip(const fs::path& root, const Json& package) {
    const auto path = root / "complete.sqlite"; std::string imported;
    {
        Store store(path); ImageAssets images(root / "complete-images"); BotArchives importer(store, images);
        const auto stage = prepare(importer, package, no_id); imported = target(stage);
        CHECK(stage.at("report").at("canCommit").as_bool());
        (void)importer.commit(token(stage));
        CHECK(store.find_bot(imported)->name == "SECRET_NAME" && store.find_bot(imported)->persona == "SECRET_PERSONA");
        CHECK(store.messages(imported, Mode::Chat).size() == 3 && store.messages(imported, Mode::Work).size() == 1);
        const auto messages = store.messages(imported, Mode::Chat);
        CHECK(messages[1].context && messages[1].context->sources[0].bot_id == imported);
        CHECK(store.list_memories(imported).size() == 5);
        CHECK(store.read_relation_notes(imported).values.at("external-bots") == "SECRET_RELATION");
        CHECK(store.list_mid_memories(imported).size() == 1);
        const auto mid = store.list_mid_memories(imported).front();
        CHECK(mid.created_at_ms == 1000 && mid.expires_at_ms == 1000 + 2LL * 86400000);
        CHECK(images.read_avatar(AvatarScope::Bot, imported).bytes == decode(png64));
        CHECK(store.list_groups().empty());
        store.remove_bot(imported, Mode::Chat);
        for (const auto& memory : store.list_memories(imported))
            if (!is_relation_note_text(memory.text)) store.delete_memory(memory.id, memory.revision);
        auto cleared = store.read_relation_notes(imported);
        for (auto& [key, value] : cleared.values) { (void)key; value.clear(); }
        (void)store.save_relation_notes(imported, cleared.values, cleared.revision);
        store.apply_mid_memory_changes(imported, "", {{mid.id, mid.revision, std::nullopt}});
        CHECK(images.remove_avatar(AvatarScope::Bot, imported));
    }
    {
        Store store(path); ImageAssets images(root / "complete-images"); BotArchives importer(store, images);
        const auto replay = prepare(importer, package, no_id);
        CHECK(target(replay) == imported);
        const auto result = importer.commit(token(replay)); CHECK(result.at("idempotent").as_bool());
        CHECK(store.list_bots().size() == 1 && store.messages(imported, Mode::Chat).empty());
        CHECK(store.messages(imported, Mode::Work).size() == 1);
        CHECK(store.list_memories(imported).empty() && store.list_mid_memories(imported).empty());
        CHECK(!images.avatar(AvatarScope::Bot, imported));
        CHECK(result.at("report").at("importCounts").at("messagesTombstoned").as_number() == 3);
        CHECK(result.at("report").at("importCounts").at("memoriesTombstoned").as_number() == 5);
        CHECK(result.at("report").at("importCounts").at("midMemoriesTombstoned").as_number() == 1);
    }
    Store same_id(root / "same-id.sqlite"); ImageAssets same_images(root / "same-id-images"); BotArchives preserving(same_id, same_images);
    const auto keep = prepare(preserving, package, all, true); CHECK(target(keep) == "sourcebot");
    (void)preserving.commit(token(keep)); CHECK(same_id.find_bot("sourcebot").has_value());
    Store conflict(root / "id-conflict.sqlite"); ImageAssets conflict_images(root / "conflict-images"); BotArchives conflicting(conflict, conflict_images);
    (void)conflict.create_bot("Unrelated", "UNRELATED_PERSONA", "sourcebot");
    const auto blocked = prepare(conflicting, package, all, true);
    CHECK(!blocked.at("report").at("canCommit").as_bool() && issue(blocked, "bot_archive_id_exists"));
    rejected([&] { (void)conflicting.commit(token(blocked)); });
    CHECK(conflict.find_bot("sourcebot")->persona == "UNRELATED_PERSONA" && conflict.list_memories("sourcebot").empty());
    const auto switched = prepare(conflicting, package, no_id); CHECK(switched.at("report").at("canCommit").as_bool());
    (void)conflicting.commit(token(switched)); CHECK(conflict.list_bots().size() == 2);
}
void atomic_failures_and_capacity(const fs::path& root, const Json& package) {
    const auto file = root / "atomic.sqlite";
    Store store(file); ImageAssets images(root / "atomic-images"); BotArchives importer(store, images);
    const auto stage = prepare(importer, package, no_id); const auto id = target(stage);
    SqliteFixture fixture(file);
    // Fail at the final receipt write, after Bot/history/memory/avatar work,
    // proving that the complete batch and the newly owned image roll back.
    fixture.sql("CREATE TRIGGER synthetic_bot_failure BEFORE INSERT ON bot_archive_receipts BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;");
    rejected([&] { (void)importer.commit(token(stage)); });
    CHECK(store.list_bots().empty() && !images.avatar(AvatarScope::Bot, id));
    CHECK(fixture.scalar("SELECT count(*) FROM bot_archive_receipts") == "0");
    CHECK(fixture.scalar("SELECT count(*) FROM archive_memory_sources") == "0");
    CHECK(fixture.scalar("SELECT count(*) FROM messages") == "0");
    CHECK(fixture.scalar("SELECT count(*) FROM memories") == "0");
    CHECK(fixture.scalar("SELECT count(*) FROM mid_memories") == "0");
    fixture.sql("DROP TRIGGER synthetic_bot_failure;");
    CHECK(importer.commit(token(stage)).at("committed").as_bool());
    CHECK(images.avatar(AvatarScope::Bot, id).has_value());
    CHECK(fixture.scalar("PRAGMA user_version") == "11");

    Store limited(root / "image-capacity.sqlite"); ImageAssetLimits caps; caps.max_avatars = 1;
    ImageAssets limited_images(root / "limited-images", caps); BotArchives bounded(limited, limited_images);
    (void)limited_images.put_avatar(AvatarScope::Bot, "occupied", decode(png64), "image/png");
    const auto full = prepare(bounded, package, no_id);
    rejected([&] { (void)bounded.commit(token(full)); });
    CHECK(limited.list_bots().empty() && !limited_images.avatar(AvatarScope::Bot, target(full)));
    CHECK(limited_images.remove_avatar(AvatarScope::Bot, "occupied"));
    CHECK(bounded.commit(token(full)).at("committed").as_bool());

    Store stale(root / "stale.sqlite"); ImageAssets stale_images(root / "stale-images"); BotArchives stale_import(stale, stale_images);
    const auto preview = prepare(stale_import, package, no_id);
    (void)stale.create_bot("Other", "", "other");
    rejected([&] { (void)stale_import.commit(token(preview)); });
    CHECK(stale.list_bots().size() == 1 && !stale.find_bot(target(preview)));
    CHECK(!stale_images.avatar(AvatarScope::Bot, target(preview)));
    (void)stale_import.discard(token(preview));
    A tokens;
    for (int i = 0; i < 4; ++i) tokens.emplace_back(token(prepare(stale_import, package, {})));
    rejected([&] { (void)prepare(stale_import, package, {}); });
    for (const auto& key : tokens) CHECK(stale_import.discard(key.as_string()));
    const auto available = prepare(stale_import, package, {});
    CHECK(!available.at("report").at("canCommit").as_bool());
    rejected([&] { (void)stale_import.commit("../invalid"); });
}

void schema_six_upgrade(const fs::path& root) {
    const auto path = root / "schema-six.sqlite";
    { Store original(path); (void)original.create_bot("Kept", "Kept persona", "kept"); }
    { SqliteFixture old(path); old.sql("DROP TABLE message_deletions; DROP TABLE bot_archive_receipts; PRAGMA user_version=6;"); }
    {
        Store upgraded(path); CHECK(upgraded.find_bot("kept")->persona == "Kept persona");
        SqliteFixture current(path); CHECK(current.scalar("PRAGMA user_version") == "11");
        CHECK(current.scalar("SELECT count(*) FROM bot_archive_receipts") == "0");
        CHECK(current.scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name GLOB 'store_revision_bot_archive_receipts_*'") == "3");
    }
}

void live_work_text(Store& source, ImageAssets& images) {
    int calls = 0;
    BotArchives archives(source, images, [&](std::string_view bot) {
        ++calls;
        return std::vector<Message>{{0, std::string(bot), "", Mode::Work, "user", "ACTUAL_WORK_INPUT", 100},
                                    {0, std::string(bot), "", Mode::Work, "bot", "ACTUAL_WORK_ANSWER", 101}};
    });
    const auto profile = archives.export_bot(O{{"botId", "sourcebot"}, {"fields", A{"persona"}}});
    CHECK(calls == 0 && profile.dump().find("ACTUAL_WORK") == std::string::npos);
    const auto work = archives.export_bot(O{{"botId", "sourcebot"}, {"fields", A{"workHistory"}}});
    CHECK(calls == 1 && work.at("counts").at("workHistory").as_number() == 3);
    const auto& rows = work.at("data").at("workHistory").as_array();
    CHECK(rows[0].at("text").as_string() == "SECRET_WORK");
    CHECK(rows[1].at("text").as_string() == "ACTUAL_WORK_INPUT" && rows[2].at("text").as_string() == "ACTUAL_WORK_ANSWER");
    CHECK(rows[0].at("id").as_string() == "1" && rows[2].at("id").as_string() == "3");
    CHECK(work.dump() == archives.export_bot(O{{"botId", "sourcebot"}, {"fields", A{"workHistory"}}}).dump());
    BotArchives scope_error(source, images, [](std::string_view) {
        return std::vector<Message>{{0, "otherbot", "", Mode::Work, "user", "wrong scope", 100}};
    });
    rejected([&] { (void)scope_error.export_bot(O{{"botId", "sourcebot"}, {"fields", A{"workHistory"}}}); });
    BotArchives over_count(source, images, [](std::string_view bot) {
        return std::vector<Message>(20000, Message{0, std::string(bot), "", Mode::Work, "user", "x", 100});
    });
    rejected([&] { (void)over_count.export_bot(O{{"botId", "sourcebot"}, {"fields", A{"workHistory"}}}); });
    BotArchives over_bytes(source, images, [](std::string_view bot) {
        return std::vector<Message>{{0, std::string(bot), "", Mode::Work, "user", std::string(4U * 1024U * 1024U + 1, 'x'), 100}};
    });
    rejected([&] { (void)over_bytes.export_bot(O{{"botId", "sourcebot"}, {"fields", A{"workHistory"}}}); });
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::path(argv[1]) / ("bot-archive-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        Store source(root / "source.sqlite"); ImageAssets images(root / "source-images"); seed(source, images);
        BotArchives exporter(source, images); const auto package = exporter.export_bot(O{{"botId", "sourcebot"}, {"fields", all}});
        selective_and_validation(root, source, images, package);
        complete_roundtrip(root, package);
        atomic_failures_and_capacity(root, package);
        schema_six_upgrade(root);
        live_work_text(source, images);
        std::cout << "bot_archive: " << checks << " checks passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
