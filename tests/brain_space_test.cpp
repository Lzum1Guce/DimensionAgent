#include "dimension/conversation_services.hpp"
#include "dimension/message_context.hpp"

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
template<class F> void until(F ready) {
    const auto end = std::chrono::steady_clock::now() + 8s;
    while (!ready()) {
        if (std::chrono::steady_clock::now() > end) throw std::runtime_error("Synthetic space job timed out");
        std::this_thread::sleep_for(2ms);
    }
}
std::string str(const Json& value, const char* key) {
    const auto* field = value.find(key); return field && field->is_string() ? field->as_string() : "";
}
double number(const Json& value, const char* key) {
    const auto* field = value.find(key); return field && field->is_number() ? field->as_number() : 0;
}
bool flag(const Json& value, const char* key) {
    const auto* field = value.find(key); return field && field->is_bool() && field->as_bool();
}
RunCallbacks work_callbacks() {
    RunCallbacks cb; cb.configuration = [](const auto&) { return ModelConfig{}; };
    cb.model = [](const auto&, const auto&, const auto&, auto, auto) { return ModelReply{"Synthetic Work", {}, 1, 1}; };
    return cb;
}
struct Models {
    std::atomic<int> calls{0}, mode{0}; // 0 success, 1 gate, 2 provider error, 3 malformed JSON.
    std::atomic<bool> entered{false}, release{false}, no_tools{true};
    std::mutex mutex;
    std::vector<std::vector<ModelMessage>> records;
    ConversationServiceCallbacks callbacks() {
        ConversationServiceCallbacks cb;
        cb.configuration = [](const auto&, const auto&) { return ModelConfig{}; };
        cb.input_budget = [](const auto&, const auto&) { return std::size_t{24000}; };
        cb.model = [this](const ModelConfig&, const std::vector<ModelMessage>& messages,
            const std::vector<ModelTool>& tools, ModelChunk, std::stop_token stop) {
            ++calls; no_tools = no_tools && tools.empty();
            { std::lock_guard lock(mutex); records.push_back(messages); }
            const auto action = mode.load(); entered = true;
            if (action == 1) {
                until([&] { return release.load() || stop.stop_requested(); });
                if (stop.stop_requested()) throw std::runtime_error("Synthetic cancelled space request");
            }
            if (action == 2) throw std::runtime_error("Synthetic space provider failure");
            if (action == 3) return ModelReply{"not-json", {}, 10, 10};
            if (messages.front().content.starts_with("dimension-combined-space-v1")) {
                const auto answer = Json(O{{"summary", "Combined verified summary"}, {"openQuestions", A{"Need user confirmation"}},
                    {"modules", A{
                        O{{"id", "observations"}, {"kind", "fact"}, {"summary", "Observed private reply"}},
                        O{{"id", "planning"}, {"kind", "suggestion"}, {"summary", "Offer next step"}}
                    }}}).dump();
                return ModelReply{answer, {}, 10, 10};
            }
            return ModelReply{"Synthetic mini analysis", {}, 10, 10};
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
    throw std::runtime_error("Missing space module");
}
bool has_space_file(const fs::path& root) {
    if (!fs::exists(root)) return false;
    for (const auto& entry : fs::recursive_directory_iterator(root)) if (entry.path().filename() == "brain-space.json") return true;
    return false;
}
void combined_rounds(const fs::path& root) {
    Store store(root / "data.sqlite");
    (void)store.create_bot("Alpha", "Synthetic persona", "alpha");
    (void)store.create_bot("Beta", "Synthetic persona", "beta");
    (void)store.append_message("alpha", Mode::Chat, "user", "Private question");
    const auto first = store.append_message("alpha", Mode::Chat, "bot", "First private reply");
    (void)store.append_message("beta", Mode::Chat, "bot", "FOREIGN_PRIVATE_CONTENT");
    RunService work(root / "work", work_callbacks(), [] { RunOptions o; o.start_paused = true; o.require_verified_finish = false; return o; }());
    Models models;
    const auto service_root = root / "service";
    auto service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks());
    const auto local = service->on_delivery("alpha", first.id);
    CHECK(local.at("terminal").as_bool() && !local.at("calledModel").as_bool() && models.calls == 0);
    CHECK(has_space_file(service_root / "spaces"));
    auto space = service->space("alpha");
    CHECK(space.at("minibots").as_array().size() == 13 && str(space, "pipeline") == "combined");
    CHECK(str(mini(space, "observations"), "name") == "感知" && str(mini(space, "planning"), "name") == "筹划");
    CHECK(space.at("maxAuxiliaryModelCalls").as_number() == 1 && str(space, "storage") == "brain-space.json");
    CHECK(str(space.at("latestRound"), "sourceMessageId") == std::to_string(first.id));
    CHECK(service->chat_guidance("alpha").empty());
    const auto observations_job = service->set_thinking("alpha", "observations", true, "enable-observations").at("job");
    const auto planning_job = service->set_thinking("alpha", "planning", true, "enable-planning").at("job");
    (void)finish(*service, "alpha", observations_job); (void)finish(*service, "alpha", planning_job);
    models.calls = 0;
    const auto second = store.append_message("alpha", Mode::Chat, "bot", "PRIVATE_SPACE_EVIDENCE");
    const auto pending = service->on_delivery("alpha", second.id);
    const auto combined = finish(*service, "alpha", pending);
    CHECK(str(combined, "status") == "completed" && combined.at("modelCalls").as_number() == 1 && models.calls == 1 && models.no_tools);
    const auto repeated = service->analyze_latest("alpha", "manual-repeat");
    CHECK(str(repeated, "id") == str(combined, "id") && models.calls == 1);
    space = service->space("alpha");
    CHECK(str(space.at("latestRound"), "summary") == "Combined verified summary");
    CHECK(str(space.at("latestRound"), "sourceMessageId") == std::to_string(second.id));
    CHECK(str(mini(space, "observations"), "analysisStatus") == "completed" && mini(space, "observations").at("calledModel").as_bool());
    CHECK(str(mini(space, "planning"), "analysisStatus") == "completed");
    CHECK(str(mini(space, "memory"), "analysisStatus") == "disabled" && !mini(space, "memory").at("calledModel").as_bool());
    CHECK(service->chat_guidance("alpha").find("Combined verified summary") != std::string::npos);
    { std::lock_guard lock(models.mutex);
        CHECK(!models.records.empty());
        const auto payload = models.records.back().back().content;
        CHECK(payload.find("PRIVATE_SPACE_EVIDENCE") != std::string::npos && payload.find("FOREIGN_PRIVATE_CONTENT") == std::string::npos);
    }
    const auto calls_before_reads = models.calls.load();
    (void)service->space("alpha"); (void)service->space("alpha");
    CHECK(models.calls == calls_before_reads);
    service.reset(); service = std::make_unique<ConversationServices>(service_root, store, work, models.callbacks());
    CHECK(str(service->space("alpha").at("latestRound"), "summary") == "Combined verified summary" && models.calls == calls_before_reads);

    const auto third = store.append_message("alpha", Mode::Chat, "bot", "Newest private reply");
    models.mode = 1; models.entered = false; models.release = false;
    const auto old_round = service->on_delivery("alpha", third.id);
    until([&] { return models.entered.load(); });
    const auto fourth = store.append_message("alpha", Mode::Chat, "bot", "Replacement private reply");
    models.mode = 0;
    const auto new_round = service->on_delivery("alpha", fourth.id);
    const auto fresh = finish(*service, "alpha", new_round);
    CHECK(str(fresh, "status") == "completed" && str(fresh, "sourceMessageId") == std::to_string(fourth.id));
    CHECK(str(service->job("alpha", str(old_round, "id")), "status") == "cancelled");
    CHECK(str(service->space("alpha").at("latestRound"), "sourceMessageId") == std::to_string(fourth.id));

    const auto fifth = store.append_message("alpha", Mode::Chat, "bot", "Malformed analysis input");
    models.mode = 3;
    const auto malformed = finish(*service, "alpha", service->on_delivery("alpha", fifth.id));
    CHECK(str(malformed, "status") == "failed");
    CHECK(str(service->space("alpha").at("latestRound"), "sourceMessageId") == std::to_string(fourth.id));
    CHECK(service->chat_guidance("alpha").find("Combined verified summary") != std::string::npos);
    CHECK(store.list_memories("alpha").empty());
    CHECK(service->space("beta").at("latestRound").is_null());
    CHECK(service->chat_guidance("beta").empty());
    CHECK(store.delete_chat_message("alpha", "", fourth.id));
    CHECK(service->chat_guidance("alpha").empty());
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass an isolated synthetic output directory");
        const auto root = fs::path(argv[1]) / ("space-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        fs::create_directories(root); combined_rounds(root);
        std::cout << "brain_space: " << checks << " checks passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
