#include "dimension/runs.hpp"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <iostream>
#include <map>
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
RunOptions options(bool paused = false) { RunOptions v; v.require_verified_finish = false; v.start_paused = paused; return v; }
RunCallbacks callbacks() {
    RunCallbacks result;
    result.configuration = [](const RunExecutionContext& ctx) { ModelConfig config; config.model = ctx.bot_id; return config; };
    result.model = [](const ModelConfig&, const std::vector<ModelMessage>&, const std::vector<ModelTool>&,
                      ModelChunk, std::stop_token) { return ModelReply{"Synthetic completion", {}, 1, 1}; };
    return result;
}
Json row(const Json& view, const std::string& bot) {
    for (const auto& value : view.as_array()) if (value.at("botId").as_string() == bot) return value;
    throw std::runtime_error("Missing group status Bot " + bot);
}
void complete_scan(const fs::path& path) {
    RunService service(path, callbacks(), options(true));
    const auto old = service.submit("alpha", "team:1", "older queued task", "old", true);
    std::this_thread::sleep_for(2ms);
    for (int i = 0; i < 60; ++i) {
        const auto run = service.submit("alpha", "team:1", "new terminal history", "new-" + std::to_string(i), true);
        (void)service.cancel(run.run_id);
    }
    const auto second = service.submit("alpha", "team:1", "second queued task", "second", true);
    const auto beta = service.submit("beta", "team:1", "beta queued", "beta", true);
    (void)service.submit("alpha", "", "private task", "private", true);
    (void)service.submit("gamma", "team:other", "other group", "other", true);
    auto view = service.group_status("team:1"); CHECK(view.as_array().size() == 2);
    auto alpha = row(view, "alpha");
    CHECK(alpha.at("id").as_string() == old.run_id);
    CHECK(alpha.at("active").as_bool() && alpha.at("status").as_string() == "queued");
    CHECK(alpha.at("queuedCount").as_number() == 2);
    (void)service.pause_queue("alpha", "team:1", true);
    CHECK(row(service.group_status("team:1"), "alpha").at("step").as_string() == "队列已暂停");
    (void)service.cancel(old.run_id); (void)service.cancel(second.run_id);
    alpha = row(service.group_status("team:1"), "alpha");
    CHECK(!alpha.at("active").as_bool() && alpha.at("status").as_string() == "cancelled");
    CHECK(alpha.at("queuedCount").as_number() == 0);
    CHECK(row(service.group_status("team:1"), "beta").at("id").as_string() == beta.run_id);
    CHECK(service.group_status("team:missing").as_array().empty());
}
void parallel_and_stopping(const fs::path& path) {
    std::mutex mutex; std::condition_variable condition;
    std::map<std::string, bool> entered, release;
    auto injected = callbacks();
    injected.model = [&](const ModelConfig& config, const std::vector<ModelMessage>&,
                         const std::vector<ModelTool>&, ModelChunk chunk, std::stop_token) {
        chunk("text", "Synthetic in progress");
        std::unique_lock lock(mutex); entered[config.model] = true; condition.notify_all();
        if (!condition.wait_for(lock, 5s, [&] { return release[config.model]; })) throw std::runtime_error("fixture timeout");
        return ModelReply{"Synthetic completion", {}, 1, 1};
    };
    RunService service(path, injected, options());
    const auto a = service.submit("alpha", "team:1", "alpha job", "alpha", true);
    const auto b = service.submit("beta", "team:1", "beta job", "beta", true);
    {
        std::unique_lock lock(mutex);
        CHECK(condition.wait_for(lock, 5s, [&] { return entered["alpha"] && entered["beta"]; }));
    }
    auto view = service.group_status("team:1");
    CHECK(row(view, "alpha").at("status").as_string() == "running");
    CHECK(row(view, "beta").at("status").as_string() == "running");
    (void)service.cancel(a.run_id);
    view = service.group_status("team:1");
    CHECK(row(view, "alpha").at("status").as_string() == "stopping");
    CHECK(row(view, "alpha").at("runStatus").as_string() == "cancelled");
    CHECK(row(view, "alpha").at("active").as_bool());
    CHECK(row(view, "beta").at("status").as_string() == "running");
    { std::lock_guard lock(mutex); release["alpha"] = release["beta"] = true; condition.notify_all(); }
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (service.has_group_activity("team:1") && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(2ms);
    CHECK(!service.has_group_activity("team:1"));
    view = service.group_status("team:1");
    CHECK(row(view, "alpha").at("status").as_string() == "cancelled");
    CHECK(!row(view, "alpha").at("active").as_bool());
    CHECK(row(view, "beta").at("status").as_string() == "completed");
    CHECK(!row(view, "beta").at("active").as_bool());
    (void)b;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated test output directory");
        const auto root = fs::path(argv[1]) / ("group-status-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        complete_scan(root / "complete"); parallel_and_stopping(root / "parallel");
        std::cout << "group_status: " << checks << " checks passed (synthetic complete snapshots and lifecycle)\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
