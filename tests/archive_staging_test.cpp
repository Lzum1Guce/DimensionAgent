#include "dimension/archive_staging.hpp"
#include "dimension/archive_export.hpp"
#include <atomic>
#include <barrier>
#include <chrono>
#include <filesystem>
#include <future>
#include <iostream>
#include <thread>

using namespace dimension;
namespace {
using O = Json::Object;
using A = Json::Array;
std::size_t checks{};
void check(bool condition, const char* message) {
    ++checks;
    if (!condition) throw std::runtime_error(message);
}
template<class F> void stage_error(int status, F action) {
    ++checks;
    try { action(); }
    catch (const ArchiveStageError& error) {
        if (error.status() == status) return;
        throw std::runtime_error("Wrong staging error status");
    }
    throw std::runtime_error("Expected staging error");
}
template<class F> void conflict(F action) {
    ++checks;
    try { action(); }
    catch (const StoreError& error) {
        if (error.code() == StoreErrorCode::Conflict) return;
        throw;
    }
    throw std::runtime_error("Expected stale target conflict");
}
O request(const std::string& id, const std::string& source = "unit-source") {
    return O{{"sourceId", source},
             {"policies", O{{"bots", "preserve-existing"}, {"memories", "preserve-existing"}}},
             {"archive", O{{"format", "dimension-conversation-archive"}, {"version", 1},
                 {"coverage", "conversation-data-only"},
                 {"excludedTypes", A{"work-runs", "tool-receipts", "message-receipts", "artifacts",
                                     "plugins", "accounts", "provider-settings", "group-metadata"}},
                 {"bots", A{O{{"id", id}, {"name", "测试角色"}, {"persona", "PRIVATE_PERSONA"},
                                {"inChat", true}, {"inWork", false}}}},
                 {"conversations", A{O{{"botId", id}, {"groupId", ""}, {"mode", "chat"},
                     {"messages", A{O{{"id", "9007199254740993"}, {"actor", "user"},
                                      {"text", "PRIVATE_MESSAGE中文"}, {"createdAtMs", "0"}}}}}}},
                 {"memories", A{O{{"id", "9007199254740995"}, {"botId", id}, {"groupId", ""},
                                   {"text", "PRIVATE_MEMORY"}, {"state", "confirmed"},
                                   {"revision", "9007199254740999"}, {"sourceActor", "user"}}}}}}};
}
std::string token(const Json& response) { return response.at("token").as_string(); }
double count(const Json& response, const char* name) {
    return response.at("report").at("counts").at(name).as_number();
}

void lifecycle(const std::filesystem::path& root) {
    Store store(root / "lifecycle.sqlite");
    ArchiveStaging staging(store);
    auto payload = Json(request("alpha")).dump();
    const auto prepared = staging.stage(payload);
    payload.assign("changed after staging");
    check(prepared.at("staged").as_bool() && !prepared.at("dataChanged").as_bool(), "Prepare is non-mutating");
    check(store.list_bots().empty(), "No records before commit");
    check(prepared.dump().find("PRIVATE_") == std::string::npos, "Stage reports contain no private bodies");
    check(prepared.at("report").at("canCommit").as_bool(), "Valid new archive can commit");
    check(prepared.at("report").at("targetRevision").is_string(), "Revision uses exact decimal string");
    const auto committed = staging.commit(token(prepared));
    check(committed.at("committed").as_bool() && !committed.at("replayed").as_bool(), "First commit marked durable");
    check(count(committed, "messagesCreated") == 1 && count(committed, "memoriesCreated") == 1, "Complete archive committed");
    check(store.messages("alpha", Mode::Chat).front().created_at_ms == 0, "Frozen source preserves epoch zero");
    check(store.list_memories("alpha").front().revision == 9007199254740999LL, "Source memory precision preserved");
    const auto replay = staging.commit(token(prepared));
    check(replay.at("replayed").as_bool(), "Same token replay identified");
    check(replay.at("report").at("countsDescribe").as_string() == "original-commit", "Replay counts describe receipt");
    check(store.messages("alpha", Mode::Chat).size() == 1, "Replay creates no duplicate");
    check(committed.dump().find("PRIVATE_") == std::string::npos, "Commit receipt omits record text");
    const auto removed = staging.discard(token(prepared));
    check(removed.at("committed").as_bool() && !removed.at("dataChanged").as_bool(), "Discard committed receipt does not claim rollback");
    stage_error(404, [&] { (void)staging.commit(token(prepared)); });
    ArchiveStaging restarted(store);
    const auto fresh = restarted.stage(Json(request("alpha")).dump());
    check(count(fresh, "messagesCreated") == 0 && count(fresh, "messagesReused") == 1, "Fresh stage finds durable origin mapping");
    const auto fresh_commit = restarted.commit(token(fresh));
    check(count(fresh_commit, "memoriesCreated") == 0, "Fresh token also deduplicates memory");
}

void bounds_and_validation(const std::filesystem::path& root) {
    Store store(root / "bounds.sqlite");
    const auto payload = Json(request("alpha")).dump();
    ArchiveStageLimits limits;
    limits.max_stages = 1;
    limits.max_source_bytes = payload.size();
    ArchiveStaging staging(store, limits);
    auto invalid = request("alpha");
    invalid.erase("policies");
    stage_error(400, [&] { (void)staging.stage(Json(invalid).dump()); });
    invalid = request("alpha");
    invalid["policies"] = O{{"bots", "preserve-existing"}, {"memories", "overwrite"}};
    stage_error(400, [&] { (void)staging.stage(Json(invalid).dump()); });
    const auto first = staging.stage(payload);
    stage_error(429, [&] { (void)staging.stage(payload); });
    stage_error(400, [&] { (void)staging.commit("../path"); });
    stage_error(400, [&] { (void)staging.discard(std::string(32, 'X')); });
    stage_error(404, [&] { (void)staging.commit(std::string(32, '0')); });
    check(!staging.discard(token(first)).at("committed").as_bool(), "Discard untouched stage reports no commit");
    check(store.list_bots().empty(), "Discard does not import");
    const auto second = staging.stage(payload);
    check(token(second) != token(first), "New stage has fresh identity");
    (void)staging.commit(token(second));
    stage_error(429, [&] { (void)staging.stage(payload); }); // Receipts also count toward the slot cap.
    (void)staging.discard(token(second));
    check(staging.stage(payload).at("staged").as_bool(), "Discard frees capacity");

    limits.max_stages = 4;
    limits.max_source_bytes = payload.size();
    ArchiveStaging bytes(store, limits);
    const auto bytes_stage = bytes.stage(payload);
    stage_error(429, [&] { (void)bytes.stage(payload); });
    (void)bytes.commit(token(bytes_stage));
    check(bytes.stage(payload).at("staged").as_bool(), "Commit releases retained source bytes");
    limits.max_request_bytes = payload.size() - 1;
    ArchiveStaging smaller(store, limits);
    stage_error(413, [&] { (void)smaller.stage(payload); });

    limits = {};
    limits.lifetime = std::chrono::milliseconds(25);
    ArchiveStaging expiring(store, limits);
    const auto expires = expiring.stage(payload);
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    stage_error(410, [&] { (void)expiring.commit(token(expires)); });
    check(expiring.stage(payload).at("staged").as_bool(), "Expired entries release capacity");
}

void conflicts_and_guards(const std::filesystem::path& root) {
    Store store(root / "conflicts.sqlite");
    bool blocked = false;
    ArchiveStaging staging(store, {}, [&](const ArchiveDocument&) {
        if (blocked) throw ArchiveStageError(409, "test_guard", "Application identity conflict");
    });
    const auto first = staging.stage(Json(request("alpha")).dump());
    blocked = true;
    stage_error(409, [&] { (void)staging.commit(token(first)); });
    check(store.list_bots().empty(), "Commit rechecks trusted application guard before Store writes");
    blocked = false;
    Store other(root / "conflicts.sqlite");
    (void)other.create_bot("Unrelated concurrent change", "", "other");
    conflict([&] { (void)staging.commit(token(first)); });
    check(!store.find_bot("alpha"), "Stale stage commits no new identity");
    (void)staging.discard(token(first));
    const auto refreshed = staging.stage(Json(request("alpha")).dump());
    (void)staging.commit(token(refreshed));
    auto rejected = request("alpha");
    auto archive = rejected.at("archive").as_object();
    auto bots = archive.at("bots").as_array();
    auto bot = bots.front().as_object(); bot["name"] = "Different"; bots.front() = std::move(bot);
    archive["bots"] = std::move(bots); rejected["archive"] = std::move(archive);
    rejected["policies"] = O{{"bots", "reject-conflicts"}, {"memories", "preserve-existing"}};
    const auto conflict_stage = staging.stage(Json(rejected).dump());
    check(!conflict_stage.at("report").at("canCommit").as_bool(), "Conflict is reviewable before commit");
    stage_error(409, [&] { (void)staging.commit(token(conflict_stage)); });
    check(store.find_bot("alpha")->name == "测试角色", "Reject never overwrites existing bot");
    ArchiveStaging another(store);
    stage_error(404, [&] { (void)another.commit(token(refreshed)); });
}

void staged_concurrency(const std::filesystem::path& root) {
    Store store(root / "concurrent.sqlite");
    ArchiveStaging staging(store);
    const auto staged = staging.stage(Json(request("alpha")).dump());
    const auto id = token(staged);
    std::barrier begin(3);
    auto commit = [&] { begin.arrive_and_wait(); return staging.commit(id); };
    auto a = std::async(std::launch::async, commit);
    auto b = std::async(std::launch::async, commit);
    begin.arrive_and_wait();
    const auto ar = a.get(), br = b.get();
    check(ar.at("replayed").as_bool() != br.at("replayed").as_bool(), "Concurrent commits produce one operation and one receipt");
    check(store.messages("alpha", Mode::Chat).size() == 1, "Concurrent retry does not duplicate");

    const auto next = staging.stage(Json(request("beta", "race-source")).dump());
    const auto next_id = token(next);
    std::barrier race(3);
    auto committing = std::async(std::launch::async, [&] {
        race.arrive_and_wait();
        try { (void)staging.commit(next_id); return true; }
        catch (const ArchiveStageError& error) { if (error.status() == 404) return false; throw; }
    });
    auto discarding = std::async(std::launch::async, [&] { race.arrive_and_wait(); return staging.discard(next_id); });
    race.arrive_and_wait();
    const auto did_commit = committing.get();
    const auto discarded = discarding.get();
    check(discarded.at("committed").as_bool() == did_commit, "Racing discard reports whether durable commit won");
    check(store.find_bot("beta").has_value() == did_commit, "Discard/commit race has exactly one linearized outcome");
}
void package_lifecycle(const std::filesystem::path& root) {
    Store source(root / "package-source.sqlite"), target(root / "package-target.sqlite");
    (void)source.create_bot("包中的角色", "PRIVATE_PACKAGE_PERSONA", "package-bot");
    (void)source.append_message("package-bot", Mode::Chat, "user", "PRIVATE_PACKAGE_MESSAGE");
    const auto package = export_archive_package(source);
    const O policies{{"bots", "preserve-existing"}, {"groups", "preserve-existing"}, {"memories", "preserve-existing"}};
    const auto payload = Json(O{{"package", package}, {"policies", policies}}).dump();
    ArchiveStageLimits limits;
    limits.max_stages = 1;
    ArchiveStaging staging(target, limits);
    auto broken = package.as_object(); broken["contentSha256"] = std::string(64, '0');
    bool rejected{};
    try { (void)staging.stage_package(Json(O{{"package", broken}, {"policies", policies}}).dump()); }
    catch (const ArchiveError&) { rejected = true; }
    check(rejected && target.list_bots().empty(), "Corrupt package cannot consume a slot or write target data");
    const auto first = staging.stage_package(payload);
    check(first.at("report").at("canCommit").as_bool() && target.list_bots().empty(), "Package preview is non-mutating");
    check(first.dump().find("PRIVATE_") == std::string::npos, "Package preview omits source content");
    stage_error(429, [&] { (void)staging.stage_package("not-json"); });
    stage_error(429, [&] { (void)staging.stage(Json(request("other")).dump()); });
    check(!staging.discard(token(first)).at("committed").as_bool(), "Discard package before commit makes no changes");
    const auto second = staging.stage_package(payload);
    const auto result = staging.commit(token(second));
    check(count(result, "messagesCreated") == 1, "Verified package uses the shared atomic commit path");
    check(staging.commit(token(second)).at("replayed").as_bool(), "Package commit response can be safely retried");
    (void)staging.discard(token(second));
    const auto again = staging.stage_package(payload);
    check(count(again, "messagesReused") == 1 && count(again, "messagesCreated") == 0, "Same package source remains idempotent");
    (void)staging.discard(token(again));
    auto missing = policies; missing.erase("groups");
    stage_error(400, [&] { (void)staging.stage_package(Json(O{{"package", package}, {"policies", missing}}).dump()); });
    stage_error(400, [&] { (void)staging.stage(payload); });
    const auto stale = staging.stage_package(payload);
    (void)target.update_bot_profile("package-bot", "User changed name", {});
    conflict([&] { (void)staging.commit(token(stale)); });
    check(target.messages("package-bot", Mode::Chat).size() == 1, "Stale package commit cannot duplicate messages");
    ArchiveStaging self(source);
    const auto refused = self.stage_package(payload);
    check(!refused.at("report").at("canCommit").as_bool(), "An export cannot be imported back into its originating Store");
    stage_error(409, [&] { (void)self.commit(token(refused)); });
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated output directory");
        const auto root = std::filesystem::path(argv[1]) /
            ("stage-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root);
        lifecycle(root); bounds_and_validation(root); conflicts_and_guards(root); staged_concurrency(root);
        package_lifecycle(root);
        std::cout << "archive_staging: " << checks << " checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
