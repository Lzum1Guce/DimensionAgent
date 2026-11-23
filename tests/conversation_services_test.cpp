#include "dimension/conversation_services.hpp"
#include "dimension/message_context.hpp"
#include "dimension/atomic_file.hpp"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <thread>

namespace {
using namespace dimension;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
using A = Json::Array;
using O = Json::Object;
std::size_t checks{};
void check(bool good, const char* expression, int line) {
    ++checks; if (!good) throw std::runtime_error("line " + std::to_string(line) + ": " + expression);
}
#define CHECK(value) check(static_cast<bool>(value), #value, __LINE__)
template<class F> void rejected(F action) {
    ++checks; try { action(); } catch (const std::exception&) { return; }
    throw std::runtime_error("Expected rejected conversation service request");
}
template<class F> void until(F ready) {
    const auto end = std::chrono::steady_clock::now() + 8s;
    while (!ready()) {
        if (std::chrono::steady_clock::now() > end) throw std::runtime_error("Synthetic job timed out");
        std::this_thread::sleep_for(2ms);
    }
}
std::string str(const Json& value, const char* key) { return value.at(key).as_string(); }
fs::path native_path(const fs::path& value) { return L"\\\\?\\" + fs::absolute(value).wstring(); }
void seed(Store& store, int count) {
    (void)store.create_bot("Alpha", "Synthetic persona", "alpha");
    (void)store.create_bot("Beta", "Synthetic persona", "beta");
    for (int i = 0; i < count; ++i) (void)store.append_message("alpha", Mode::Chat, i % 2 ? "bot" : "user", "汉🙂x");
}
RunCallbacks work_callbacks() {
    RunCallbacks cb; cb.configuration = [](const auto&) { return ModelConfig{}; };
    cb.model = [](const auto&, const auto&, const auto&, auto, auto) { return ModelReply{"Synthetic Work", {}, 1, 1}; };
    return cb;
}
RunOptions work_options() { RunOptions o; o.start_paused = true; o.require_verified_finish = false; return o; }
struct Models {
    std::atomic<int> calls{0}, mode{0}; // 0 success, 1 gate, 2 error, 3 unsupported tool.
    std::atomic<bool> entered{false}, release{false}, no_tools{true};
    std::mutex mutex;
    std::vector<std::vector<ModelMessage>> records;
    void gate() { mode = 1; entered = false; release = false; }
    ConversationServiceCallbacks callbacks(std::size_t budget = 2000) {
        ConversationServiceCallbacks cb;
        cb.configuration = [](const auto&, const auto&) { return ModelConfig{}; };
        cb.input_budget = [budget](const auto&, const auto&) { return budget; };
        cb.model = [this](const ModelConfig& config, const std::vector<ModelMessage>& messages,
            const std::vector<ModelTool>& tools, ModelChunk, std::stop_token stop) {
            ++calls; no_tools = no_tools && tools.empty();
            { std::lock_guard lock(mutex); records.push_back(messages); }
            if (messages.front().content.find("忠实概括") != std::string::npos && config.max_output_tokens > 600)
                throw std::runtime_error("Summary must bound its generated fragments");
            const auto action = mode.load(); entered = true;
            if (action == 1) {
                until([&] { return release.load() || stop.stop_requested(); });
                if (stop.stop_requested()) throw std::runtime_error("Synthetic cancelled provider request");
            }
            if (action == 2) throw std::runtime_error("Synthetic provider failure");
            if (action == 3) return ModelReply{"", {{"invalid", "write_file", "{}"}}, 0, 0};
            return ModelReply{"Synthetic source-based summary or reply", {}, 10, 10};
        };
        return cb;
    }
};
Json finish(ConversationServices& service, const std::string& bot, const Json& original) {
    Json value;
    until([&] { value = service.job(bot, str(original, "id")); return value.at("terminal").as_bool(); });
    return value;
}
const Json& mini(const Json& space, const std::string& id) {
    for (const auto& row : space.at("minibots").as_array()) if (str(row, "id") == id) return row;
    throw std::runtime_error("Missing mini declaration");
}
void statistics(const fs::path& root) {
    Store store(root / "data.sqlite"); seed(store, 151);
    (void)store.append_message("beta", Mode::Chat, "user", "Foreign history");
    (void)store.append_message("alpha", Mode::Work, "user", "Work history");
    const auto stats = store.conversation_statistics("alpha");
    CHECK(stats.messages == 151 && stats.unicode_scalars == 453 && stats.utf8_bytes == 1208);
    CHECK(store.messages("alpha", Mode::Chat).size() == 50);
    const auto original = store.conversation_snapshot("alpha");
    CHECK(original.messages.size() == 151 && original.messages.front().id == stats.first_id && original.messages.back().id == stats.last_id);
    CHECK(original.fingerprint.size() == 64 && original.fingerprint != store.conversation_snapshot("beta").fingerprint);
    (void)store.append_message("alpha", Mode::Chat, "user", "arrived during summary");
    rejected([&] { (void)store.append_summary_once("alpha", "obsolete", "stale", original.fingerprint); });
    CHECK(store.conversation_statistics("alpha").messages == 152);
    const auto current = store.conversation_snapshot("alpha");
    const auto summary = store.append_summary_once("alpha", "Synthetic summary", "valid", current.fingerprint);
    CHECK(summary.actor == "system" && store.conversation_statistics("alpha").messages == 153);
    (void)store.append_message("alpha", Mode::Chat, "user", "Later history");
    CHECK(store.append_summary_once("alpha", "Synthetic summary", "valid", current.fingerprint).id == summary.id);
    rejected([&] { (void)store.append_summary_once("alpha", "Changed summary", "valid", current.fingerprint); });
    store.remove_bot("alpha", Mode::Chat);
    rejected([&] { (void)store.append_summary_once("alpha", "Synthetic summary", "valid", current.fingerprint); });
    CHECK(store.conversation_statistics("alpha").messages == 0 && store.conversation_statistics("alpha", Mode::Work).messages == 1);
}
void summary_jobs(const fs::path& root) {
    Store store(root / "data.sqlite"); seed(store, 145);
    const auto originals = store.conversation_snapshot("alpha");
    RunService work(root / "work", work_callbacks(), work_options()); Models models;
    const auto service_root = root / "service";
    auto service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks());
    CHECK(service->context("alpha").at("messages").as_number() == 145);
    auto job = service->summarize("alpha", "first");
    rejected([&] { (void)service->job("beta", str(job, "id")); });
    job = finish(*service, "alpha", job);
    CHECK(str(job, "status") == "completed" && job.at("compacted").as_bool());
    CHECK(models.calls > 2 && models.no_tools && job.at("modelCalls").as_number() == models.calls);
    CHECK(store.conversation_statistics("alpha").messages == 146 && store.list_memories("alpha").empty());
    for (const auto& original : originals.messages) CHECK(store.find_message(original.id)->text == original.text);
    const auto source = service->source("alpha", str(job, "id"));
    CHECK(source_data_digest(source) == str(job, "sourceDigest"));
    CHECK(Json::parse(source).at("messages").as_array().size() == 145 && job.at("sourceCount").as_number() == 125);
    CHECK(!service->active_summary("alpha").empty() && service->active_summary("beta").empty());
    const auto calls = models.calls.load();
    CHECK(str(service->summarize("alpha", "first"), "id") == str(job, "id") && models.calls == calls);
    CHECK(work.bot_status("alpha").at("total").as_number() == 0);
    service.reset(); service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks());
    CHECK(str(service->summarize("alpha", "first"), "summaryMessageId") == str(job, "summaryMessageId"));
    CHECK(models.calls == calls && !service->active_summary("alpha").empty());

    const auto before = store.conversation_statistics("alpha").messages;
    models.gate(); auto stale = service->summarize("alpha", "stale"); until([&] { return models.entered.load(); });
    rejected([&] { (void)service->summarize("alpha", "second-concurrent"); });
    (void)store.append_message("alpha", Mode::Chat, "user", "New source after backup"); models.release = true;
    CHECK(str(finish(*service, "alpha", stale), "status") == "failed");
    CHECK(store.conversation_statistics("alpha").messages == before + 1);
    models.gate(); auto cancelled = service->summarize("alpha", "cancel"); until([&] { return models.entered.load(); });
    (void)service->cancel("alpha", str(cancelled, "id"));
    CHECK(str(finish(*service, "alpha", cancelled), "status") == "cancelled");
    CHECK(store.conversation_statistics("alpha").messages == before + 1);
    models.mode = 2; const auto failed = finish(*service, "alpha", service->summarize("alpha", "fail"));
    CHECK(str(failed, "status") == "failed" && !failed.at("compacted").as_bool());
    CHECK(store.conversation_statistics("alpha").messages == before + 1);
    models.mode = 3; CHECK(str(finish(*service, "alpha", service->summarize("alpha", "tool")), "status") == "failed");

    models.gate(); auto corrupt = service->summarize("alpha", "corrupt"); until([&] { return models.entered.load(); });
    atomic_write_file(service_root / "sources" / (str(corrupt, "id") + ".json"), "{}"); models.release = true;
    CHECK(str(finish(*service, "alpha", corrupt), "status") == "failed");
    rejected([&] { (void)service->source("alpha", str(corrupt, "id")); });
    CHECK(store.conversation_statistics("alpha").messages == before + 1);

    // Simulate a failure of the final job-file save after SQLite has committed.
    // Restoring the path lets the exact receipt finish without a second summary.
    for (int i = 0; i < 21; ++i) (void)store.append_message("beta", Mode::Chat, "user", "Synthetic single-fragment source");
    models.gate(); auto retry = service->summarize("beta", "postcommit"); until([&] { return models.entered.load(); });
    const auto record = service_root / "jobs" / (str(retry, "id") + ".json"), saved = service_root / "saved-job.json";
    fs::rename(native_path(record), native_path(saved)); fs::create_directory(native_path(record)); models.release = true;
    until([&] { try { (void)service->job("beta", str(retry, "id")); } catch (...) {} return store.conversation_statistics("beta").messages == 22; });
    CHECK(fs::remove(native_path(record))); fs::rename(native_path(saved), native_path(record));
    CHECK(str(finish(*service, "beta", retry), "status") == "completed");
    CHECK(store.conversation_statistics("beta").messages == 22);

    models.gate(); auto interrupted = service->summarize("alpha", "restart"); until([&] { return models.entered.load(); });
    service.reset(); models.mode = 0;
    service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks());
    const auto restored = finish(*service, "alpha", interrupted);
    CHECK(str(restored, "status") != "completed" && store.conversation_statistics("alpha").messages == before + 1);
    (void)store.create_bot("Empty", "Synthetic", "empty");
    const auto no_op = service->summarize("empty", "empty");
    CHECK(no_op.at("terminal").as_bool() && !no_op.at("calledModel").as_bool());
}
void mini_jobs(const fs::path& root) {
    Store store(root / "data.sqlite"); seed(store, 23);
    const auto history = store.conversation_snapshot("alpha").fingerprint;
    RunService work(root / "work", work_callbacks(), work_options()); Models models;
    const auto work_id = work.submit("alpha", "", "A real synthetic queued Work item", "work", true).run_id;
    const auto foreign = work.submit("beta", "", "Foreign Work item", "other", true).run_id;
    const auto service_root = root / "service";
    auto service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks(12000));
    const auto space = service->space("alpha"); CHECK(space.at("minibots").as_array().size() == 13);
    CHECK(!mini(space, "observations").at("thinkWithModel").as_bool());
    auto local = service->mini_chat("alpha", "observations", "Synthetic local question", "local");
    CHECK(local.at("terminal").as_bool() && !local.at("calledModel").as_bool() && models.calls == 0);
    CHECK(str(local, "reply").find("关闭") != std::string::npos);
    CHECK(service->mini_history("beta", "observations").at("turns").as_array().empty());
    CHECK(service->mini_history("alpha", "planning").at("turns").as_array().empty());
    CHECK(str(service->mini_chat("alpha", "observations", "Synthetic local question", "local"), "id") == str(local, "id"));
    rejected([&] { (void)service->mini_chat("alpha", "observations", "Changed question", "local"); });
    rejected([&] { (void)service->source("alpha", str(local, "id")); });
    auto analysis = service->set_thinking("alpha", "observations", true, "enable").at("job");
    analysis = finish(*service, "alpha", analysis);
    CHECK(str(analysis, "status") == "completed" && models.calls == 1 && models.no_tools);
    auto source = Json::parse(service->source("alpha", str(analysis, "id")));
    CHECK(source.at("evidence").at("workTotal").as_number() == 1);
    CHECK(source.dump().find(work_id) != std::string::npos && source.dump().find(foreign) == std::string::npos);
    auto reply = finish(*service, "alpha", service->mini_chat("alpha", "observations", "Real synthetic model question", "model-chat"));
    CHECK(str(reply, "status") == "completed" && models.calls == 2);
    const auto later_space = service->space("alpha");
    CHECK(mini(later_space, "observations").at("findings").as_array().back().at("source").at("jobId").as_string() == str(analysis, "id"));
    CHECK(!mini(service->space("beta"), "observations").at("thinkWithModel").as_bool());
    CHECK(!mini(later_space, "planning").at("thinkWithModel").as_bool());
    { std::lock_guard held(models.mutex);
      for (const auto& message : models.records.back()) CHECK(message.content.find("该角色的模型推理已关闭") == std::string::npos); }
    service.reset(); service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks(12000));
    CHECK(mini(service->space("alpha"), "observations").at("thinkWithModel").as_bool());
    CHECK(service->mini_history("alpha", "observations").at("turns").as_array().size() == 2);
    models.gate(); const auto held = service->mini_chat("alpha", "observations", "Pending chat", "held"); until([&] { return models.entered.load(); });
    const auto calls = models.calls.load();
    CHECK(!service->set_thinking("alpha", "observations", false, "disable").at("thinkWithModel").as_bool());
    CHECK(str(finish(*service, "alpha", held), "status") == "cancelled");
    CHECK(!service->mini_chat("alpha", "observations", "Disabled again", "disabled-again").at("calledModel").as_bool() && models.calls == calls);
    CHECK(store.conversation_snapshot("alpha").fingerprint == history && store.list_memories("alpha").empty());
    CHECK(str(work.brief_json(work_id), "status") == "queued" && work.bot_status("alpha").at("total").as_number() == 1);
    for (int i = 0; i < 51; ++i) (void)service->mini_chat("alpha", "planning", "Local pagination", "page" + std::to_string(i));
    const auto page = service->mini_history("alpha", "planning"); CHECK(page.at("turns").as_array().size() == 50 && page.at("hasMore").as_bool());
    CHECK(service->mini_history("alpha", "planning", str(page, "before")).at("turns").as_array().size() == 1);
    rejected([&] { (void)service->mini_history("beta", "planning", str(page, "before")); });
}
void long_paths(const fs::path& root) {
    Store store(root / "data.sqlite"); seed(store, 25);
    RunService work(root / "work", work_callbacks(), work_options()); Models models;
    auto service_root = root;
    while (fs::absolute(service_root).wstring().size() <= 280) service_root /= std::string(80, 'p');
    service_root /= "service";
    CHECK(fs::absolute(service_root).wstring().size() > 260);
    auto service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks(12000));
    auto summary = finish(*service, "alpha", service->summarize("alpha", "deep-summary"));
    CHECK(str(summary, "status") == "completed" && summary.at("compacted").as_bool());
    const auto source = service->source("alpha", str(summary, "id"));
    service.reset(); service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks(12000));
    CHECK(service->source("alpha", str(summary, "id")) == source);
    CHECK(str(service->summarize("alpha", "deep-summary"), "summaryMessageId") == str(summary, "summaryMessageId"));
    const auto analysis = finish(*service, "alpha", service->set_thinking("alpha", "planning", true, "deep-enable").at("job"));
    CHECK(str(analysis, "status") == "completed");
    service.reset(); service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks(12000));
    CHECK(mini(service->space("alpha"), "planning").at("thinkWithModel").as_bool());
    CHECK(str(service->job("alpha", str(analysis, "id")), "status") == "completed");
    CHECK(store.conversation_statistics("alpha").messages == 26 && work.bot_status("alpha").at("total").as_number() == 0);
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::absolute(fs::path(argv[1])) / ("c-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root); statistics(root / "stats"); summary_jobs(root / "summary"); mini_jobs(root / "mini"); long_paths(root / "long");
        std::cout << "conversation_services: " << checks << " checks passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
