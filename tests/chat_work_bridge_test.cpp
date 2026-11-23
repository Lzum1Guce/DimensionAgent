#include "dimension/chat_work_bridge.hpp"
#include "dimension/message_context.hpp"

#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <thread>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
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
    ++checks; try { action(); } catch (const std::exception&) { return; }
    throw std::runtime_error("Expected rejected bridge request");
}
RunCallbacks callbacks() {
    RunCallbacks cb;
    cb.configuration = [](const auto&) { return ModelConfig{}; };
    cb.model = [](const auto&, const auto&, const auto&, ModelChunk, std::stop_token) {
        return ModelReply{"Synthetic complete", {}, 1, 1};
    };
    return cb;
}
RunOptions options(bool paused = true) { RunOptions o; o.require_verified_finish = false; o.start_paused = paused; return o; }
std::string status(RunService& work, const std::string& id) { return work.brief_json(id).at("status").as_string(); }
void rewind_receipt(const fs::path& root, const std::string& request, const std::string& bot = "alpha") {
    const auto path = fs::path(L"\\\\?\\" + fs::absolute(root / (source_data_digest(Json(A{bot, request}).dump()) + ".json")).wstring());
    std::ifstream input(path, std::ios::binary);
    auto row = Json::parse(std::string(std::istreambuf_iterator<char>(input), {})).as_object(); input.close();
    row["state"] = "bound"; row.erase("text");
    std::ofstream output(path, std::ios::binary | std::ios::trunc); output << Json(row).dump();
    if (!output) throw std::runtime_error("Cannot write synthetic crash receipt");
}
void bridge_controls(const fs::path& root) {
    RunService work(root / "runs", callbacks(), options());
    bool membership = true;
    auto guard = [&](const std::string&, const std::string& group) {
        if (!group.empty() && !membership) throw std::runtime_error("member removed");
    };
    auto bridge = std::make_unique<ChatWorkBridge>(root / "bridge", work, guard);
    const auto original = work.submit("alpha", "", "Original task", "original", true).run_id;
    const auto other = work.submit("beta", "", "Other Bot", "other", true).run_id;
    const auto grouped = work.submit("alpha", "group-a", "Group task", "group", true).run_id;
    for (const auto* plain : {"Do not /work stop", "Quoted: /work stop", "请解释引用", "I said /work stop yesterday"})
        CHECK(!bridge->handle("alpha", plain, plain, O{{"text", "/work stop"}}));
    CHECK(status(work, original) == "queued");
    auto reply = bridge->handle("alpha", "/work status", "status");
    CHECK(reply && reply->receipt.at("state").as_string() == "done");
    CHECK(reply->text.find(original) != std::string::npos && reply->text.find(other) == std::string::npos);
    reply = bridge->handle("alpha", "/work stop " + other, "cross");
    CHECK(reply->receipt.at("state").as_string() == "error" && status(work, other) == "queued");
    reply = bridge->handle("alpha", "/work add -- Same task supplement", "add");
    CHECK(reply->receipt.at("state").as_string() == "done");
    CHECK(work.get(original).at("inputs").as_array().size() == 2);
    CHECK(work.get(original).at("inputs").as_array().back().at("text").as_string() == "Same task supplement");
    CHECK(work.get(grouped).at("inputs").as_array().size() == 1);
    CHECK(bridge->handle("alpha", "/work add -- Same task supplement", "add")->receipt.at("state").as_string() == "done");
    CHECK(work.get(original).at("inputs").as_array().size() == 2);
    rejected([&] { (void)bridge->handle("alpha", "/work add -- Changed", "add"); });
    bridge.reset(); rewind_receipt(root / "bridge", "add");
    bridge = std::make_unique<ChatWorkBridge>(root / "bridge", work, guard);
    CHECK(bridge->handle("alpha", "/work add -- Same task supplement", "add")->receipt.at("state").as_string() == "done");
    CHECK(work.get(original).at("inputs").as_array().size() == 2);
    const auto second = work.submit("alpha", "", "Second queued task", "second", true).run_id;
    reply = bridge->handle("alpha", "/work stop", "ambiguous");
    CHECK(reply->receipt.at("state").as_string() == "error");
    CHECK(reply->text.find(original) != std::string::npos && reply->text.find(second) != std::string::npos);
    CHECK(status(work, original) == "queued" && status(work, second) == "queued");
    reply = bridge->handle("alpha", "/工作 停止 " + original, "stop");
    CHECK(reply->receipt.at("state").as_string() == "done" && status(work, original) == "cancelled");
    CHECK(bridge->handle("alpha", "/工作 停止 " + original, "stop")->receipt.dump() == reply->receipt.dump());
    CHECK(status(work, second) == "queued");
    membership = false;
    CHECK(bridge->handle("alpha", "/work add " + grouped + " -- No longer a member", "removed")->receipt.at("state").as_string() == "error");
    CHECK(work.get(grouped).at("inputs").as_array().size() == 1);
    CHECK(bridge->handle("alpha", "/work status " + grouped, "group-status-removed")->receipt.at("state").as_string() == "error");
    CHECK(bridge->handle("alpha", "/work stop " + grouped, "group-stop")->receipt.at("state").as_string() == "error");
    CHECK(status(work, grouped) == "queued");
    CHECK(bridge->handle("alpha", "/work change " + grouped + " -- revoked group change", "group-change-removed")->receipt.at("state").as_string() == "error");
    CHECK(work.get(grouped).at("inputs").as_array().size() == 1 && status(work, grouped) == "queued");
    CHECK(bridge->handle("alpha", "/work resume", "no-resume-target")->receipt.at("state").as_string() == "error");
    CHECK(bridge->handle("alpha", "/work resume " + original, "resume")->receipt.at("state").as_string() == "done");
    CHECK(work.brief_json(original).at("attempt").as_number() == 2);
    CHECK(bridge->handle("alpha", "/work resume " + original, "resume")->receipt.at("state").as_string() == "done");
    CHECK(work.brief_json(original).at("attempt").as_number() == 2);
    // Crash between stop execution and bridge-result commit must not stop a new
    // attempt created later by a different explicit request.
    bridge.reset(); rewind_receipt(root / "bridge", "stop");
    bridge = std::make_unique<ChatWorkBridge>(root / "bridge", work, guard);
    CHECK(bridge->handle("alpha", "/工作 停止 " + original, "stop")->receipt.at("state").as_string() == "error");
    CHECK(status(work, original) == "queued");
    CHECK(work.bot_status("alpha").at("total").as_number() == 3); // Bridge never submits a run.
    CHECK(bridge->handle("gamma", "/work add -- No target", "empty")->receipt.at("state").as_string() == "error");
    CHECK(work.bot_status("gamma").at("total").as_number() == 0);
    const auto natural = work.submit("natural", "", "Natural language controlled task", "natural", true).run_id;
    for (const auto* prose : {"不要停止当前工作", "如果失败就停止当前工作", "他说停止当前工作", "“停止当前工作”是什么意思"})
        CHECK(!bridge->handle("natural", prose, prose));
    CHECK(!bridge->handle("natural", "解释这段参考资料", "quoted-natural", O{{"text", "停止当前工作"}}));
    CHECK(status(work, natural) == "queued");
    CHECK(bridge->handle("natural", "请给当前任务补充要求：保留可编辑文件", "natural-add")->receipt.at("state").as_string() == "done");
    CHECK(work.get(natural).at("inputs").as_array().back().at("text").as_string() == "保留可编辑文件");
    CHECK(bridge->handle("natural", "帮我停止当前工作。", "natural-stop")->receipt.at("state").as_string() == "done");
    CHECK(status(work, natural) == "cancelled");
    CHECK(bridge->handle("natural", "继续刚才的任务", "natural-resume")->receipt.at("state").as_string() == "done");
    CHECK(work.brief_json(natural).at("attempt").as_number() == 2);
    CHECK(work.bot_status("natural").at("total").as_number() == 1);
    CHECK(!bridge->handle("natural", "怎样设计一个新任务？", "consultation"));
    CHECK(work.bot_status("natural").at("total").as_number() == 1);
    auto created = bridge->handle("natural", "/work new -- 创建可编辑报告", "new-report");
    CHECK(created && created->receipt.at("state").as_string() == "done");
    const auto created_id = created->receipt.at("runId").as_string();
    CHECK(created->text.find(created_id) != std::string::npos);
    CHECK(work.bot_status("natural").at("total").as_number() == 2);
    CHECK(status(work, created_id) == "queued");
    CHECK(work.brief_json(created_id).at("groupId").as_string().empty());
    CHECK(bridge->handle("natural", "/work new -- 创建可编辑报告", "new-report")->receipt.dump() == created->receipt.dump());
    CHECK(work.bot_status("natural").at("total").as_number() == 2);
    rejected([&] { (void)bridge->handle("natural", "/work new -- 不同内容", "new-report"); });
    bridge.reset(); rewind_receipt(root / "bridge", "new-report", "natural");
    bridge = std::make_unique<ChatWorkBridge>(root / "bridge", work, guard);
    CHECK(bridge->handle("natural", "/work new -- 创建可编辑报告", "new-report")->receipt.at("runId").as_string() == created_id);
    CHECK(work.bot_status("natural").at("total").as_number() == 2);
    auto second_new = bridge->handle("natural", "请开始新任务：保留旧任务并另做摘要", "new-summary");
    CHECK(second_new && second_new->receipt.at("state").as_string() == "done");
    CHECK(second_new->receipt.at("runId").as_string() != created_id);
    CHECK(work.bot_status("natural").at("total").as_number() == 3);
    CHECK(work.get(created_id).at("inputs").as_array().size() == 1);
    CHECK(status(work, created_id) == "queued");
    CHECK(bridge->handle("natural", "/work new -- ", "empty-new")->receipt.at("state").as_string() == "error");
    CHECK(work.bot_status("natural").at("total").as_number() == 3);
}
void continuity(const fs::path& root) {
    int model_calls = 0;
    std::string id, other;
    {
        auto cb = callbacks();
        cb.model = [&](const auto&, const auto&, const auto&, ModelChunk, std::stop_token) {
            ++model_calls; return ModelReply{"Unexpected automatic replay", {}, 1, 1};
        };
        RunService work(root / "runs", cb, options());
        auto bridge = std::make_unique<ChatWorkBridge>(root / "bridge", work, ChatWorkBridge::InputGuard{});
        id = work.submit("continuity", "", "原始决定", "continuity-original", true).run_id;
        other = work.submit("other", "", "其他 Bot 的决定", "continuity-other", true).run_id;
        for (const auto* prose : {"能否把当前任务改成紫色？", "把当前任务改成紫色，可以吗？", "今天天气怎么样，聊个新话题"})
            CHECK(!bridge->handle("continuity", prose, prose));
        CHECK(work.bot_status("continuity").at("total").as_number() == 1);
        CHECK(work.get(id).at("inputs").as_array().size() == 1);
        auto reply = bridge->handle("continuity", "/work status " + id, "continuity-consult");
        CHECK(reply && reply->receipt.at("intent").as_string() == "consultation");
        CHECK(reply->receipt.at("run").at("status").as_string() == "queued");
        CHECK(reply->text.find("最新决定：原始决定") != std::string::npos);
        auto natural_q = bridge->handle("continuity", "现在任务做到哪了？", "continuity-consult-q");
        CHECK(natural_q && natural_q->receipt.at("intent").as_string() == "consultation");
        auto preview_chg = bridge->handle("continuity", "评估任务变更：改为英文大纲", "continuity-preview-change");
        CHECK(preview_chg && preview_chg->receipt.at("intent").as_string() == "change_preview");
        CHECK(preview_chg->receipt.at("impact").at("previewOnly").as_bool());
        CHECK(work.get(id).at("inputs").as_array().size() == 1); // Preview must not mutate inputs.
        reply = bridge->handle("continuity", "请给当前任务补充要求：增加可编辑格式", "continuity-add");
        CHECK(reply && reply->receipt.at("intent").as_string() == "supplement");
        CHECK(work.get(id).at("inputs").as_array().size() == 2);
        CHECK(bridge->handle("continuity", "请给当前任务补充要求：增加可编辑格式", "continuity-add")->receipt.dump() == reply->receipt.dump());
        CHECK(work.get(id).at("inputs").as_array().size() == 2);
        reply = bridge->handle("continuity", "变更当前任务：推翻已执行步骤，改为中文摘要", "continuity-change-active");
        CHECK(reply && reply->receipt.at("intent").as_string() == "change");
        CHECK(reply->receipt.at("impact").at("previousStatus").as_string() == "queued");
        CHECK(!reply->receipt.at("impact").at("completedSideEffectsUndone").as_bool());
        CHECK(!reply->receipt.at("impact").at("existingArtifactsDeleted").as_bool());
        CHECK(reply->receipt.at("impact").at("affectedOutputsRequireReverification").as_bool());
        CHECK(reply->text.find("变更影响") != std::string::npos && reply->text.find("未解决项继续保留") != std::string::npos);
        CHECK(work.get(id).at("inputs").as_array().size() == 3);
        CHECK(work.get(id).at("inputs").as_array().back().at("text").as_string().find("【最新变更决定】") == 0);
        CHECK(work.get(id).at("inputs").as_array().back().at("text").as_string().find("改为中文摘要") != std::string::npos);
        CHECK(bridge->handle("continuity", "变更当前任务：推翻已执行步骤，改为中文摘要", "continuity-change-active")->receipt.dump() == reply->receipt.dump());
        rejected([&] { (void)bridge->handle("continuity", "变更当前任务：不同决定", "continuity-change-active"); });
        bridge.reset(); rewind_receipt(root / "bridge", "continuity-change-active", "continuity");
        bridge = std::make_unique<ChatWorkBridge>(root / "bridge", work, ChatWorkBridge::InputGuard{});
        CHECK(bridge->handle("continuity", "变更当前任务：推翻已执行步骤，改为中文摘要", "continuity-change-active")->receipt.at("state").as_string() == "done");
        CHECK(work.get(id).at("inputs").as_array().size() == 3);
        reply = bridge->handle("continuity", "/work change " + other + " -- 错误 run 不得变更", "continuity-wrong-run");
        CHECK(reply && reply->receipt.at("state").as_string() == "error");
        CHECK(work.get(other).at("inputs").as_array().size() == 1 && status(work, other) == "queued");
        CHECK(bridge->handle("continuity", "/work stop " + id, "continuity-stop")->receipt.at("state").as_string() == "done");
        reply = bridge->handle("continuity", "修改当前任务：已完成步骤改为最新版", "continuity-change-terminal");
        CHECK(reply && reply->receipt.at("state").as_string() == "done");
        CHECK(work.brief_json(id).at("attempt").as_number() == 2);
        CHECK(reply->receipt.at("impact").at("previousStatus").as_string() == "cancelled");
        CHECK(reply->receipt.at("impact").at("attemptAfter").as_number() == 2);
        CHECK(work.get(id).at("inputs").as_array().size() == 4);
        bridge.reset(); rewind_receipt(root / "bridge", "continuity-change-terminal", "continuity");
        bridge = std::make_unique<ChatWorkBridge>(root / "bridge", work, ChatWorkBridge::InputGuard{});
        CHECK(bridge->handle("continuity", "修改当前任务：已完成步骤改为最新版", "continuity-change-terminal")->receipt.at("state").as_string() == "done");
        CHECK(work.brief_json(id).at("attempt").as_number() == 2 && work.get(id).at("inputs").as_array().size() == 4);
        (void)work.cancel(id);
        (void)work.resume(id, "work-latest", "Work 中最新的决定");
        CHECK(work.brief_json(id).at("attempt").as_number() == 3);
        reply = bridge->handle("continuity", "/work status " + id, "continuity-chat-work-chat");
        CHECK(reply && reply->receipt.at("run").at("attempt").as_number() == 3);
        CHECK(reply->receipt.at("run").at("status").as_string() == work.brief_json(id).at("status").as_string());
        CHECK(reply->receipt.at("run").at("sequence").dump() == work.brief_json(id).at("sequence").dump());
        CHECK(reply->receipt.at("run").at("latestDecision").at("text").as_string() == "Work 中最新的决定");
        CHECK(reply->text.find("Work 中最新的决定") != std::string::npos);
        CHECK(reply->receipt.at("run").at("unresolvedItems").as_array().size() == 1);
        CHECK(bridge->status("continuity", id).dump() == work.brief_json(id).dump());
        CHECK(model_calls == 0);
    }
    {
        auto cb = callbacks();
        cb.model = [&](const auto&, const auto&, const auto&, ModelChunk, std::stop_token) {
            ++model_calls; return ModelReply{"Unexpected automatic replay", {}, 1, 1};
        };
        RunService work(root / "runs", cb, options());
        ChatWorkBridge bridge(root / "bridge", work, {});
        CHECK(status(work, id) == "interrupted");
        CHECK(work.brief_json(id).at("attempt").as_number() == 3);
        CHECK(work.get(id).at("inputs").as_array().size() == 5);
        CHECK(work.brief_json(id).at("latestDecision").at("text").as_string() == "Work 中最新的决定");
        CHECK(work.brief_json(id).at("unresolvedItems").as_array().size() == 1);
        CHECK(model_calls == 0); // Reopening never dispatches the persisted attempt.
        auto reply = bridge.handle("continuity", "/work resume " + id + " -- 断线后明确继续", "continuity-after-restart");
        CHECK(reply && reply->receipt.at("state").as_string() == "done");
        CHECK(work.brief_json(id).at("attempt").as_number() == 4);
        CHECK(work.get(id).at("inputs").as_array().size() == 6);
        CHECK(work.brief_json(id).at("latestDecision").at("text").as_string() == "断线后明确继续");
        CHECK(model_calls == 0);
    }
}
void stopping(const fs::path& root) {
    std::mutex mutex; std::condition_variable cv; bool entered = false, release = false;
    auto cb = callbacks();
    cb.model = [&](const auto&, const auto&, const auto&, ModelChunk, std::stop_token) {
        std::unique_lock lock(mutex); entered = true; cv.notify_all();
        if (!cv.wait_for(lock, 5s, [&] { return release; })) throw std::runtime_error("Synthetic gate timeout");
        return ModelReply{"Done", {}, 1, 1};
    };
    RunService work(root / "runs", cb, options(false));
    ChatWorkBridge bridge(root / "bridge", work, {});
    const auto id = work.submit("alpha", "", "Gate", "initial").run_id;
    { std::unique_lock lock(mutex); CHECK(cv.wait_for(lock, 5s, [&] { return entered; })); }
    CHECK(bridge.handle("alpha", "/work stop", "stop")->receipt.at("state").as_string() == "done");
    CHECK(work.brief_json(id).at("executing").as_bool());
    CHECK(bridge.handle("alpha", "/work resume " + id, "too-early")->receipt.at("state").as_string() == "error");
    { std::lock_guard lock(mutex); release = true; cv.notify_all(); }
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (work.brief_json(id).at("executing").as_bool() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(2ms);
    CHECK(!work.brief_json(id).at("executing").as_bool());
    CHECK(bridge.handle("alpha", "/work resume " + id, "after-stop")->receipt.at("state").as_string() == "done");
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::path(argv[1]) / ("b-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root); bridge_controls(root / "controls"); continuity(root / "continuity"); stopping(root / "stopping");
        std::cout << "chat_work_bridge: " << checks << " checks passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
