#include "dimension/archive_export.hpp"
#include "dimension/store.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>

namespace {
using namespace dimension;
namespace fs = std::filesystem;
std::size_t checks{};
void check(bool good, const char* expression, int line) {
    ++checks; if (!good) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(StoreErrorCode expected, F action) {
    ++checks;
    try { action(); }
    catch (const StoreError& error) {
        if (error.code() == expected) return;
        throw std::runtime_error("Unexpected Store error: " + std::string(error.what()));
    }
    throw std::runtime_error("Expected rejected impression operation");
}

void impressions(const fs::path& root) {
    const auto file = root / "impressions.sqlite";
    auto store = std::make_unique<Store>(file);
    for (const auto* id : {"alpha", "beta", "gamma"}) (void)store->create_bot(id, "Synthetic", id);
    Group group; group.id = "team:impressions"; group.name = "Synthetic shared Work";
    group.owner_id = "alpha"; group.members = {"alpha", "beta", "gamma"};
    group.history_members = group.members; group.in_chat = group.in_work = true;
    group.seal_shape = "circle"; group.seal_color = "violet";
    (void)store->create_group(group);
    const auto first_source = store->append_message("alpha", Mode::Chat, "bot", "接口排错时先复现再修改", group.id);
    const auto second_source = store->append_message("beta", Mode::Work, "bot", "新证据：这次直接修改且回归失败", group.id);
    const auto private_source = store->append_message("alpha", Mode::Chat, "user", "PRIVATE_NEVER_EVIDENCE");
    const auto first_ref = "message:" + std::to_string(first_source.id);
    const auto second_ref = "message:" + std::to_string(second_source.id);

    auto first = store->propose_impression("alpha", "beta", group.id,
        "我认为 Beta 在接口排错协作中会先复现", first_source.created_at_ms, first_ref,
        "同群消息展示了先复现再修改", "共同排查接口故障");
    CHECK(first.kind == "impression" && first.bot_id == "alpha" && first.target_bot_id == "beta");
    CHECK(first.state == MemoryState::Candidate && first.revision == 1);
    CHECK(store->recall_impressions("alpha", "beta", group.id, "接口").empty());
    CHECK(store->recall_impressions("beta", "alpha", group.id, "接口").empty());

    const auto duplicate = store->propose_impression("alpha", "beta", group.id,
        "我认为 Beta 在接口排错协作中会先复现", first_source.created_at_ms, first_ref,
        "同群消息展示了先复现再修改", "共同排查接口故障");
    CHECK(duplicate.id == first.id && duplicate.revision == first.revision);
    CHECK(store->list_impressions("alpha", group.id, "beta").size() == 1);
    rejected(StoreErrorCode::Conflict, [&] {
        (void)store->propose_impression("alpha", "beta", group.id, "同一来源不能改写判断",
            first_source.created_at_ms, first_ref, "重复转述", "共同排查接口故障");
    });
    rejected(StoreErrorCode::InvalidArgument, [&] {
        (void)store->propose_impression("alpha", "beta", "", "私聊不能成为依据",
            private_source.created_at_ms, "message:" + std::to_string(private_source.id), "私聊", "任何场景");
    });
    rejected(StoreErrorCode::InvalidArgument, [&] {
        (void)store->propose_impression("alpha", "beta", group.id, "跨范围引用也应拒绝",
            private_source.created_at_ms, "message:" + std::to_string(private_source.id), "私聊", "任何场景");
    });
    rejected(StoreErrorCode::InvalidArgument, [&] {
        (void)store->propose_impression("alpha", "beta", group.id, "时间必须来自原消息",
            first_source.created_at_ms + 1, first_ref, "同群消息", "接口排错");
    });
    rejected(StoreErrorCode::InvalidArgument, [&] {
        (void)store->propose_impression("alpha", "beta", group.id, "转述不是直接来源",
            first_source.created_at_ms, "hearsay:another-bot", "另一个 Bot 转述", "接口排错");
    });

    // Identical wording about another target remains a separate directed record.
    const auto other_target = store->propose_impression("alpha", "gamma", group.id,
        "我认为 Beta 在接口排错协作中会先复现", first_source.created_at_ms, first_ref,
        "同群消息展示了先复现再修改", "共同排查接口故障");
    CHECK(other_target.id != first.id && other_target.target_bot_id == "gamma");

    first = store->review_memory(first.id, first.revision, MemoryState::Confirmed);
    auto recalled = store->recall_impressions("alpha", "beta", group.id, "接口");
    CHECK(recalled.size() == 1 && recalled.front().id == first.id);
    CHECK(store->recall_impressions("beta", "alpha", group.id, "接口").empty());
    CHECK(store->recall_impressions("alpha", "gamma", group.id, "接口").empty());

    auto correction = store->propose_impression("alpha", "beta", group.id,
        "我修正为：Beta 在接口排错时也可能跳过复现，需要先约定验证", second_source.created_at_ms,
        second_ref, "共同 Work 中直接修改且回归失败", "共同排查接口故障", first.id);
    CHECK(correction.state == MemoryState::Candidate && correction.supersedes_id == first.id);
    CHECK(store->recall_impressions("alpha", "beta", group.id, "先复现").front().id == first.id);
    rejected(StoreErrorCode::Conflict, [&] {
        (void)store->propose_impression("alpha", "beta", group.id, "同来源不能伪造纠正",
            first_source.created_at_ms, first_ref, "旧来源", "接口排错", first.id);
    });
    correction = store->review_memory(correction.id, correction.revision, MemoryState::Confirmed);
    const auto old = store->find_memory(first.id);
    CHECK(old && old->state == MemoryState::Rejected && old->revision == first.revision + 1);
    recalled = store->recall_impressions("alpha", "beta", group.id, "回归失败");
    CHECK(recalled.size() == 1 && recalled.front().id == correction.id);
    const auto corrected_only = store->recall_impressions("alpha", "beta", group.id, "先复现");
    CHECK(std::none_of(corrected_only.begin(), corrected_only.end(), [&](const auto& row) { return row.id == first.id; }));
    const auto audit = store->list_impressions("alpha", group.id, "beta");
    CHECK(audit.size() == 2 && audit[0].id == correction.id && audit[1].id == first.id);
    rejected(StoreErrorCode::Conflict, [&] { (void)store->edit_memory(first.id, old->revision, "篡改旧评价"); });
    rejected(StoreErrorCode::Conflict, [&] { store->delete_memory(first.id, old->revision); });

    (void)store->propose_memory("alpha", "", "Legacy fact remains compatible", "user");
    auto episode = store->propose_episode("alpha", "", "Legacy episode remains compatible",
        first_source.created_at_ms, "message:" + std::to_string(first_source.id), "User、Alpha", "Keep", "Passed");
    (void)store->review_memory(episode.id, episode.revision, MemoryState::Confirmed);
    const auto package = export_archive_package(*store);
    const auto parsed = parse_archive_package(package.dump());
    bool found_impression = false, found_fact = false, found_episode = false;
    for (const auto& memory : parsed.archive.memories()) {
        if (memory.id == correction.id) {
            found_impression = memory.kind == "impression" && memory.target_bot_id == "beta" &&
                memory.evidence == "共同 Work 中直接修改且回归失败" && memory.supersedes_id == first.id;
        }
        if (memory.kind == "fact" && memory.text == "Legacy fact remains compatible") found_fact = true;
        if (memory.kind == "episode" && memory.text == "Legacy episode remains compatible") found_episode = true;
    }
    CHECK(found_impression && found_fact && found_episode);

    Store restored(root / "restored.sqlite");
    StoreImportOptions options{"synthetic-impression-archive", StoreBotConflict::Reject,
        StoreMemoryConflict::PreserveExisting, StoreGroupConflict::Reject};
    const auto plan = restored.prepare_archive_import(parsed.archive, options);
    CHECK(plan.can_commit);
    (void)restored.commit_archive_import(parsed.archive, options, plan.target_revision, plan.digest);
    const auto restored_recall = restored.recall_impressions("alpha", "beta", group.id, "回归失败");
    CHECK(restored_recall.size() == 1 && restored_recall.front().target_bot_id == "beta");
    const auto restored_audit = restored.list_impressions("alpha", group.id, "beta");
    CHECK(restored_audit.size() == 2 && restored_audit[0].supersedes_id == restored_audit[1].id);
    CHECK(restored_audit[1].state == MemoryState::Rejected);
    CHECK(restored.recall_impressions("beta", "alpha", group.id, "回归失败").empty());
    CHECK(restored.recall_episodes("alpha", "", "Legacy").size() == 1);

    store.reset();
    store = std::make_unique<Store>(file); // v10 restart whitelist and audit persistence.
    CHECK(store->recall_impressions("alpha", "beta", group.id, "回归失败").size() == 1);
    CHECK(store->find_memory(first.id)->state == MemoryState::Rejected);
}
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::path(argv[1]) / ("impression-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root); impressions(root);
        std::cout << "impression_memory: " << checks << " checks passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
